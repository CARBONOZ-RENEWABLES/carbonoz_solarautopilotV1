const tibberService = require('./tibberService');
const influxAIService = require('./influxAIService');

class AIChargingEngine {
  constructor() {
    this.enabled = false;
    this.lastDecision = null;
    this.evaluationInterval = null;
    this.mqttClient = null;
    this.currentSystemState = null;
    
    // Store configuration from server
    this.config = {
      inverterNumber: 1,
      mqttTopicPrefix: 'solar',
      inverterTypes: {}
    };
  }

  initialize(mqttClient, currentSystemState, config = {}) {
    this.mqttClient = mqttClient;
    this.currentSystemState = currentSystemState;
    
    // Store configuration
    if (config.inverterNumber) this.config.inverterNumber = config.inverterNumber;
    if (config.mqttTopicPrefix) this.config.mqttTopicPrefix = config.mqttTopicPrefix;
    if (config.inverterTypes) this.config.inverterTypes = config.inverterTypes;
    
    console.log('✅ AI Charging Engine initialized (Germany-optimized)');
    console.log(`   • Inverters: ${this.config.inverterNumber}`);
    console.log(`   • MQTT Prefix: ${this.config.mqttTopicPrefix}`);
    console.log(`   • Emergency charging: DISABLED (reliable grid)`);
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

      // Get current system state
      const batterySOC = this.currentSystemState?.battery_soc || 0;
      const pvPower = this.currentSystemState?.pv_power || 0;
      const load = this.currentSystemState?.load || 0;
      const gridPower = this.currentSystemState?.grid_power || 0;
      const gridVoltage = this.currentSystemState?.grid_voltage || 0;

      // Get Tibber data
      const currentPrice = tibberService.cache.currentPrice;
      const avgPrice = tibberService.calculateAveragePrice();
      const priceIsGood = tibberService.isPriceGood();
      const config = tibberService.config;

      // Check grid voltage stability
      if (gridVoltage < 200 || gridVoltage > 250) {
        shouldStop = true;
        reasons.push(`Grid voltage unstable: ${gridVoltage}V`);
      }

      // Check if battery is full
      if (batterySOC >= config.targetSoC) {
        shouldStop = true;
        reasons.push(`Battery SOC at target: ${batterySOC}%`);
      }

      // PV is generating surplus - charge from solar only
      if (pvPower > load) {
        const surplus = pvPower - load;
        if (surplus > 1000 && batterySOC < config.targetSoC) {
          shouldCharge = true;
          reasons.push(`PV surplus available: ${surplus}W`);
        }
      }

      // Price-based charging logic (main strategy for Germany)
      if (currentPrice && avgPrice !== null && batterySOC < config.targetSoC) {
        if (priceIsGood && gridVoltage >= 200 && gridVoltage <= 250) {
          shouldCharge = true;
          reasons.push(
            `Good price: ${currentPrice.total.toFixed(2)} € ` +
            `(avg: ${avgPrice.toFixed(2)}, level: ${currentPrice.level})`
          );
        } else if (currentPrice.total > avgPrice * 1.2) {
          shouldStop = true;
          reasons.push(
            `Price too high: ${currentPrice.total.toFixed(2)} € ` +
            `(20% above avg: ${avgPrice.toFixed(2)})`
          );
        }
      }

      // Learning from history: Check if this time of day is typically cheap
      const historicalPattern = await this.analyzeHistoricalPattern();
      if (historicalPattern.isTypicallyCheap && batterySOC < config.targetSoC) {
        shouldCharge = true;
        reasons.push(`Historical pattern suggests cheap prices now`);
      }

      // Negative price handling (common in Germany with high renewables)
      if (currentPrice && currentPrice.total < 0 && batterySOC < 95) {
        shouldCharge = true;
        reasons.push(`NEGATIVE PRICE! Getting paid to charge: ${currentPrice.total.toFixed(2)} €`);
      }

      // Make descriptive decision based on conditions
      let decision = this.makeDescriptiveDecision(
        batterySOC, pvPower, load, currentPrice, avgPrice, 
        gridVoltage, config, shouldCharge, shouldStop, reasons
      );

      // Apply decision via MQTT
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
    const priceIsGood = currentPrice && avgPrice ? currentPrice.total < avgPrice * 0.9 : false;
    const priceIsHigh = currentPrice && avgPrice ? currentPrice.total > avgPrice * 1.2 : false;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;
    
    // Stop charging scenarios
    if (shouldStop) {
      if (batterySOC >= config.targetSoC) {
        return `STOP CHARGING - Battery full at ${batterySOC}%`;
      }
      if (gridVoltage < 200 || gridVoltage > 250) {
        return `STOP CHARGING - Grid voltage unstable (${gridVoltage}V)`;
      }
      if (priceIsHigh) {
        return `STOP CHARGING - Price too high (${currentPrice.total.toFixed(2)}€ vs avg ${avgPrice.toFixed(2)}€)`;
      }
      return 'STOP CHARGING - Safety conditions triggered';
    }
    
    // Charging scenarios
    if (shouldCharge) {
      // Negative prices - charge aggressively!
      if (priceIsNegative) {
        return `CHARGE WITH GRID - NEGATIVE PRICE! Getting paid ${Math.abs(currentPrice.total).toFixed(2)}€/kWh`;
      }
      
      // Large PV surplus
      if (pvSurplus > 1000) {
        return `CHARGE WITH SOLAR - Surplus ${pvSurplus}W available (PV: ${pvPower}W, Load: ${load}W)`;
      }
      
      // Good price with little/no solar
      if (priceIsGood && pvPower < 500) {
        return `CHARGE WITH GRID - Cheap price ${currentPrice.total.toFixed(2)}€ (${currentPrice.level})`;
      }
      
      // Good price with some solar
      if (priceIsGood && pvSurplus > 0) {
        return `CHARGE WITH SOLAR+GRID - Cheap price + PV surplus (${pvSurplus}W)`;
      }
      
      return `CHARGE WITH GRID - Good conditions (SOC: ${batterySOC}%)`;
    }
    
    // No action scenarios - rely on grid when needed
    if (pvPower > load * 0.8 && batterySOC > 30) {
      return `USE BATTERY - PV covering ${((pvPower/load)*100).toFixed(0)}% of load, battery at ${batterySOC}%`;
    }
    
    if (batterySOC > 50 && priceIsHigh) {
      return `USE BATTERY - Avoiding expensive grid (${currentPrice?.total.toFixed(2)}€), battery at ${batterySOC}%`;
    }
    
    if (batterySOC < 20 && priceIsHigh) {
      return `USE GRID - Low battery (${batterySOC}%) but price too high to charge, grid is reliable`;
    }
    
    if (pvPower > load * 0.5) {
      return `USE SOLAR+BATTERY - PV covering ${((pvPower/load)*100).toFixed(0)}% of load (${pvPower}W/${load}W)`;
    }
    
    return `MONITOR - Stable conditions (SOC: ${batterySOC}%, PV: ${pvPower}W, Load: ${load}W)`;
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
      console.error('❌ MQTT client not connected, cannot apply decision');
      return false;
    }

    // Check if learner mode is active
    if (!global.learnerModeActive) {
      console.log('⚠️  AI decision not applied: Learner mode is inactive');
      return false;
    }

    try {
      const enableCharging = decision.includes('START_CHARGING') || decision.includes('CHARGE WITH');
      const commandValue = enableCharging ? 'Enabled' : 'Disabled';
      
      // Use stored config values
      const inverterNumber = this.config.inverterNumber;
      const mqttTopicPrefix = this.config.mqttTopicPrefix;
      
      let commandsSent = 0;
      let totalInverters = 0;
      
      console.log(`🤖 AI Charging: Processing ${enableCharging ? 'enable' : 'disable'} command for ${inverterNumber} inverter(s)`);
      console.log(`   • MQTT Prefix: ${mqttTopicPrefix}`);
      
      // Apply to each inverter with type-aware mapping
      for (let i = 1; i <= inverterNumber; i++) {
        const inverterId = `inverter_${i}`;
        const inverterType = this.getInverterType(inverterId);
        
        let topic, mqttValue;
        
        if (inverterType === 'new' || inverterType === 'hybrid') {
          // Use intelligent settings for new inverters
          const settings = this.getOptimalChargingSettings(enableCharging);
          
          // Send charger_source_priority command
          const chargerTopic = `${mqttTopicPrefix}/${inverterId}/charger_source_priority/set`;
          this.mqttClient.publish(chargerTopic, settings.chargerPriority, { qos: 1, retain: false }, async (err) => {
            if (!err) {
              await this.logCommand(chargerTopic, settings.chargerPriority, true);
              commandsSent++;
            } else {
              console.error(`❌ Error publishing to ${chargerTopic}:`, err.message);
              await this.logCommand(chargerTopic, settings.chargerPriority, false);
            }
          });
          
          // Send output_source_priority command
          const outputTopic = `${mqttTopicPrefix}/${inverterId}/output_source_priority/set`;
          this.mqttClient.publish(outputTopic, settings.outputPriority, { qos: 1, retain: false }, async (err) => {
            if (!err) {
              await this.logCommand(outputTopic, settings.outputPriority, true);
              commandsSent++;
            } else {
              console.error(`❌ Error publishing to ${outputTopic}:`, err.message);
              await this.logCommand(outputTopic, settings.outputPriority, false);
            }
          });
          
          console.log(`🧠 AI Charging: Charger="${settings.chargerPriority}", Output="${settings.outputPriority}" (${settings.reason}) for ${inverterId}`);
          totalInverters++;
          continue;
        } else {
          // Use legacy grid_charge for legacy inverters
          topic = `${mqttTopicPrefix}/${inverterId}/grid_charge/set`;
          mqttValue = commandValue;
          console.log(`🔄 AI Charging: Legacy grid_charge "${commandValue}" for ${inverterId}`);
        }
        
        // Only for legacy inverters
        if (inverterType === 'legacy' || inverterType === 'unknown') {
          this.mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, async (err) => {
            if (err) {
              console.error(`❌ Error publishing to ${topic}: ${err.message}`);
              await this.logCommand(topic, mqttValue, false);
            } else {
              commandsSent++;
              await this.logCommand(topic, mqttValue, true);
            }
          });
          totalInverters++;
        }
      }
      
      const action = enableCharging ? 'enabled' : 'disabled';
      console.log(`🤖 AI Charging: Grid charging ${action} for ${totalInverters} inverter(s) - Commands sent: ${commandsSent}`);
      
      return commandsSent > 0;
    } catch (error) {
      console.error('❌ Error applying AI decision:', error);
      return false;
    }
  }

  getInverterType(inverterId) {
    try {
      // First try stored config
      if (this.config.inverterTypes && this.config.inverterTypes[inverterId]) {
        return this.config.inverterTypes[inverterId].type || 'legacy';
      }
      
      // Fallback to global
      if (global.inverterTypes && global.inverterTypes[inverterId]) {
        return global.inverterTypes[inverterId].type || 'legacy';
      }
      
      return 'legacy'; // Default to legacy for safety
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
    const priceLow = currentPrice && avgPrice ? currentPrice.total < avgPrice * 0.8 : false;
    const priceVeryLow = currentPrice && avgPrice ? currentPrice.total < avgPrice * 0.5 : false;
    const priceNegative = currentPrice ? currentPrice.total < 0 : false;
    const priceHigh = currentPrice && avgPrice ? currentPrice.total > avgPrice * 1.2 : false;
    const gridUnstable = gridVoltage < 200 || gridVoltage > 250;
    const socAtTarget = batterySOC >= (config?.targetSoC || 80);
    
    let chargerPriority = 'Solar first';
    let outputPriority = 'Solar/Battery/Utility';
    let reason = '';
    
    // Stop charging conditions
    if (socAtTarget || gridUnstable) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';
      reason = socAtTarget ? 'SOC at target' : 'Grid unstable';
    }
    else if (!enableCharging) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'Charging disabled';
    }
    // NEGATIVE PRICES - charge aggressively!
    else if (priceNegative) {
      chargerPriority = 'Utility first';
      outputPriority = 'Utility first';
      reason = 'NEGATIVE price - getting paid!';
    }
    // Very cheap prices
    else if (priceVeryLow && !pvAvailable) {
      chargerPriority = 'Utility first';
      outputPriority = 'Utility first';
      reason = 'Very cheap grid, no PV';
    }
    // Strong solar surplus
    else if (pvPower > load * 2 && batterySOC < 90) {
      chargerPriority = 'Solar only';
      outputPriority = 'Solar first';
      reason = 'Strong solar surplus';
    }
    // No PV but cheap grid
    else if (!pvAvailable && priceLow) {
      chargerPriority = 'Utility first';
      outputPriority = 'Utility first';
      reason = 'No PV, cheap grid';
    }
    // No PV and expensive grid
    else if (!pvAvailable && priceHigh) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'No PV, expensive grid - rely on battery';
    }
    // PV available with cheap grid
    else if (pvAvailable && priceLow) {
      chargerPriority = 'Solar and utility simultaneously';
      outputPriority = 'Solar/Utility/Battery';
      reason = 'PV + cheap grid - fast charge';
    }
    // Mixed mode for medium SOC
    else if (pvAvailable && batterySOC < 60) {
      chargerPriority = 'Solar and utility simultaneously';
      outputPriority = 'Solar/Utility/Battery';
      reason = 'Mixed mode for charging';
    }
    // Default: Solar first
    else {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';
      reason = 'Default safe mode';
    }
    
    return { chargerPriority, outputPriority, reason };
  }

  start() {
    if (this.evaluationInterval) {
      console.log('⚠️  AI Charging Engine already running');
      return;
    }

    this.enabled = true;
    
    // Evaluate immediately
    this.evaluate();

    // Then evaluate every 5 minutes
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
    console.log('⏸️  AI Charging Engine stopped');
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
