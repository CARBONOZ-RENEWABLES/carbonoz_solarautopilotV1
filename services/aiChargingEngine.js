const tibberService = require('./tibberService');
const influxAIService = require('./influxAIService');

class AIChargingEngine {
  constructor() {
    this.enabled = false;
    this.lastDecision = null;
    this.evaluationInterval = null;
    this.mqttClient = null;
    this.currentSystemState = null;
    this.lastCommand = null; // Track last sent command
    
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
      const config = tibberService.config;

      // Rule 1: Price threshold - never charge above 15 cents
      const maxPriceThreshold = 0.15; // 15 cents
      if (currentPrice && currentPrice.total > maxPriceThreshold) {
        reasons.push(`Price too high: ${(currentPrice.total * 100).toFixed(1)}¢ (max: 15¢)`);
        shouldStop = true;
      }

      // Rule 2: Find lowest price in available forecast
      const lowestPrice = await this.findLowestPrice();
      let gridChargingAllowed = false;
      
      if (currentPrice && lowestPrice) {
        const priceMargin = 0.02; // 2 cent margin
        const isAtLowestPrice = currentPrice.total <= (lowestPrice + priceMargin);
        
        if (isAtLowestPrice && currentPrice.total <= maxPriceThreshold) {
          gridChargingAllowed = true;
          reasons.push(`At lowest price: ${(currentPrice.total * 100).toFixed(1)}¢ (min: ${(lowestPrice * 100).toFixed(1)}¢)`);
        } else if (currentPrice.total <= maxPriceThreshold) {
          reasons.push(`Price acceptable but not lowest: ${(currentPrice.total * 100).toFixed(1)}¢ (min: ${(lowestPrice * 100).toFixed(1)}¢)`);
        }
      }

      // Rule 3: Negative prices - always charge
      if (currentPrice && currentPrice.total < 0) {
        gridChargingAllowed = true;
        reasons.push(`NEGATIVE PRICE: Getting paid ${Math.abs(currentPrice.total * 100).toFixed(1)}¢/kWh`);
      }

      // Rule 4: Solar priority - always use solar first
      const pvSurplus = pvPower - load;
      if (pvSurplus > 100 && batterySOC < 95) {
        reasons.push(`Using solar surplus: ${pvSurplus.toFixed(0)}W`);
      }

      // Rule 5: Safety checks
      if (batterySOC >= config.targetSoC) {
        shouldStop = true;
        reasons.push(`Battery at target SOC: ${batterySOC}%`);
      }

      if (gridVoltage < 200 || gridVoltage > 250) {
        shouldStop = true;
        gridChargingAllowed = false;
        reasons.push(`Grid voltage unstable: ${gridVoltage}V`);
      }

      // Grid charging decision logic
      if (gridChargingAllowed && batterySOC < config.targetSoC && !shouldStop) {
        shouldCharge = true;
        reasons.push(`Grid charging enabled: Low price + SOC ${batterySOC}%`);
      }

      // Make decision
      let decision = this.makeIntelligentDecision(
        batterySOC, pvPower, load, currentPrice, 
        gridVoltage, config, shouldCharge, shouldStop, reasons
      );

      // Apply decision
      if (decision.includes('CHARGE') || decision.includes('STOP')) {
        const actionDecision = decision.includes('STOP') ? 'STOP_CHARGING' : 'START_CHARGING';
        await this.applyDecision(actionDecision);
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

  async findLowestPrice() {
    try {
      // Get current price and forecast from Tibber
      const forecast = tibberService.cache.forecast || [];
      const currentPrice = tibberService.cache.currentPrice;
      
      if (!forecast.length && !currentPrice) {
        console.log('⚠️ No price data available');
        return null;
      }
      
      // Combine current price with forecast
      const allPrices = [];
      if (currentPrice) {
        allPrices.push(currentPrice.total);
      }
      
      // Add next 24 hours from forecast
      const now = new Date();
      const next24Hours = forecast
        .filter(price => {
          const priceTime = new Date(price.startsAt);
          return priceTime > now && priceTime <= new Date(now.getTime() + 24 * 60 * 60 * 1000);
        })
        .map(price => price.total);
      
      allPrices.push(...next24Hours);
      
      if (allPrices.length === 0) {
        return null;
      }
      
      const lowestPrice = Math.min(...allPrices);
      console.log(`📊 Lowest price in next 24h: ${(lowestPrice * 100).toFixed(1)}¢`);
      
      return lowestPrice;
    } catch (error) {
      console.warn('Failed to find lowest price:', error.message);
      return null;
    }
  }





  makeIntelligentDecision(batterySOC, pvPower, load, currentPrice, gridVoltage, config, shouldCharge, shouldStop, reasons) {
    const pvSurplus = pvPower - load;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;
    
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
      if (priceIsNegative) {
        return `CHARGE WITH GRID - NEGATIVE PRICE! Getting paid ${Math.abs(currentPrice.total).toFixed(3)}€/kWh`;
      }
      return `CHARGE WITH GRID - Optimal conditions (SOC: ${batterySOC}%)`;
    }
    
    // NORMAL operations (Solar priority)
    if (pvSurplus > 1000 && batterySOC < 95) {
      return `CHARGE WITH SOLAR - Surplus ${pvSurplus.toFixed(0)}W available`;
    }
    
    if (batterySOC >= config.targetSoC && pvPower > load) {
      return `SOLAR EXPORT MODE - Battery full (${batterySOC}%), exporting ${pvSurplus.toFixed(0)}W surplus`;
    }
    
    if (pvPower > 100) {
      return `USE SOLAR - PV generating ${pvPower.toFixed(0)}W, Load: ${load.toFixed(0)}W, SOC: ${batterySOC}%`;
    }
    
    return `MONITOR - Stable (SOC: ${batterySOC}%, PV: ${pvPower.toFixed(0)}W, Load: ${load.toFixed(0)}W)`;
  }

  async applyDecision(decision) {
    try {
      const enableCharging = decision === 'START_CHARGING';
      const commandValue = this.getOptimalChargingMode(enableCharging);
      
      // Check if this is the same command as last time
      if (this.lastCommand === commandValue) {
        console.log(`⏭️ Skipping duplicate command: ${decision} (${commandValue})`);
        return;
      }
      
      // Send command to all detected inverters
      let commandsSent = 0;
      for (let i = 1; i <= this.config.inverterNumber; i++) {
        const inverterId = `inverter_${i}`;
        const inverterType = this.config.inverterTypes[inverterId]?.type || 'unknown';
        
        let topic, value;
        
        if (inverterType === 'new') {
          // Send both charger and output priority commands
          const chargerTopic = `${this.config.mqttTopicPrefix}/${inverterId}/charger_source_priority/set`;
          const outputTopic = `${this.config.mqttTopicPrefix}/${inverterId}/output_source_priority/set`;
          const outputValue = this.getOptimalOutputPriority(enableCharging);
          
          if (this.mqttClient) {
            this.mqttClient.publish(chargerTopic, commandValue);
            this.mqttClient.publish(outputTopic, outputValue);
            await this.logCommand(chargerTopic, commandValue, true);
            await this.logCommand(outputTopic, outputValue, true);
            commandsSent++;
          }
        } else {
          // Legacy inverter
          topic = `${this.config.mqttTopicPrefix}/${inverterId}/grid_charge/set`;
          value = enableCharging ? 'Enabled' : 'Disabled';
          
          if (this.mqttClient) {
            this.mqttClient.publish(topic, value);
            await this.logCommand(topic, value, true);
            commandsSent++;
          }
        }
      }
      
      this.lastCommand = commandValue;
      console.log(`🔋 Applied decision: ${decision} to ${commandsSent} inverter(s) (${commandValue})`);
      
    } catch (error) {
      console.error('❌ Failed to apply decision:', error);
      await this.logCommand('error', decision, false);
    }
  }

  getOptimalChargingMode(enableCharging) {
    if (!enableCharging) {
      return 'Solar first'; // Stop grid charging, solar priority
    }

    const pvPower = this.currentSystemState?.pv_power || 0;
    const load = this.currentSystemState?.load || 0;
    const batterySOC = this.currentSystemState?.battery_soc || 0;
    const pvSurplus = pvPower - load;
    const currentPrice = tibberService.cache.currentPrice;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;

    // Strong solar surplus (>1000W) - use solar only
    if (pvSurplus > 1000 && batterySOC < 90) {
      return 'Solar only';
    }
    
    // Negative prices - use both sources aggressively
    if (priceIsNegative) {
      return 'Solar and utility simultaneously';
    }
    
    // Moderate solar with very cheap prices - use both
    if (pvSurplus > 200 && currentPrice && currentPrice.total < 0.05) {
      return 'Solar and utility simultaneously';
    }
    
    // Default - solar priority
    return 'Solar first';
  }

  getOptimalOutputPriority(enableCharging) {
    const pvPower = this.currentSystemState?.pv_power || 0;
    const load = this.currentSystemState?.load || 0;
    const batterySOC = this.currentSystemState?.battery_soc || 0;
    const pvSurplus = pvPower - load;
    const currentPrice = tibberService.cache.currentPrice;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;

    // Strong solar surplus - prioritize solar for loads
    if (pvSurplus > 1000) {
      return 'Solar first';
    }
    
    // Negative prices - use grid for loads, save battery
    if (priceIsNegative) {
      return 'Utility first';
    }
    
    // Low battery - preserve battery, use solar/grid
    if (batterySOC < 30) {
      return 'Solar/Utility/Battery';
    }
    
    // Default - solar → battery → grid sequence
    return 'Solar/Battery/Utility';
  }

  async getDecisionHistory(limit = 50) {
    try {
      return await influxAIService.getDecisionHistory(limit);
    } catch (error) {
      console.error('Error getting decision history:', error);
      return [];
    }
  }

  async getCommandHistory(limit = 50) {
    try {
      return await influxAIService.getCommandHistory(limit);
    } catch (error) {
      console.error('Error getting command history:', error);
      return [];
    }
  }

  async start() {
    // Only start if learner mode is active
    if (!global.learnerModeActive) {
      console.log('⚠️ AI Charging Engine: Learner mode must be active to start');
      return { success: false, message: 'Learner mode must be active to start AI engine' };
    }
    
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
    
    // Start immediately - no historical data requirement
    this.startEngine();
    return { success: true, message: 'AI Charging Engine started successfully' };
  }

  startEngine() {
    this.enabled = true;
    this.evaluationInterval = setInterval(() => {
      // Stop if learner mode is deactivated
      if (!global.learnerModeActive) {
        this.stop();
        return;
      }
      
      this.evaluate().catch(error => {
        console.error('❌ Error in AI evaluation interval:', error);
      });
    }, 300000); // Evaluate every 5 minutes
    
    console.log('🚀 AI Charging Engine started - Simple lowest price strategy (5min intervals)');
    return { success: true, message: 'AI Charging Engine started successfully' };
  }

  stop() {
    this.enabled = false;
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
    console.log('⏹️ AI Charging Engine stopped');
    return { success: true, message: 'AI Charging Engine stopped successfully' };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      lastDecision: this.lastDecision,
      config: this.config,
      hasInterval: !!this.evaluationInterval
    };
  }
}

module.exports = new AIChargingEngine();