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
      const config = tibberService.config;

      // Rule 1: Grid charging OFF by default
      let gridChargingAllowed = false;

      // Rule 2: Verify price data is still available
      const hasHistoricalData = await this.checkHistoricalPriceData();
      if (!hasHistoricalData) {
        reasons.push('Lost Tibber price data - stopping engine');
        this.stop();
        return await this.logDecision('STOPPED', reasons);
      }

      // Rule 3: Price-based rules
      const priceAnalysis = await this.analyzePriceConditions(currentPrice);
      if (currentPrice && currentPrice.total >= 0.20) {
        reasons.push(`Price too high: ${currentPrice.total.toFixed(3)}€/kWh (≥20¢)`);
      } else if (priceAnalysis.isNearLowest) {
        gridChargingAllowed = true;
        reasons.push(`Price near daily minimum: ${currentPrice.total.toFixed(3)}€/kWh (threshold: ${priceAnalysis.threshold.toFixed(3)}€)`);
      }

      // Rule 4: Weather forecast check
      const weatherForecast = await this.checkWeatherForecast();
      if (weatherForecast.sunnyDaysAhead) {
        gridChargingAllowed = false;
        reasons.push('Sunny weather forecast - PV will cover demand');
      }

      // Rule 5: Solar priority - always use solar first
      const pvSurplus = pvPower - load;
      if (pvSurplus > 100 && batterySOC < 95) {
        reasons.push(`Using solar surplus: ${pvSurplus.toFixed(0)}W`);
      }

      // Rule 6: Safety checks
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
        // Only charge if price is very low and conditions are met
        if (currentPrice && currentPrice.total < 0) {
          shouldCharge = true;
          reasons.push(`NEGATIVE PRICE: Getting paid ${Math.abs(currentPrice.total).toFixed(3)}€/kWh`);
        } else if (priceAnalysis.isNearLowest && batterySOC < 50 && pvPower < 100) {
          shouldCharge = true;
          reasons.push(`Optimal grid charging: Low price + low SOC (${batterySOC}%)`);
        }
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

  async checkHistoricalPriceData() {
    try {
      // Check if we have 1 week of Tibber price data
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      // Try to get price data count from InfluxDB
      let priceDataCount = 0;
      try {
        if (influxAIService.getTibberPriceDataCount) {
          priceDataCount = await influxAIService.getTibberPriceDataCount(oneWeekAgo);
        }
      } catch (err) {
        // Method doesn't exist yet, return 0
        priceDataCount = 0;
      }
      
      const requiredDataPoints = 7 * 24; // 1 week of hourly data
      const hasEnoughData = priceDataCount >= requiredDataPoints;
      
      if (!hasEnoughData) {
        const daysOfData = Math.floor(priceDataCount / 24);
        console.log(`⚠️ Insufficient price history: ${daysOfData} days (need 7 days minimum)`);
      }
      
      return hasEnoughData;
    } catch (error) {
      console.warn('Failed to check historical price data:', error.message);
      return false;
    }
  }

  async analyzePriceConditions(currentPrice) {
    try {
      if (!currentPrice) return { isNearLowest: false, threshold: 0 };
      
      // Get 1 week of historical price data for pattern analysis
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const historicalPrices = await this.getHistoricalPrices(oneWeekAgo);
      
      if (!historicalPrices || historicalPrices.length < 100) {
        // Fallback to current price level if insufficient historical data
        const isVeryLow = currentPrice.level === 'VERY_CHEAP';
        return {
          isNearLowest: isVeryLow,
          threshold: currentPrice.total,
          minPrice: currentPrice.total,
          currentPrice: currentPrice.total
        };
      }
      
      // Analyze historical price patterns
      const prices = historicalPrices.map(p => p.price);
      const sortedPrices = [...prices].sort((a, b) => a - b);
      
      // Calculate percentiles for intelligent thresholds
      const p10 = sortedPrices[Math.floor(sortedPrices.length * 0.1)]; // Bottom 10%
      const p25 = sortedPrices[Math.floor(sortedPrices.length * 0.25)]; // Bottom 25%
      const median = sortedPrices[Math.floor(sortedPrices.length * 0.5)];
      const average = prices.reduce((sum, p) => sum + p, 0) / prices.length;
      
      // Current hour analysis - check if this hour is typically low-priced
      const currentHour = new Date().getHours();
      const sameHourPrices = historicalPrices
        .filter(p => new Date(p.timestamp).getHours() === currentHour)
        .map(p => p.price);
      
      const hourlyAverage = sameHourPrices.length > 0 
        ? sameHourPrices.reduce((sum, p) => sum + p, 0) / sameHourPrices.length
        : average;
      
      // Intelligent threshold: Use stricter criteria based on historical patterns
      // Only charge when price is in bottom 20% AND below hourly average
      const isInBottom20Percent = currentPrice.total <= p25;
      const isBelowHourlyAverage = currentPrice.total <= hourlyAverage * 0.9;
      const isNearLowest = isInBottom20Percent && isBelowHourlyAverage;
      
      return {
        isNearLowest: isNearLowest,
        threshold: p25,
        minPrice: sortedPrices[0],
        currentPrice: currentPrice.total,
        percentile: this.calculatePercentile(currentPrice.total, sortedPrices),
        hourlyAverage: hourlyAverage,
        weeklyAverage: average
      };
    } catch (error) {
      console.warn('Failed to analyze price conditions:', error.message);
      return { isNearLowest: false, threshold: 0 };
    }
  }

  async getHistoricalPrices(fromDate) {
    try {
      if (influxAIService.getTibberPriceHistory) {
        return await influxAIService.getTibberPriceHistory(fromDate, new Date());
      }
      return [];
    } catch (error) {
      console.warn('Failed to get historical prices:', error.message);
      return [];
    }
  }

  calculatePercentile(value, sortedArray) {
    const index = sortedArray.findIndex(v => v >= value);
    return index === -1 ? 100 : Math.round((index / sortedArray.length) * 100);
  }

  async checkWeatherForecast() {
    try {
      // Mock weather check - integrate with actual weather API
      const mockSunnyForecast = Math.random() > 0.7; // 30% chance of sunny forecast
      return {
        sunnyDaysAhead: mockSunnyForecast,
        forecast: mockSunnyForecast ? 'sunny' : 'cloudy'
      };
    } catch (error) {
      console.warn('Failed to check weather forecast:', error.message);
      return { sunnyDaysAhead: false, forecast: 'unknown' };
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
      const topic = `${this.config.mqttTopicPrefix}/inverter${this.config.inverterNumber}/control/battery_charge`;
      const value = decision === 'START_CHARGING' ? 1 : 0;
      
      if (this.mqttClient) {
        this.mqttClient.publish(topic, value.toString());
        await this.logCommand(topic, value, true);
        console.log(`🔋 Applied decision: ${decision} (${topic}: ${value})`);
      }
    } catch (error) {
      console.error('❌ Failed to apply decision:', error);
      await this.logCommand('error', decision, false);
    }
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
    
    // Check if we have 1 week of historical data
    const hasData = await this.checkHistoricalPriceData();
    if (!hasData) {
      console.log('⚠️ AI Charging Engine: Waiting for 1 week of Tibber price data');
      // Check every hour until data is available
      const dataCheckInterval = setInterval(async () => {
        if (!global.learnerModeActive) {
          clearInterval(dataCheckInterval);
          console.log('⚠️ AI Charging Engine: Learner mode deactivated, stopping data check');
          return;
        }
        
        const dataAvailable = await this.checkHistoricalPriceData();
        if (dataAvailable) {
          clearInterval(dataCheckInterval);
          this.startEngine();
        }
      }, 60 * 60 * 1000); // Check every hour
      return;
    }
    
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
    }, 60000); // Evaluate every minute
    
    console.log('🚀 AI Charging Engine started with 1 week price history (60s intervals)');
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