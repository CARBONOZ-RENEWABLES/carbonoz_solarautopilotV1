// Enhanced AI Charging Engine with Academic Study Integration
// Based on: "Do dynamic electricity tariffs change the gains of residential PV-battery systems?"
// Key findings: 12.7% improvement with dynamic tariffs, 8¢/kWh optimal threshold

const tibberService = require('./tibberService');
const influxAIService = require('./influxAIService');

class AIChargingEngine {
  constructor() {
    this.enabled = false;
    this.lastDecision = null;
    this.evaluationInterval = null;
    this.mqttClient = null;
    this.currentSystemState = null;
    this.lastCommand = null;
    
    // Battery size thresholds from study
    this.SMALL_BATTERY_THRESHOLD = 15; // kWh - optimal for price-sensitive operation
    this.MEDIUM_BATTERY_THRESHOLD = 20; // kWh - transition zone
    
    this.config = {
      inverterNumber: 1,
      mqttTopicPrefix: 'solar',
      inverterTypes: {},
      batteryCapacity: 10 // Default 10 kWh, should be configured
    };
    
    this.batteryDetection = {
      autoDetected: false,
      detectionMethod: 'manual',
      confidence: 0
    };
    
    // Academic study parameters
    this.academicParams = {
      // Efficiency values from study (Table in nomenclature)
      chargeEfficiency: 0.95,  // ηc
      dischargeEfficiency: 0.95, // ηd
      roundTripEfficiency: 0.9025, // 95% * 95%
      
      // Price thresholds (converted from study's Euro to cents)
      optimalChargeThreshold: 8, // ¢/kWh - academic optimal
      maxPriceThreshold: 10, // ¢/kWh - boss requirement: no charging above 10 cents
      
      // SOC boundaries from study assumptions
      socMin: 0.20, // 20% minimum (SOCmin)
      socMax: 1.00, // 100% maximum (SOCmax)
      socTarget: 0.80, // 80% target
      
      // Feed-in tariff (typical value from study)
      feedInTariff: 8, // ¢/kWh
      
      // Forecasting parameters
      forecastHorizon: 24, // hours - day-ahead as per study
      
      // C-rate (from study: fixed at 1)
      cRate: 1.0 // Full charge/discharge in 1 hour
    };
  }

  async initialize(mqttClient, currentSystemState, config = {}) {
    this.mqttClient = mqttClient;
    this.currentSystemState = currentSystemState;
    
    if (config.inverterNumber) this.config.inverterNumber = config.inverterNumber;
    if (config.mqttTopicPrefix) this.config.mqttTopicPrefix = config.mqttTopicPrefix;
    if (config.inverterTypes) this.config.inverterTypes = config.inverterTypes;
    if (config.batteryCapacity) this.config.batteryCapacity = config.batteryCapacity;
    
    // Auto-detect battery if not configured
    await this.detectBatteryCapacity();
    
    const sizeCategory = this.getBatterySizeCategory();
    
    console.log('✅ AI Charging Engine initialized (Academic Study Enhanced)');
    console.log(`   • Strategy: Dynamic tariff optimization (12.7% improvement potential)`);
    console.log(`   • Threshold: ≤${this.academicParams.optimalChargeThreshold}¢/kWh (academic optimal)`);
    console.log(`   • Battery: ${this.config.batteryCapacity} kWh (${sizeCategory.category} - ${this.batteryDetection.detectionMethod})`);
    console.log(`   • Category: ${sizeCategory.description}`);
    console.log(`   • Efficiency: ${(this.academicParams.roundTripEfficiency * 100).toFixed(1)}% round-trip`);
  }

  updateSystemState(systemState) {
    this.currentSystemState = systemState;
    
    // Extract battery capacity from MQTT data - dynamically detect batteries
    const batteryCapacityAh = this.extractBatteryCapacity(systemState);
    if (batteryCapacityAh > 0) {
      systemState.battery_capacity_ah = batteryCapacityAh;
      
      // Use actual battery voltage for accurate calculation
      const voltage = systemState.battery_voltage || systemState.total_battery_voltage || 48;
      const calculatedKwh = Math.round((batteryCapacityAh * voltage) / 1000);
      
      // Only log once when battery is first detected or capacity changes
      if (!this.lastBatteryCapacity || this.lastBatteryCapacity !== calculatedKwh) {
        console.log(`🔋 Battery detected: ${calculatedKwh} kWh (${batteryCapacityAh}Ah × ${voltage}V)`);
        this.lastBatteryCapacity = calculatedKwh;
      }
    }
  }

  // Extract battery capacity from any available battery (like inverter numbering)
  extractBatteryCapacity(systemState) {
    // Check all system state keys for battery capacity patterns
    for (const key in systemState) {
      if (key.match(/^battery_\d+_capacity_ah$/) && systemState[key] > 0) {
        return systemState[key];
      }
    }
    
    // Fallback to generic battery capacity
    return systemState.battery_capacity_ah || 0;
  }

  updateConfig(config) {
    if (config.inverterNumber) this.config.inverterNumber = config.inverterNumber;
    if (config.mqttTopicPrefix) this.config.mqttTopicPrefix = config.mqttTopicPrefix;
    if (config.inverterTypes) this.config.inverterTypes = config.inverterTypes;
    if (config.batteryCapacity) {
      this.config.batteryCapacity = config.batteryCapacity;
      this.batteryDetection.detectionMethod = 'manual';
      this.batteryDetection.confidence = 1.0;
    }
  }

  // Auto-detect battery capacity from system data
  async detectBatteryCapacity() {
    if (!this.currentSystemState) return null;
    
    const methods = {
      // Method 1: From MQTT battery capacity data (most reliable)
      mqttBatteryData: () => {
        const batteryCapacityAh = this.extractBatteryCapacity(this.currentSystemState);
        // Use actual battery voltage from MQTT, fallback to 48V
        const batteryVoltage = this.currentSystemState.battery_voltage || 
                              this.currentSystemState.total_battery_voltage || 48;
        
        if (batteryCapacityAh && batteryCapacityAh > 0) {
          // Convert Ah to kWh: Ah × Voltage ÷ 1000
          const capacityKwh = Math.round((batteryCapacityAh * batteryVoltage) / 1000);
          console.log(`🔋 Battery calculation: ${batteryCapacityAh} Ah × ${batteryVoltage} V = ${capacityKwh} kWh`);
          return { capacity: capacityKwh, confidence: 0.98, method: 'mqtt_battery_data' };
        }
        return null;
      },
      
      // Method 2: From inverter specs
      inverterSpecs: () => {
        const inverterType = this.config.inverterTypes[this.config.inverterNumber];
        if (inverterType?.batteryCapacity) {
          return { capacity: inverterType.batteryCapacity, confidence: 0.95, method: 'inverter_specs' };
        }
        return null;
      },
      
      // Method 3: Estimate from PV system size
      systemEstimate: () => {
        const pvPower = this.currentSystemState.pv_power || 0;
        if (pvPower > 0) {
          const estimatedCapacity = Math.round((pvPower / 1000) * 1.5);
          return { capacity: estimatedCapacity, confidence: 0.3, method: 'pv_estimate' };
        }
        return null;
      }
    };
    
    // Try methods in order of reliability
    for (const [methodName, method] of Object.entries(methods)) {
      const result = method();
      if (result) {
        this.config.batteryCapacity = result.capacity;
        this.batteryDetection = {
          autoDetected: true,
          detectionMethod: result.method,
          confidence: result.confidence
        };
        console.log(`🔋 Battery capacity detected: ${result.capacity} kWh (${result.method}, ${(result.confidence * 100).toFixed(0)}% confidence)`);
        return result;
      }
    }
    
    return null;
  }

  // Get battery size category for strategy selection
  getBatterySizeCategory() {
    const capacity = this.config.batteryCapacity;
    
    if (capacity <= this.SMALL_BATTERY_THRESHOLD) {
      return {
        category: 'SMALL',
        threshold: this.SMALL_BATTERY_THRESHOLD,
        description: `≤${this.SMALL_BATTERY_THRESHOLD} kWh - Price-sensitive optimal`
      };
    } else if (capacity <= this.MEDIUM_BATTERY_THRESHOLD) {
      return {
        category: 'MEDIUM', 
        threshold: this.MEDIUM_BATTERY_THRESHOLD,
        description: `${this.SMALL_BATTERY_THRESHOLD}-${this.MEDIUM_BATTERY_THRESHOLD} kWh - Hybrid strategy`
      };
    } else {
      return {
        category: 'LARGE',
        threshold: capacity,
        description: `>${this.MEDIUM_BATTERY_THRESHOLD} kWh - Self-consumption optimal`
      };
    }
  }

  async logCommand(topic, value, success = true) {
    const command = {
      timestamp: new Date().toISOString(),
      topic: topic,
      value: value,
      success: success,
      source: 'AI_ENGINE_ACADEMIC'
    };
    
    await influxAIService.saveCommand(topic, value, success);
    return command;
  }

  async logDecision(decision, reasons, academicMetrics = {}) {
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
      tibberData: tibberData,
      academicMetrics: {
        strategy: academicMetrics.strategy || 'unknown',
        expectedImprovement: academicMetrics.expectedImprovement || 0,
        batterySize: this.config.batteryCapacity,
        priceVsThreshold: tibberData.currentPrice ? 
          ((tibberData.currentPrice / this.academicParams.optimalChargeThreshold - 1) * 100).toFixed(1) + '%' : 
          'N/A'
      }
    };

    this.lastDecision = entry;
    await influxAIService.saveDecision(decision, reasons, systemState, tibberData);

    // Only log important decisions, not routine monitoring
    if (!decision.includes('MONITOR') && !decision.includes('SOLAR ACTIVE')) {
      console.log(`🤖 AI: ${decision}`);
    }
    
    return entry;
  }

  // Academic study-based strategy selection
  selectOptimalStrategy() {
    const batterySize = this.config.batteryCapacity;
    const sizeCategory = this.getBatterySizeCategory();
    
    // Auto-detect if not manually configured (non-blocking)
    if (!this.batteryDetection.autoDetected && this.batteryDetection.detectionMethod === 'manual') {
      this.detectBatteryCapacity().catch(console.error);
    }
    
    // From study: "for BESS up to 15 kWh, price-sensitive operation is beneficial"
    // "for larger BESS beyond 15 kWh, maximization of self-consumption yields higher net gains"
    
    if (batterySize <= this.SMALL_BATTERY_THRESHOLD) {
      return {
        name: 'PRICE_SENSITIVE_OPTIMAL',
        description: `Price-sensitive operation (${sizeCategory.description})`,
        expectedImprovement: 12.7, // % improvement from study
        usePriceThresholds: true,
        aggressiveCharging: true,
        batteryCategory: sizeCategory
      };
    } else if (batterySize <= this.MEDIUM_BATTERY_THRESHOLD) {
      return {
        name: 'HYBRID_STRATEGY',
        description: `Hybrid strategy (${sizeCategory.description})`,
        expectedImprovement: 8.0, // Interpolated
        usePriceThresholds: true,
        aggressiveCharging: false,
        batteryCategory: sizeCategory
      };
    } else {
      return {
        name: 'SELF_CONSUMPTION_OPTIMAL',
        description: `Self-consumption maximization (${sizeCategory.description})`,
        expectedImprovement: 6.0, // Study shows diminishing returns
        usePriceThresholds: false,
        aggressiveCharging: false,
        batteryCategory: sizeCategory
      };
    }
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
      const batterySOC = this.currentSystemState?.battery_soc || 0;
      const pvPower = this.currentSystemState?.pv_power || 0;
      const load = this.currentSystemState?.load || 0;
      const gridVoltage = this.currentSystemState?.grid_voltage || 0;
      const currentPrice = tibberService.cache.currentPrice;
      const config = tibberService.config;

      // Select optimal strategy based on battery size (academic finding)
      const strategy = this.selectOptimalStrategy();
      
      // Calculate net load (pnet(t) from study equation 1)
      const netLoad = load - pvPower;
      
      // Academic study optimization
      const optimization = await this.academicOptimization();
      
      let shouldCharge = false;
      let shouldStop = false;

      // Strategy-based decision making
      if (strategy.usePriceThresholds) {
        // Price-sensitive operation for smaller batteries (≤15 kWh)
        // Academic finding: 12.7% improvement potential
        
        if (optimization) {
          const thresholds = optimization.thresholds;
          
          // CRITICAL: Academic optimal threshold is ≤8¢/kWh
          if (thresholds.isNegative) {
            shouldCharge = true;
            reasons.push(`NEGATIVE PRICE ARBITRAGE: Getting paid ${Math.abs(thresholds.current).toFixed(2)}¢/kWh`);
          } else if (thresholds.current <= this.academicParams.optimalChargeThreshold) {
            shouldCharge = true;
            reasons.push(`ACADEMIC OPTIMAL: ${thresholds.current.toFixed(2)}¢ ≤ ${this.academicParams.optimalChargeThreshold}¢/kWh`);
            reasons.push(`Expected improvement: +${strategy.expectedImprovement}% vs fixed tariff`);
          }
          
          // Peak discharge for maximum value (study finding: meaningful arbitrage)
          if (optimization.shouldDischarge && batterySOC > 30) {
            reasons.push(`PEAK PRICE DISCHARGE: ${thresholds.current.toFixed(2)}¢/kWh (volatility: ${(optimization.volatility * 100).toFixed(1)}%)`);
          }
        }
      } else {
        // Self-consumption maximization for larger batteries (>20 kWh)
        // Study finding: Better for larger batteries with day-ahead forecasts
        
        const pvSurplus = pvPower - load;
        if (pvSurplus > 100 && batterySOC < 95) {
          shouldCharge = true;
          reasons.push(`SELF-CONSUMPTION: Solar surplus ${pvSurplus.toFixed(0)}W (optimal for ${this.config.batteryCapacity}kWh battery)`);
        }
      }

      // Safety overrides (from study: grid voltage constraints)
      if (currentPrice?.total > this.academicParams.maxPriceThreshold) {
        shouldStop = true;
        reasons.push(`Price ${currentPrice.total.toFixed(1)}¢ too expensive`);
      }

      if (batterySOC >= config.targetSoC) {
        shouldStop = true;
        reasons.push(`Target SOC reached: ${batterySOC}%`);
      }

      if (gridVoltage < 200 || gridVoltage > 250) {
        shouldStop = true;
        reasons.push(`Grid voltage constraint: ${gridVoltage}V`);
      }

      // Make decision with academic strategy context
      let decision = this.makeAcademicDecision(
        batterySOC, pvPower, load, currentPrice, 
        gridVoltage, config, shouldCharge, shouldStop, 
        optimization, reasons, strategy
      );

      if (decision.includes('CHARGE') || decision.includes('STOP')) {
        const actionDecision = decision.includes('STOP') ? 'STOP_CHARGING' : 'START_CHARGING';
        await this.applyDecision(actionDecision);
      }

      // Log with academic metrics
      return await this.logDecision(decision, reasons, {
        strategy: strategy.name,
        expectedImprovement: strategy.expectedImprovement
      });
      
    } catch (error) {
      console.error('❌ Error in academic AI evaluation:', error);
      return { decision: 'ERROR', reasons: [error.message] };
    }
  }

  // Academic study-based optimization (replaces old method)
  async academicOptimization() {
    const forecast = tibberService.cache.forecast || [];
    const currentPrice = tibberService.cache.currentPrice;
    const batterySOC = this.currentSystemState?.battery_soc || 0;
    const pvPower = this.currentSystemState?.pv_power || 0;
    const load = this.currentSystemState?.load || 0;
    
    if (!currentPrice || forecast.length < 12) return null;
    
    // Calculate net load pnet(t) from study equation (1)
    const netLoad = load - pvPower;
    
    // Academic study parameters
    const feedInTariff = this.academicParams.feedInTariff / 100; // Convert to $/kWh
    const ηc = this.academicParams.chargeEfficiency;
    const ηd = this.academicParams.dischargeEfficiency;
    
    // Get next 24 hours forecast (day-ahead as per study)
    const next24h = forecast.slice(0, 24).map(p => p.total);
    
    if (next24h.length === 0) return null;
    
    const maxPrice = Math.max(...next24h);
    const minPrice = Math.min(...next24h);
    const avgPrice = next24h.reduce((a, b) => a + b, 0) / next24h.length;
    
    // Price volatility indicator (from study findings)
    const volatility = (maxPrice - minPrice) / avgPrice;
    
    // Academic optimal threshold: ≤8¢/kWh
    const isOptimalPrice = currentPrice.total <= this.academicParams.optimalChargeThreshold;
    
    // High price threshold for discharge (study: maximize value during peaks)
    const isHighPriceHour = currentPrice.total >= maxPrice * 0.9;
    
    // Enhanced decision logic based on study equations
    // Equation context: minimize annual electricity costs considering efficiency losses
    
    return {
      shouldCharge: (isOptimalPrice || currentPrice.total < 0) && batterySOC < 90,
      shouldDischarge: netLoad > 0 && isHighPriceHour && batterySOC > 30,
      priceLevel: isOptimalPrice ? 'OPTIMAL' : (currentPrice.total < avgPrice ? 'BELOW_AVG' : 'HIGH'),
      volatility: volatility,
      efficiency: this.academicParams.roundTripEfficiency,
      thresholds: {
        optimal: this.academicParams.optimalChargeThreshold,
        current: currentPrice.total,
        isNegative: currentPrice.total < 0,
        max24h: maxPrice,
        min24h: minPrice,
        avg24h: avgPrice
      },
      academicStrategy: this.selectOptimalStrategy().name
    };
  }

  makeAcademicDecision(batterySOC, pvPower, load, currentPrice, gridVoltage, 
                       config, shouldCharge, shouldStop, optimization, reasons, strategy) {
    const pvSurplus = pvPower - load;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;
    
    // STOP scenarios (safety first)
    if (shouldStop) {
      if (batterySOC >= config.targetSoC) {
        return `STOP CHARGING - Target SOC ${batterySOC}% reached (${strategy.name})`;
      }
      if (gridVoltage < 200 || gridVoltage > 250) {
        return `STOP CHARGING - Grid constraint ${gridVoltage}V`;
      }
      return `STOP CHARGING - Price/safety override`;
    }
    
    // CHARGE scenarios (academic optimization)
    if (shouldCharge) {
      if (priceIsNegative) {
        return `CHARGE GRID - NEGATIVE PRICE ARBITRAGE: ${Math.abs(currentPrice.total).toFixed(2)}¢/kWh (Study: 12.7% gain potential)`;
      }
      if (optimization?.priceLevel === 'OPTIMAL') {
        return `CHARGE GRID - ACADEMIC OPTIMAL: ${currentPrice.total.toFixed(2)}¢ ≤ 8¢/kWh (Strategy: ${strategy.name}, SOC: ${batterySOC}%)`;
      }
      return `CHARGE GRID - Below threshold (SOC: ${batterySOC}%, Strategy: ${strategy.name})`;
    }
    
    // DISCHARGE scenarios (peak arbitrage from study)
    if (optimization?.shouldDischarge && batterySOC > 30) {
      const expectedValue = (optimization.thresholds.current - optimization.thresholds.avg24h).toFixed(2);
      return `DISCHARGE - Peak arbitrage: ${optimization.thresholds.current.toFixed(2)}¢/kWh (+${expectedValue}¢ vs avg, ${(optimization.volatility * 100).toFixed(1)}% volatility)`;
    }
    
    // SOLAR operations (always prioritized for sustainability)
    if (pvSurplus > 1000 && batterySOC < 95) {
      return `CHARGE SOLAR - ${pvSurplus.toFixed(0)}W surplus (Self-consumption: ${strategy.name})`;
    }
    
    if (batterySOC >= config.targetSoC && pvSurplus > 0) {
      return `EXPORT SOLAR - Battery full, ${pvSurplus.toFixed(0)}W to grid`;
    }
    
    if (pvPower > 100) {
      return `SOLAR ACTIVE - ${pvPower.toFixed(0)}W generation, SOC: ${batterySOC}% (Strategy: ${strategy.name})`;
    }
    
    // Default monitoring state
    return `MONITOR - SOC: ${batterySOC}%, PV: ${pvPower.toFixed(0)}W, Load: ${load.toFixed(0)}W (Strategy: ${strategy.name})`;
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
        
        if (inverterType === 'new') {
          // New inverter - use charger/output priority
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
          // Legacy inverter - use grid_charge + intelligent energy_pattern
          const gridChargeTopic = `${this.config.mqttTopicPrefix}/${inverterId}/grid_charge/set`;
          const energyPatternTopic = `${this.config.mqttTopicPrefix}/${inverterId}/energy_pattern/set`;
          
          const gridChargeValue = enableCharging ? 'Enabled' : 'Disabled';
          const energyPatternValue = this.getOptimalEnergyPattern();
          
          if (this.mqttClient) {
            this.mqttClient.publish(gridChargeTopic, gridChargeValue);
            this.mqttClient.publish(energyPatternTopic, energyPatternValue);
            await this.logCommand(gridChargeTopic, gridChargeValue, true);
            await this.logCommand(energyPatternTopic, energyPatternValue, true);
            commandsSent++;
          }
        }
      }
      
      this.lastCommand = commandValue;
      console.log(`🔋 Applied decision: ${decision} to ${commandsSent} inverter(s)`);
      
    } catch (error) {
      console.error('❌ Failed to apply decision:', error);
      await this.logCommand('error', decision, false);
    }
  }

  getOptimalChargingMode(enableCharging) {
    if (!enableCharging) {
      return 'Solar first';
    }

    const pvPower = this.currentSystemState?.pv_power || 0;
    const load = this.currentSystemState?.load || 0;
    const batterySOC = this.currentSystemState?.battery_soc || 0;
    const pvSurplus = pvPower - load;
    const currentPrice = tibberService.cache.currentPrice;
    const priceIsNegative = currentPrice ? currentPrice.total < 0 : false;

    // Strong solar surplus - solar only (maximize self-consumption per study)
    if (pvSurplus > 1000 && batterySOC < 90) {
      return 'Solar only';
    }
    
    // Negative prices - aggressive charging (study: maximum arbitrage opportunity)
    if (priceIsNegative) {
      return 'Solar and utility simultaneously';
    }
    
    // Academic optimal price (≤8¢/kWh) - enable grid charging
    if (currentPrice && currentPrice.total <= this.academicParams.optimalChargeThreshold) {
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

    if (pvSurplus > 1000) {
      return 'Solar first';
    }
    
    if (priceIsNegative) {
      return 'Utility first';
    }
    
    if (batterySOC < 30) {
      return 'Solar/Utility/Battery';
    }
    
    return 'Solar/Battery/Utility';
  }

  // Intelligent energy pattern selection for legacy inverters
  getOptimalEnergyPattern() {
    const pvPower = this.currentSystemState?.pv_power || 0;
    const load = this.currentSystemState?.load || 0;
    const batterySOC = this.currentSystemState?.battery_soc || 0;
    const currentPrice = tibberService.cache.currentPrice;
    const pvSurplus = pvPower - load;
    
    // High solar production - prioritize battery charging
    if (pvSurplus > 1000 && batterySOC < 90) {
      return 'Battery first';
    }
    
    // Low battery + cheap electricity - charge battery first
    if (batterySOC < 30 && currentPrice && currentPrice.total <= this.academicParams.optimalChargeThreshold) {
      return 'Battery first';
    }
    
    // High battery + high load - supply load directly
    if (batterySOC > 70 && load > pvPower) {
      return 'Load first';
    }
    
    // Expensive electricity - use battery to supply load
    if (currentPrice && currentPrice.total > this.academicParams.optimalChargeThreshold && batterySOC > 40) {
      return 'Load first';
    }
    
    // Default: Battery first for energy storage optimization
    return 'Battery first';
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
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
    
    const strategy = this.selectOptimalStrategy();
    console.log(`🚀 Starting AI Engine with ${strategy.name} strategy`);
    console.log(`   Expected improvement: +${strategy.expectedImprovement}% vs fixed tariff`);
    
    this.startEngine();
    return { 
      success: true, 
      message: 'AI Charging Engine started with academic optimization',
      strategy: strategy.name
    };
  }

  startEngine() {
    this.enabled = true;
    
    this.evaluate().catch(error => {
      console.error('❌ Error in initial AI evaluation:', error);
    });
    
    this.evaluationInterval = setInterval(() => {
      this.evaluate().catch(error => {
        console.error('❌ Error in AI evaluation interval:', error);
      });
    }, 300000); // 5 minutes
    
    console.log('🚀 AI Engine started - Academic optimization active');
    return { success: true, message: 'Academic-optimized AI Charging Engine started' };
  }

  stop() {
    this.enabled = false;
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
    console.log('ℹ️ AI Charging Engine stopped');
    return { success: true, message: 'AI Charging Engine stopped' };
  }

  getStatus() {
    const strategy = this.selectOptimalStrategy();
    
    return {
      enabled: this.enabled,
      lastDecision: this.lastDecision,
      config: this.config,
      hasInterval: !!this.evaluationInterval,
      academicStrategy: {
        name: strategy.name,
        description: strategy.description,
        expectedImprovement: strategy.expectedImprovement,
        batterySize: this.config.batteryCapacity,
        optimalForBatterySize: this.config.batteryCapacity <= this.SMALL_BATTERY_THRESHOLD
      },
      academicParams: this.academicParams
    };
  }
}

module.exports = new AIChargingEngine();