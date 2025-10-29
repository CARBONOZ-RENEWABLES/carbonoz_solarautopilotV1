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
    console.log('✅ AI Charging Engine initialized with context-aware commands');
  }

  updateSystemState(systemState) {
    this.currentSystemState = systemState;
  }

  loadDecisionHistory() {
    try {
      if (fs.existsSync(this.decisionsFile)) {
        const data = JSON.parse(fs.readFileSync(this.decisionsFile, 'utf8'));
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

      // Determine time context
      const now = new Date();
      const hour = now.getHours();
      const isDaytime = hour >= 6 && hour < 20;
      const hasPV = pvPower > 500; // Meaningful PV generation

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

      // PV is generating enough - prioritize solar charging
      if (hasPV && pvPower > load) {
        const surplus = pvPower - load;
        if (surplus > 1000 && batterySOC < config.targetSoC) {
          shouldCharge = true;
          reasons.push(`PV surplus available: ${surplus}W - using solar priority`);
        }
      }

      // Price-based charging logic
      if (currentPrice && avgPrice !== null && batterySOC < config.targetSoC) {
        if (priceIsGood && gridVoltage >= 200 && gridVoltage <= 250) {
          shouldCharge = true;
          reasons.push(
            `Good price: ${currentPrice.total.toFixed(2)} ${currentPrice.currency} ` +
            `(avg: ${avgPrice.toFixed(2)}, level: ${currentPrice.level})`
          );
        } else if (currentPrice.total > avgPrice * 1.2) {
          shouldStop = true;
          reasons.push(
            `Price too high: ${currentPrice.total.toFixed(2)} ${currentPrice.currency} ` +
            `(20% above avg: ${avgPrice.toFixed(2)})`
          );
        }
      }

      // Learning from history
      const historicalPattern = this.analyzeHistoricalPattern();
      if (historicalPattern.isTypicallyCheap && batterySOC < config.targetSoC) {
        shouldCharge = true;
        reasons.push(`Historical pattern suggests cheap prices now`);
      }

      // Make final decision with context
      let decision;
      if (shouldStop) {
        decision = 'STOP_CHARGING';
      } else if (shouldCharge) {
        decision = 'START_CHARGING';
      } else {
        decision = 'NO_CHANGE';
      }

      // Apply decision with context-aware commands
      if (decision === 'START_CHARGING' || decision === 'STOP_CHARGING') {
        this.applyDecision(decision, { hasPV, isDaytime, priceIsGood });
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

  analyzeHistoricalPattern() {
    const now = new Date();
    const currentHour = now.getHours();
    
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

  /**
   * Enhanced context-aware command application
   * This method determines the optimal command based on:
   * - Whether to charge or not
   * - Current PV availability
   * - Time of day
   * - Price situation
   * - Inverter type (legacy/new)
   */
  applyDecision(decision, context = {}) {
    if (!this.mqttClient || !this.mqttClient.connected) {
      console.error('❌ MQTT client not connected, cannot apply decision');
      return false;
    }

    if (!global.learnerModeActive) {
      console.log('⚠️  AI decision not applied: Learner mode is inactive');
      return false;
    }

    try {
      const enableCharging = decision === 'START_CHARGING';
      const { hasPV = false, isDaytime = false, priceIsGood = false } = context;
      
      const inverterNumber = process.env.INVERTER_NUMBER || 1;
      const mqttTopicPrefix = process.env.MQTT_TOPIC_PREFIX || 'solar';
      
      let commandsSent = 0;
      let totalInverters = 0;
      
      console.log(`🤖 AI Charging: Processing ${enableCharging ? 'enable' : 'disable'} command`);
      console.log(`   Context: PV=${hasPV}, Daytime=${isDaytime}, GoodPrice=${priceIsGood}`);
      
      for (let i = 1; i <= inverterNumber; i++) {
        const inverterId = `inverter_${i}`;
        const inverterType = this.getInverterType(inverterId);
        
        let commands = [];
        
        if (inverterType === 'new' || inverterType === 'hybrid') {
          // Modern inverter - use sophisticated priority commands
          commands = this.getModernInverterCommands(
            enableCharging, 
            hasPV, 
            isDaytime, 
            priceIsGood,
            mqttTopicPrefix,
            inverterId
          );
        } else {
          // Legacy inverter - use simple grid_charge
          commands = this.getLegacyInverterCommands(
            enableCharging,
            mqttTopicPrefix,
            inverterId
          );
        }
        
        // Send all commands for this inverter
        commands.forEach(cmd => {
          this.mqttClient.publish(cmd.topic, cmd.value, { qos: 1, retain: false }, (err) => {
            if (err) {
              console.error(`❌ Error publishing to ${cmd.topic}: ${err.message}`);
              this.logCommand(cmd.topic, cmd.value, false);
            } else {
              console.log(`✅ ${cmd.description}: ${cmd.topic} = ${cmd.value}`);
              commandsSent++;
              this.logCommand(cmd.topic, cmd.value, true);
            }
          });
        });
        
        totalInverters++;
      }
      
      const action = enableCharging ? 'enabled' : 'disabled';
      console.log(`🤖 AI Charging: Grid charging ${action} - Commands sent: ${commandsSent}`);
      
      return commandsSent > 0;
    } catch (error) {
      console.error('❌ Error applying AI decision:', error);
      return false;
    }
  }

  /**
   * Get optimized commands for modern/new inverters
   * These inverters support fine-grained priority control
   */
  getModernInverterCommands(enableCharging, hasPV, isDaytime, priceIsGood, prefix, inverterId) {
    const commands = [];
    
    if (enableCharging) {
      // CHARGING SCENARIO
      
      if (hasPV && priceIsGood) {
        // Best case: PV available AND good price
        // Use solar + utility simultaneously for maximum charging
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Solar and utility simultaneously',
          description: 'PV + Grid charging (both available)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Solar first',
          description: 'Output prioritizes solar'
        });
      } else if (hasPV && !priceIsGood) {
        // PV available but price is bad
        // Use solar only, avoid expensive grid
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Solar only',
          description: 'Solar-only charging (price too high for grid)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Solar first',
          description: 'Output prioritizes solar'
        });
      } else if (!hasPV && priceIsGood) {
        // No PV (night/cloudy) but price is good
        // Use grid charging aggressively
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Utility first',
          description: 'Grid charging (no PV, good price)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Utility first',
          description: 'Output uses grid to minimize battery cycles'
        });
      } else {
        // No PV and bad price - minimal charging
        // Wait for better conditions but keep battery safe
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Solar first',
          description: 'Waiting for solar (no PV, bad price)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Solar/Battery/Utility',
          description: 'Use battery sparingly'
        });
      }
      
    } else {
      // STOP CHARGING SCENARIO
      
      if (hasPV) {
        // PV available - use solar priority
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Solar only',
          description: 'Solar-only (battery full or price high)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Solar first',
          description: 'Output prioritizes solar'
        });
      } else if (isDaytime) {
        // Daytime but no PV yet (cloudy or early morning)
        // Wait for solar but keep battery option
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Solar first',
          description: 'Waiting for solar (daytime, cloudy)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Solar/Battery/Utility',
          description: 'Flexible output priority'
        });
      } else {
        // Nighttime - no solar possible
        // Use battery first, grid as backup
        commands.push({
          topic: `${prefix}/${inverterId}/charger_source_priority/set`,
          value: 'Solar first',
          description: 'Solar priority (night - will use battery/grid)'
        });
        commands.push({
          topic: `${prefix}/${inverterId}/output_source_priority/set`,
          value: 'Solar/Battery/Utility',
          description: 'Battery first at night, grid backup'
        });
      }
    }
    
    return commands;
  }

  /**
   * Get commands for legacy inverters
   * These only support simple grid_charge enable/disable
   */
  getLegacyInverterCommands(enableCharging, prefix, inverterId) {
    const commandValue = enableCharging ? 'Enabled' : 'Disabled';
    
    return [{
      topic: `${prefix}/${inverterId}/grid_charge/set`,
      value: commandValue,
      description: `Legacy grid charge ${commandValue.toLowerCase()}`
    }];
  }

  getInverterType(inverterId) {
    try {
      if (global.inverterTypes && global.inverterTypes[inverterId]) {
        return global.inverterTypes[inverterId].type || 'legacy';
      }
      return 'legacy';
    } catch (error) {
      console.error(`Error getting inverter type for ${inverterId}:`, error);
      return 'legacy';
    }
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