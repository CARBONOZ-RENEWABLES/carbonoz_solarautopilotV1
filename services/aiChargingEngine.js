const tibberService = require('./tibberService');
const influxAIService = require('./influxAIService');

class AIChargingEngine {
  constructor() {
    this.enabled = false;
    this.lastDecision = null;
    this.evaluationInterval = null;
    this.mqttClient = null;
    this.currentSystemState = null;
    
    this.config = {
      inverterNumber: 1,
      mqttTopicPrefix: 'solar',
      inverterTypes: {}
    };
  }

  initialize(mqttClient, currentSystemState, config = {}) {
    this.mqttClient = mqttClient;
    this.currentSystemState = currentSystemState;
    
    if (config.inverterNumber) this.config.inverterNumber = config.inverterNumber;
    if (config.mqttTopicPrefix) this.config.mqttTopicPrefix = config.mqttTopicPrefix;
    if (config.inverterTypes) this.config.inverterTypes = config.inverterTypes;
    
    console.log('✅ AI Charging Engine initialized (Solar-First Strategy)');
    console.log(`   • Inverters: ${this.config.inverterNumber}`);
    console.log(`   • MQTT Prefix: ${this.config.mqttTopicPrefix}`);
    console.log(`   • Strategy: Maximize solar usage, minimal grid charging`);
  }

  updateSystemState(systemState) {
    this.currentSystemState = systemState;
  }

  updateConfig(config) {
    if (config.inverterNumber) this.config.inverterNumber = config.inverterNumber;
    if (config.mqttTopicPrefix) this.config.mqttTopicPrefix = config.mqttTopicPrefix;
    if (config.inverterTypes) this.config.inverterTypes = config.inverterTypes;
  }

  async logCommand(topic, value, success = true) {
    const command = {
      timestamp: new Date().toISOString(),
      topic: topic,
      value: value,
      success: success,
      source: 'AI_ENGINE'
    };
    
    await influxAIService.saveCommand(topic, value, success);
    return command;
  }

  async logDecision(decision, reasons) {
    const systemState = {
      battery_soc: this.currentSystemState?.battery_soc,
      pv_power: this.currentSystemState?.pv_power,
      load: this.currentSystemState?.load,
      grid_power: this.currentSystemState?.grid_power,
      grid_voltage: this.currentSystemState?.grid_voltage
    };

    const tibberData = {
      currentPrice: tibberService.cache.currentPrice?.total,
      priceLevel: tibberService.cache.currentPrice?.level,
      averagePrice: tibberService.calculateAveragePrice()
    };

    const entry = {
      timestamp: new Date().toISOString(),
      decision: decision,
      reasons: reasons,
      systemState: systemState,
      tibberData: tibberData
    };

    this.lastDecision = entry;
    await influxAIService.saveDecision(decision, reasons, systemState, tibberData);

    console.log(`🤖 AI Decision: ${decision}`);
    console.log(`   Reasons: ${reasons.join(', ')}`);
    
    return entry;
  }

  async evaluate() {
    try {
      const tibberStatus = tibberService.getStatus();
      
      if (!this.enabled) {
        return { decision: 'IDLE', reasons: ['AI charging engine is disabled'] };
      }

      if (!tibberStatus.enabled || !tibberStatus.configured) {
        return { 
          decision: 'IDLE', 
          reasons: ['Tibber integration not configured'] 
        };
      }

      const reasons = [];
      let shouldCharge = false;
      let shouldStop = false;

      const batterySOC = this.currentSystemState?.battery_soc || 0;
      const pvPower = this.currentSystemState?.pv_power || 0;
      const load = this.currentSystemState?.load || 0;
      const gridPower = this.currentSystemState?.grid_power || 0;
      const gridVoltage = this.currentSystemState?.grid_voltage || 0;

      const currentPrice = tibberService.cache.currentPrice;
      const avgPrice = tibberService.calculateAveragePrice();
      const priceIsGood = tibberService.isPriceGood();
      const config = tibberService.config;

      // CRITICAL: Stop charging if battery >= target
      if (batterySOC >= config.targetSoC) {
        shouldStop = true;
        reasons.push(`Battery at target SOC: ${batterySOC}%`);
      }

      // Grid voltage check
      if (gridVoltage < 200 || gridVoltage > 250) {
        shouldStop = true;
        reasons.push(`Grid voltage unstable: ${gridVoltage}V`);
      }

      // SOLAR PRIORITY: Check for PV surplus
      const pvSurplus = pvPower - load;
      
      // ONLY charge from grid in specific conditions
      if (batterySOC < config.targetSoC && !shouldStop) {
        // Condition 1: Negative prices (getting paid)
        if (currentPrice && currentPrice.total < 0) {
          shouldCharge = true;
          reasons.push(`NEGATIVE PRICE! Getting paid: ${currentPrice.total.toFixed(2)} €`);
        }
        // Condition 2: Very cheap + nighttime + low battery
        else if (priceIsGood && batterySOC < 30 && pvPower < 100) {
          const hour = new Date().getHours();
          if (hour >= 22 || hour <= 6) {
            shouldCharge = true;
            reasons.push(`Night charging: SOC low (${batterySOC}%), cheap price (${currentPrice?.level})`);
          }
        }
        // Condition 3: Emergency low battery
        else if (batterySOC < 15 && pvPower < 100) {
          shouldCharge = true;
          reasons.push(`Emergency charging: Battery critically low (${batterySOC}%)`);
        }
      }

      // Make decision
      let decision = this.makeDescriptiveDecision(
        batterySOC, pvPower, load, currentPrice, avgPrice, 
        gridVoltage, config, shouldCharge, shouldStop, reasons
      );

      // Apply decision
      if (decision.includes('CHARGE') || decision.includes('STOP')) {
        const actionDecision = decision.includes('STOP') ? 'STOP_CHARGING' : 'START_CHARGING';
        this.applyDecision(actionDecision);
      }

      return await this.logDecision(decision, reasons);
    } catch (error) {
      console.error('❌ Error in AI evaluation:', error);
      return {
        decision: 'ERROR',
        reasons: [error.message]
      };
    }
  }

  makeDescriptiveDecision(batterySOC, pvPower, load, currentPrice, avgPrice, gridVoltage, config, shouldCharge, shouldStop, reasons) {
    const pvSurplus = pvPower - load;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;
    const hour = new Date().getHours();
    const isNight = hour >= 22 || hour <= 6;
    
    // STOP scenarios
    if (shouldStop) {
      if (batterySOC >= config.targetSoC) {
        return `STOP CHARGING - Battery full at ${batterySOC}% (maximize solar export)`;
      }
      if (gridVoltage < 200 || gridVoltage > 250) {
        return `STOP CHARGING - Grid voltage unstable (${gridVoltage}V)`;
      }
      return 'STOP CHARGING - Safety conditions';
    }
    
    // CHARGING scenarios (VERY LIMITED)
    if (shouldCharge) {
      // Negative prices
      if (priceIsNegative) {
        return `CHARGE WITH GRID - NEGATIVE PRICE! Getting paid ${Math.abs(currentPrice.total).toFixed(2)}€/kWh`;
      }
      
      // Night charging with low battery
      if (isNight && batterySOC < 30) {
        return `CHARGE WITH GRID - Night charging, low SOC (${batterySOC}%), ${currentPrice?.level || 'cheap'} price`;
      }
      
      // Emergency
      if (batterySOC < 15) {
        return `CHARGE WITH GRID - Emergency: Battery critically low (${batterySOC}%)`;
      }
      
      return `CHARGE WITH GRID - Optimal conditions (SOC: ${batterySOC}%)`;
    }
    
    // NORMAL operations (Solar priority)
    if (pvSurplus > 1000 && batterySOC < 95) {
      return `CHARGE WITH SOLAR - Surplus ${pvSurplus.toFixed(0)}W available (PV: ${pvPower.toFixed(0)}W, Load: ${load.toFixed(0)}W)`;
    }
    
    if (batterySOC >= config.targetSoC && pvPower > load) {
      return `SOLAR EXPORT MODE - Battery full (${batterySOC}%), exporting ${pvSurplus.toFixed(0)}W surplus`;
    }
    
    if (pvPower > load * 0.8 && batterySOC > 30) {
      return `USE SOLAR+BATTERY - PV covering ${((pvPower/load)*100).toFixed(0)}% of load, SOC: ${batterySOC}%`;
    }
    
    if (batterySOC > 50) {
      return `USE BATTERY - Avoiding grid usage, battery at ${batterySOC}%, PV: ${pvPower.toFixed(0)}W`;
    }
    
    if (batterySOC < 20) {
      return `USE GRID - Low battery (${batterySOC}%), waiting for solar generation`;
    }
    
    if (pvPower > 100) {
      return `USE SOLAR - PV generating ${pvPower.toFixed(0)}W, Load: ${load.toFixed(0)}W, SOC: ${batterySOC}%`;
    }
    
    return `MONITOR - Stable (SOC: ${batterySOC}%, PV: ${pvPower.toFixed(0)}W, Load: ${load.toFixed(0)}W)`;
  }

  async analyzeHistoricalPattern() {
    const now = new Date();
    const currentHour = now.getHours();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    try {
      const relevantDecisions = await influxAIService.getDecisionsByTimeRange(oneWeekAgo, now);
      
      const sameHourDecisions = relevantDecisions.filter(d => {
        const decisionDate = new Date(d.timestamp);
        const decisionHour = decisionDate.getHours();
        return decisionHour === currentHour;
      });

      if (sameHourDecisions.length < 3) {
        return { isTypicallyCheap: false, confidence: 0 };
      }

      const cheapCount = sameHourDecisions.filter(d => 
        d.tibberData?.priceLevel === 'VERY_CHEAP' || 
        d.tibberData?.priceLevel === 'CHEAP'
      ).length;

      const ratio = cheapCount / sameHourDecisions.length;
      
      return {
        isTypicallyCheap: ratio > 0.6,
        confidence: ratio,
        sampleSize: sameHourDecisions.length
      };
    } catch (error) {
      console.error('Error analyzing historical pattern:', error);
      return { isTypicallyCheap: false, confidence: 0 };
    }
  }

  applyDecision(decision) {
    if (!this.mqttClient || !this.mqttClient.connected) {
      console.error('❌ MQTT client not connected');
      return false;
    }

    if (!global.learnerModeActive) {
      console.log('⚠️ AI decision not applied: Learner mode is inactive');
      return false;
    }

    try {
      const enableCharging = decision.includes('START_CHARGING') || decision.includes('CHARGE WITH');
      const inverterNumber = this.config.inverterNumber;
      const mqttTopicPrefix = this.config.mqttTopicPrefix;
      
      let commandsSent = 0;
      
      console.log(`🤖 AI Charging: Processing ${enableCharging ? 'enable' : 'disable'} command for ${inverterNumber} inverter(s)`);
      
      for (let i = 1; i <= inverterNumber; i++) {
        const inverterId = `inverter_${i}`;
        const inverterType = this.getInverterType(inverterId);
        
        if (inverterType === 'new' || inverterType === 'hybrid') {
          const settings = this.getOptimalChargingSettings(enableCharging);
          
          const chargerTopic = `${mqttTopicPrefix}/${inverterId}/charger_source_priority/set`;
          this.mqttClient.publish(chargerTopic, settings.chargerPriority, { qos: 1, retain: false }, async (err) => {
            if (!err) {
              await this.logCommand(chargerTopic, settings.chargerPriority, true);
              commandsSent++;
            } else {
              console.error(`❌ Error: ${err.message}`);
              await this.logCommand(chargerTopic, settings.chargerPriority, false);
            }
          });
          
          const outputTopic = `${mqttTopicPrefix}/${inverterId}/output_source_priority/set`;
          this.mqttClient.publish(outputTopic, settings.outputPriority, { qos: 1, retain: false }, async (err) => {
            if (!err) {
              await this.logCommand(outputTopic, settings.outputPriority, true);
              commandsSent++;
            } else {
              console.error(`❌ Error: ${err.message}`);
              await this.logCommand(outputTopic, settings.outputPriority, false);
            }
          });
          
          console.log(`🧠 AI: Charger="${settings.chargerPriority}", Output="${settings.outputPriority}" (${settings.reason})`);
        } else {
          const commandValue = enableCharging ? 'Enabled' : 'Disabled';
          const topic = `${mqttTopicPrefix}/${inverterId}/grid_charge/set`;
          
          this.mqttClient.publish(topic, commandValue, { qos: 1, retain: false }, async (err) => {
            if (!err) {
              await this.logCommand(topic, commandValue, true);
              commandsSent++;
            } else {
              console.error(`❌ Error: ${err.message}`);
              await this.logCommand(topic, commandValue, false);
            }
          });
          
          console.log(`🔄 AI: Legacy grid_charge="${commandValue}" for ${inverterId}`);
        }
      }
      
      return commandsSent > 0;
    } catch (error) {
      console.error('❌ Error applying AI decision:', error);
      return false;
    }
  }

  getInverterType(inverterId) {
    try {
      if (this.config.inverterTypes && this.config.inverterTypes[inverterId]) {
        return this.config.inverterTypes[inverterId].type || 'legacy';
      }
      
      if (global.inverterTypes && global.inverterTypes[inverterId]) {
        return global.inverterTypes[inverterId].type || 'legacy';
      }
      
      return 'legacy';
    } catch (error) {
      console.error(`Error getting inverter type for ${inverterId}:`, error);
      return 'legacy';
    }
  }

  getOptimalChargingSettings(enableCharging) {
    const batterySOC = this.currentSystemState?.battery_soc || 0;
    const pvPower = this.currentSystemState?.pv_power || 0;
    const load = this.currentSystemState?.load || 0;
    const gridVoltage = this.currentSystemState?.grid_voltage || 0;
    const currentPrice = tibberService.cache.currentPrice;
    const avgPrice = tibberService.calculateAveragePrice();
    const config = tibberService.config;
    
    const pvAvailable = pvPower > 100;
    const pvSurplus = pvPower - load;
    const priceNegative = currentPrice ? currentPrice.total < 0 : false;
    const gridUnstable = gridVoltage < 200 || gridVoltage > 250;
    const socAtTarget = batterySOC >= (config?.targetSoC || 80);
    const hour = new Date().getHours();
    const isNight = hour >= 22 || hour <= 6;
    
    let chargerPriority = 'Solar first';
    let outputPriority = 'Solar/Battery/Utility';
    let reason = '';
    
    // CRITICAL FIX: Battery full - NEVER charge, allow solar export
    if (socAtTarget) {
      chargerPriority = 'Solar only';  // Changed from 'Solar first'
      outputPriority = 'Solar first';   // Changed to allow export
      reason = 'Battery full - solar export enabled';
    }
    // Grid unstable
    else if (gridUnstable) {
      chargerPriority = 'Solar only';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'Grid unstable - solar only';
    }
    // Charging disabled
    else if (!enableCharging) {
      chargerPriority = 'Solar only';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'Charging disabled - solar priority';
    }
    // NEGATIVE PRICES - charge aggressively
    else if (priceNegative) {
      chargerPriority = 'Utility first';
      outputPriority = 'Solar/Utility/Battery';
      reason = 'NEGATIVE price - getting paid';
    }
    // Night charging with low battery
    else if (isNight && batterySOC < 30 && !pvAvailable) {
      chargerPriority = 'Solar and utility simultaneously';
      outputPriority = 'Solar/Utility/Battery';
      reason = 'Night charging - low battery';
    }
    // Emergency low battery
    else if (batterySOC < 15) {
      chargerPriority = 'Solar and utility simultaneously';
      outputPriority = 'Solar/Utility/Battery';
      reason = 'Emergency - critically low battery';
    }
    // Strong solar surplus - use it!
    else if (pvSurplus > 1000 && batterySOC < 90) {
      chargerPriority = 'Solar only';
      outputPriority = 'Solar first';
      reason = 'Strong solar surplus - solar charging';
    }
    // Normal solar available
    else if (pvAvailable && batterySOC < 90) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'Solar available - solar priority';
    }
    // Default: Solar only (no grid charging unless specific conditions)
    else {
      chargerPriority = 'Solar only';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'Default - solar only mode';
    }
    
    return { chargerPriority, outputPriority, reason };
  }

  start() {
    if (this.evaluationInterval) {
      console.log('⚠️ AI Charging Engine already running');
      return;
    }

    this.enabled = true;
    this.evaluate();

    this.evaluationInterval = setInterval(() => {
      this.evaluate();
    }, 5 * 60 * 1000);

    console.log('✅ AI Charging Engine started (evaluating every 5 minutes)');
  }

  stop() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
    this.enabled = false;
    console.log('⏸️ AI Charging Engine stopped');
  }

  getStatus() {
    const tibberStatus = tibberService.getStatus();
    return {
      enabled: this.enabled,
      running: !!this.evaluationInterval,
      config: {
        inverterNumber: this.config.inverterNumber,
        mqttTopicPrefix: this.config.mqttTopicPrefix
      },
      lastDecision: this.lastDecision ? {
        timestamp: this.lastDecision.timestamp,
        decision: this.lastDecision.decision,
        reasons: this.lastDecision.reasons
      } : null,
      decisionCount: 'Available in InfluxDB',
      tibberStatus: {
        enabled: tibberStatus.enabled,
        configured: tibberStatus.configured,
        lastUpdate: tibberStatus.lastUpdate
      }
    };
  }

  async getDecisionHistory(limit = 50) {
    return await influxAIService.getDecisionHistory(limit);
  }

  async getCommandHistory(limit = 50) {
    return await influxAIService.getCommandHistory(limit);
  }

  getPredictedChargeWindows() {
    const cheapestHours = tibberService.getCheapestHours(6, 24);
    const config = tibberService.config;
    const batterySOC = this.currentSystemState?.battery_soc || 0;

    return cheapestHours.map(hour => ({
      time: hour.time,
      price: hour.price,
      level: hour.level,
      recommended: batterySOC < config.targetSoC,
      reason: `Cheap price: ${hour.price.toFixed(2)} (${hour.level})`
    }));
  }
}

module.exports = new AIChargingEngine();