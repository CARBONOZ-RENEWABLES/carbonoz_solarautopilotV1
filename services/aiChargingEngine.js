const tibberService = require('./tibberService');
const fs = require('fs');
const path = require('path');

class AIChargingEngine {
  constructor() {
    this.decisionsFile = path.join(__dirname, '../data/ai_decisions.json');
    this.commandsFile = path.join(__dirname, '../data/ai_commands.json');
    this.enabled = false;
    this.lastDecision = null;
    this.decisionHistory = this.loadDecisionHistory();
    this.commandHistory = this.loadCommandHistory();
    this.evaluationInterval = null;
    this.mqttClient = null;
    this.currentSystemState = null;
  }

  initialize(mqttClient, currentSystemState) {
    this.mqttClient = mqttClient;
    this.currentSystemState = currentSystemState;
    console.log('✅ AI Charging Engine initialized');
  }

  updateSystemState(systemState) {
    this.currentSystemState = systemState;
  }

  loadDecisionHistory() {
    try {
      if (fs.existsSync(this.decisionsFile)) {
        const data = JSON.parse(fs.readFileSync(this.decisionsFile, 'utf8'));
        // Keep only last 500 decisions
        return data.slice(-500);
      }
    } catch (error) {
      console.error('Error loading decision history:', error);
    }
    return [];
  }

  loadCommandHistory() {
    try {
      if (fs.existsSync(this.commandsFile)) {
        const data = JSON.parse(fs.readFileSync(this.commandsFile, 'utf8'));
        return data.slice(-100);
      }
    } catch (error) {
      console.error('Error loading command history:', error);
    }
    return [];
  }

  saveDecisionHistory() {
    try {
      fs.writeFileSync(
        this.decisionsFile,
        JSON.stringify(this.decisionHistory.slice(-500), null, 2)
      );
    } catch (error) {
      console.error('Error saving decision history:', error);
    }
  }

  saveCommandHistory() {
    try {
      fs.writeFileSync(
        this.commandsFile,
        JSON.stringify(this.commandHistory.slice(-100), null, 2)
      );
    } catch (error) {
      console.error('Error saving command history:', error);
    }
  }

  logCommand(topic, value, success = true) {
    const command = {
      timestamp: new Date().toISOString(),
      topic: topic,
      value: value,
      success: success,
      source: 'AI_ENGINE'
    };
    
    this.commandHistory.push(command);
    this.saveCommandHistory();
    
    return command;
  }

  logDecision(decision, reasons) {
    const entry = {
      timestamp: new Date().toISOString(),
      decision: decision,
      reasons: reasons,
      systemState: {
        battery_soc: this.currentSystemState?.battery_soc,
        pv_power: this.currentSystemState?.pv_power,
        load: this.currentSystemState?.load,
        grid_power: this.currentSystemState?.grid_power,
        grid_voltage: this.currentSystemState?.grid_voltage
      },
      tibberData: {
        currentPrice: tibberService.cache.currentPrice?.total,
        priceLevel: tibberService.cache.currentPrice?.level,
        averagePrice: tibberService.calculateAveragePrice()
      }
    };

    this.decisionHistory.push(entry);
    this.lastDecision = entry;
    this.saveDecisionHistory();

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

      // Critical: Check grid voltage stability
      if (gridVoltage < 200 || gridVoltage > 250) {
        shouldStop = true;
        reasons.push(`Grid voltage unstable: ${gridVoltage}V`);
      }

      // Check if battery is full
      if (batterySOC >= config.targetSoC) {
        shouldStop = true;
        reasons.push(`Battery SOC at target: ${batterySOC}%`);
      }

      // Check if battery is critically low
      if (batterySOC < config.minimumSoC) {
        shouldCharge = true;
        reasons.push(`Battery SOC below minimum: ${batterySOC}%`);
      }

      // PV is generating enough - charge from PV only
      if (pvPower > load) {
        const surplus = pvPower - load;
        if (surplus > 1000 && batterySOC < config.targetSoC) {
          shouldCharge = true;
          reasons.push(`PV surplus available: ${surplus}W`);
        }
      }

      // Price-based charging logic
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
      const historicalPattern = this.analyzeHistoricalPattern();
      if (historicalPattern.isTypicallyCheap && batterySOC < config.targetSoC) {
        shouldCharge = true;
        reasons.push(`Historical pattern suggests cheap prices now`);
      }

      // Make descriptive decision based on conditions
      let decision = this.makeDescriptiveDecision(batterySOC, pvPower, load, currentPrice, avgPrice, gridVoltage, config, shouldCharge, shouldStop, reasons);

      // Apply decision via MQTT
      if (decision.includes('CHARGE') || decision.includes('STOP')) {
        const actionDecision = decision.includes('STOP') ? 'STOP_CHARGING' : 'START_CHARGING';
        this.applyDecision(actionDecision);
      }

      return this.logDecision(decision, reasons);
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
      if (batterySOC < config.minimumSoC) {
        return `CHARGE WITH GRID - Emergency charging (SOC ${batterySOC}% < ${config.minimumSoC}%)`;
      }
      if (pvSurplus > 1000) {
        return `CHARGE WITH SOLAR - Surplus ${pvSurplus}W available (PV: ${pvPower}W, Load: ${load}W)`;
      }
      if (priceIsGood && pvPower < 500) {
        return `CHARGE WITH GRID - Cheap price ${currentPrice.total.toFixed(2)}€ (${currentPrice.level})`;
      }
      if (priceIsGood && pvSurplus > 0) {
        return `CHARGE WITH SOLAR+GRID - Cheap price + PV surplus (${pvSurplus}W)`;
      }
      return `CHARGE WITH GRID - Good conditions (SOC: ${batterySOC}%)`;
    }
    
    // No action scenarios
    if (pvPower > load * 0.8 && batterySOC > 50) {
      return `USE BATTERY - PV covering ${((pvPower/load)*100).toFixed(0)}% of load, preserving battery (${batterySOC}%)`;
    }
    if (batterySOC > 70 && priceIsHigh) {
      return `USE BATTERY - Avoiding expensive grid (${currentPrice?.total.toFixed(2)}€), battery at ${batterySOC}%`;
    }
    if (pvPower > load * 0.5) {
      return `USE SOLAR+BATTERY - PV covering ${((pvPower/load)*100).toFixed(0)}% of load (${pvPower}W/${load}W)`;
    }
    
    return `MONITOR - Stable conditions (SOC: ${batterySOC}%, PV: ${pvPower}W, Load: ${load}W)`;
  }

  analyzeHistoricalPattern() {
    // Simple pattern analysis: check if current hour is typically cheap
    const now = new Date();
    const currentHour = now.getHours();
    
    // Get decisions from same hour in past 7 days
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const relevantDecisions = this.decisionHistory.filter(d => {
      const decisionDate = new Date(d.timestamp);
      const decisionHour = decisionDate.getHours();
      return decisionDate > oneWeekAgo && decisionHour === currentHour;
    });

    if (relevantDecisions.length < 3) {
      return { isTypicallyCheap: false, confidence: 0 };
    }

    const cheapCount = relevantDecisions.filter(d => 
      d.tibberData?.priceLevel === 'VERY_CHEAP' || 
      d.tibberData?.priceLevel === 'CHEAP'
    ).length;

    const ratio = cheapCount / relevantDecisions.length;
    
    return {
      isTypicallyCheap: ratio > 0.6,
      confidence: ratio,
      sampleSize: relevantDecisions.length
    };
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
      const inverterNumber = global.inverterNumber || 1;
      const mqttTopicPrefix = global.mqttTopicPrefix || 'solar';
      
      let commandsSent = 0;
      let totalInverters = 0;
      
      console.log(`🤖 AI Charging: Processing ${enableCharging ? 'enable' : 'disable'} command for ${inverterNumber} inverter(s) with intelligent type detection`);
      
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
          this.mqttClient.publish(chargerTopic, settings.chargerPriority, { qos: 1, retain: false }, (err) => {
            if (!err) {
              this.logCommand(chargerTopic, settings.chargerPriority, true);
              commandsSent++;
            }
          });
          
          // Send output_source_priority command
          const outputTopic = `${mqttTopicPrefix}/${inverterId}/output_source_priority/set`;
          this.mqttClient.publish(outputTopic, settings.outputPriority, { qos: 1, retain: false }, (err) => {
            if (!err) {
              this.logCommand(outputTopic, settings.outputPriority, true);
              commandsSent++;
            }
          });
          
          console.log(`🧠 AI Charging: Charger="${settings.chargerPriority}", Output="${settings.outputPriority}" (${settings.reason}) for ${inverterId}`);
          totalInverters++;
          continue; // Skip the single command logic below
        } else {
          // Use legacy grid_charge for legacy inverters
          topic = `${mqttTopicPrefix}/${inverterId}/grid_charge/set`;
          mqttValue = commandValue;
          console.log(`🔄 AI Charging: Legacy grid_charge "${commandValue}" for ${inverterId}`);
        }
        
        // Only for legacy inverters (new inverters handled above)
        if (inverterType === 'legacy') {
          this.mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
            if (err) {
              console.error(`❌ Error publishing to ${topic}: ${err.message}`);
              this.logCommand(topic, mqttValue, false);
            } else {
              commandsSent++;
              this.logCommand(topic, mqttValue, true);
            }
          });
          totalInverters++;
        }
      }
      
      const action = enableCharging ? 'enabled' : 'disabled';
      console.log(`🤖 AI Charging: Grid charging ${action} for ${totalInverters} inverter(s) - Commands sent: ${commandsSent}/${totalInverters}`);
      
      return commandsSent > 0;
    } catch (error) {
      console.error('❌ Error applying AI decision:', error);
      return false;
    }
  }

  getInverterType(inverterId) {
    try {
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
    const priceHigh = currentPrice && avgPrice ? currentPrice.total > avgPrice * 1.2 : false;
    const gridUnstable = gridVoltage < 200 || gridVoltage > 250;
    const socAtTarget = batterySOC >= (config?.targetSoC || 80);
    
    let chargerPriority = 'Solar first';
    let outputPriority = 'Solar/Battery/Utility';
    let reason = '';
    
    // SOC > target or grid unstable → Solar first + avoid grid for loads
    if (socAtTarget || gridUnstable) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';  // Use battery before expensive/unstable grid
      reason = socAtTarget ? 'SOC at target' : 'Grid unstable';
    }
    // Charging disabled → Conservative mode
    else if (!enableCharging) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';  // Standard priority sequence
      reason = 'Charging disabled';
    }
    // Strong solar surplus → Solar priority for everything
    else if (pvPower > load * 2 && batterySOC < 90) {
      chargerPriority = 'Solar only';
      outputPriority = 'Solar first';  // Abundant solar, prioritize it
      reason = 'Strong solar surplus';
    }
    // No PV, cheap prices → Use cheap grid
    else if (!pvAvailable && priceLow) {
      chargerPriority = 'Utility first';
      outputPriority = 'Utility first';  // Cheap grid available
      reason = 'No PV, cheap grid';
    }
    // No PV, expensive prices → Avoid grid for loads
    else if (!pvAvailable && priceHigh) {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';  // Use battery before expensive grid
      reason = 'No PV, expensive grid';
    }
    // PV + cheap prices → Fast charging mode
    else if (pvAvailable && priceLow) {
      chargerPriority = 'Solar and utility simultaneously';
      outputPriority = 'Solar/Utility/Battery';  // Use both solar and cheap grid
      reason = 'PV + cheap grid';
    }
    // PV + low battery → Balanced approach
    else if (pvAvailable && batterySOC < 50) {
      chargerPriority = 'Solar and utility simultaneously';
      outputPriority = 'Solar/Utility/Battery';  // Mixed sources
      reason = 'Mixed mode for low SOC';
    }
    // Default conservative mode
    else {
      chargerPriority = 'Solar first';
      outputPriority = 'Solar/Battery/Utility';  // Standard safe sequence
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
    return {
      enabled: this.enabled,
      running: !!this.evaluationInterval,
      lastDecision: this.lastDecision,
      decisionCount: this.decisionHistory.length,
      tibberStatus: tibberService.getStatus()
    };
  }

  getDecisionHistory(limit = 50) {
    return this.decisionHistory.slice(-limit).reverse();
  }

  getCommandHistory(limit = 50) {
    return this.commandHistory.slice(-limit).reverse();
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