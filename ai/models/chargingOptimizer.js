// Reinforcement Learning Charging Optimizer
// Learns optimal charging strategies from outcomes

class ChargingOptimizer {
  constructor() {
    this.qTable = new Map(); // State-action Q-values
    this.rewardHistory = [];
    this.maxRewardHistory = 500; // Limit reward history to save memory
    this.learningRate = 0.1;
    this.discountFactor = 0.95;
    this.explorationRate = 0.1;
    this.trained = false;
    
    // Academic study parameters
    this.academicParams = {
      chargeThreshold: 8, // ¢/kWh
      maxPrice: 10,       // ¢/kWh
      efficiency: 0.95,   // Round-trip efficiency
      socMin: 20,         // Minimum SOC %
      socMax: 100,        // Maximum SOC %
      socTarget: 80       // Target SOC %
    };
    
    this.actions = [
      'CHARGE_GRID',
      'CHARGE_SOLAR',
      'DISCHARGE',
      'HOLD',
      'STOP_CHARGING'
    ];
  }

  async train(historicalData, tibberService) {
    console.log('🧠 Training charging optimizer with reinforcement learning...');
    
    if (!historicalData.solar || historicalData.solar.length < 100) {
      console.log('⚠️  Insufficient data for RL training');
      return false;
    }

    // Simulate historical scenarios and learn from outcomes
    await this.simulateHistoricalScenarios(historicalData, tibberService);
    
    this.trained = true;
    console.log(`✅ Charging optimizer trained with ${this.rewardHistory.length} scenarios`);
    return true;
  }

  async simulateHistoricalScenarios(historicalData, tibberService) {
    const scenarios = this.createScenarios(historicalData);
    
    for (const scenario of scenarios) {
      const state = this.encodeState(scenario);
      const action = this.selectAction(state, true); // Training mode
      const reward = this.calculateReward(scenario, action);
      
      this.updateQTable(state, action, reward);
      this.rewardHistory.push({ scenario, action, reward });
      
      // Limit reward history to prevent memory leaks
      if (this.rewardHistory.length > this.maxRewardHistory) {
        this.rewardHistory = this.rewardHistory.slice(-this.maxRewardHistory);
      }
    }
  }

  createScenarios(historicalData) {
    const scenarios = [];
    
    // Create training scenarios from historical data
    for (let i = 0; i < historicalData.solar.length - 24; i += 6) { // Every 6 hours
      const scenario = {
        timestamp: historicalData.solar[i].timestamp,
        currentSOC: Math.random() * 60 + 20, // Random SOC 20-80%
        solarPower: historicalData.solar[i].power || 0,
        loadPower: historicalData.load[i]?.power || 500,
        gridPrice: (Math.random() * 15 + 5), // Random price 5-20¢
        batteryCapacity: 15, // kWh
        
        // Future 24h data for reward calculation
        futureSolar: historicalData.solar.slice(i, i + 24),
        futureLoad: historicalData.load.slice(i, i + 24),
        futurePrices: this.generatePriceScenario(24)
      };
      
      scenarios.push(scenario);
    }
    
    return scenarios.slice(0, 200); // Reduced from 1000 to 200 to save memory
  }

  generatePriceScenario(hours) {
    // Generate realistic price scenario
    const prices = [];
    let basePrice = Math.random() * 10 + 8; // 8-18¢ base
    
    for (let h = 0; h < hours; h++) {
      // Add daily pattern (higher in evening)
      const hour = h % 24;
      let hourlyMultiplier = 1.0;
      if (hour >= 18 && hour <= 21) hourlyMultiplier = 1.3; // Evening peak
      if (hour >= 2 && hour <= 5) hourlyMultiplier = 0.7;   // Night low
      
      // Add some randomness
      const noise = (Math.random() - 0.5) * 0.4;
      const price = basePrice * hourlyMultiplier * (1 + noise);
      
      prices.push({
        total: Math.max(2, price), // Minimum 2¢
        level: price < 8 ? 'CHEAP' : price > 15 ? 'EXPENSIVE' : 'NORMAL'
      });
    }
    
    return prices;
  }

  encodeState(scenario) {
    // Encode state into discrete buckets for Q-table
    const socBucket = Math.floor(scenario.currentSOC / 10); // 0-9 (10% buckets)
    const priceBucket = Math.floor(scenario.gridPrice / 2); // 0-10 (2¢ buckets)
    const solarBucket = Math.floor(scenario.solarPower / 1000); // 0-10 (1kW buckets)
    const loadBucket = Math.floor(scenario.loadPower / 500); // 0-10 (500W buckets)
    const hour = new Date(scenario.timestamp).getHours();
    const hourBucket = Math.floor(hour / 4); // 0-5 (4-hour buckets)
    
    return `${socBucket}-${priceBucket}-${solarBucket}-${loadBucket}-${hourBucket}`;
  }

  selectAction(state, training = false) {
    // Epsilon-greedy action selection
    if (training && Math.random() < this.explorationRate) {
      // Random exploration
      return this.actions[Math.floor(Math.random() * this.actions.length)];
    }
    
    // Greedy selection based on Q-values
    if (!this.qTable.has(state)) {
      this.qTable.set(state, new Map());
    }
    
    const stateActions = this.qTable.get(state);
    let bestAction = this.actions[0];
    let bestValue = -Infinity;
    
    for (const action of this.actions) {
      const qValue = stateActions.get(action) || 0;
      if (qValue > bestValue) {
        bestValue = qValue;
        bestAction = action;
      }
    }
    
    return bestAction;
  }

  calculateReward(scenario, action) {
    // Multi-objective reward function - returns savings in cents per hour
    let reward = 0;
    const price = scenario.gridPrice; // ¢/kWh
    const batteryCapacity = scenario.batteryCapacity || 10; // kWh
    
    // 1. Cost savings (primary objective) - calculate actual monetary value
    const costReward = this.calculateCostReward(scenario, action);
    reward += costReward;
    
    // 2. Battery health (secondary) - small monetary equivalent
    const batteryReward = this.calculateBatteryHealthReward(scenario, action);
    reward += batteryReward * 0.5; // Convert to cents
    
    // 3. Self-consumption (tertiary) - feed-in tariff savings
    const selfConsumptionReward = this.calculateSelfConsumptionReward(scenario, action);
    reward += selfConsumptionReward;
    
    // 4. Grid stability (bonus) - small incentive
    const stabilityReward = this.calculateStabilityReward(scenario, action);
    reward += stabilityReward * 0.2;
    
    return reward; // Returns cents per hour
  }

  calculateCostReward(scenario, action) {
    const price = scenario.gridPrice; // ¢/kWh
    const solarPower = scenario.solarPower; // W
    const loadPower = scenario.loadPower; // W
    const batteryCapacity = scenario.batteryCapacity || 10; // kWh
    const chargePower = Math.min(3000, batteryCapacity * 1000 * 0.5); // Max 3kW or 0.5C rate
    
    switch (action) {
      case 'CHARGE_GRID':
        // Calculate actual cost savings from charging at low prices
        if (price <= this.academicParams.chargeThreshold) {
          // Savings = (average_price - current_price) * charge_power
          const avgPrice = 12; // Assume 12¢/kWh average
          const hourlySavings = (avgPrice - price) * (chargePower / 1000);
          return Math.max(0, hourlySavings);
        } else if (price <= this.academicParams.maxPrice) {
          return -2; // Small penalty for suboptimal charging
        } else {
          return -price * (chargePower / 1000); // Cost of expensive charging
        }
        
      case 'CHARGE_SOLAR':
        // Savings from avoiding grid purchase
        const solarSurplus = solarPower - loadPower;
        if (solarSurplus > 100) {
          const feedInTariff = 8; // ¢/kWh feed-in tariff
          const gridPrice = 12; // ¢/kWh grid price
          return (gridPrice - feedInTariff) * (Math.min(solarSurplus, chargePower) / 1000);
        }
        return 0;
        
      case 'DISCHARGE':
        // Savings from avoiding grid purchase during high prices
        if (price > 15 || loadPower > solarPower + 500) {
          const dischargePower = Math.min(3000, loadPower - solarPower);
          return price * (dischargePower / 1000) * 0.95; // 95% efficiency
        }
        return 0;
        
      case 'HOLD':
        return 0; // No cost or savings
        
      case 'STOP_CHARGING':
        // Savings from avoiding expensive charging
        if (price > this.academicParams.maxPrice) {
          return price * (chargePower / 1000) * 0.1; // Small savings from avoiding cost
        }
        return 0;
        
      default:
        return 0;
    }
  }

  calculateBatteryHealthReward(scenario, action) {
    const soc = scenario.currentSOC;
    
    // Penalize extreme SOC levels
    if (soc < this.academicParams.socMin) {
      return action === 'CHARGE_GRID' || action === 'CHARGE_SOLAR' ? 2 : -3;
    }
    
    if (soc > 95) {
      return action === 'STOP_CHARGING' || action === 'HOLD' ? 1 : -2;
    }
    
    // Reward keeping SOC in healthy range (30-80%)
    if (soc >= 30 && soc <= 80) {
      return 1;
    }
    
    return 0;
  }

  calculateSelfConsumptionReward(scenario, action) {
    const solarPower = scenario.solarPower;
    const loadPower = scenario.loadPower;
    const solarSurplus = solarPower - loadPower;
    
    if (solarSurplus > 100 && action === 'CHARGE_SOLAR') {
      return 3; // Good self-consumption
    }
    
    if (solarPower > 0 && action === 'DISCHARGE' && loadPower > solarPower) {
      return 2; // Using battery to supplement solar
    }
    
    return 0;
  }

  calculateStabilityReward(scenario, action) {
    // Reward actions that help grid stability
    const hour = new Date(scenario.timestamp).getHours();
    
    // Avoid charging during peak hours (18-21)
    if (hour >= 18 && hour <= 21 && action === 'CHARGE_GRID') {
      return -1;
    }
    
    // Reward off-peak charging (2-5 AM)
    if (hour >= 2 && hour <= 5 && action === 'CHARGE_GRID') {
      return 1;
    }
    
    return 0;
  }

  updateQTable(state, action, reward) {
    if (!this.qTable.has(state)) {
      this.qTable.set(state, new Map());
    }
    
    const stateActions = this.qTable.get(state);
    const currentQ = stateActions.get(action) || 0;
    
    // Q-learning update rule: Q(s,a) = Q(s,a) + α[r + γ*max(Q(s',a')) - Q(s,a)]
    // Simplified without next state (episodic)
    const newQ = currentQ + this.learningRate * (reward - currentQ);
    
    stateActions.set(action, newQ);
  }

  async optimize(optimizationInput) {
    const {
      currentState,
      batteryCapacity,
      solarForecast,
      loadForecast,
      priceForecast,
      patterns
    } = optimizationInput;

    // Create current scenario
    const scenario = {
      timestamp: new Date(),
      currentSOC: currentState.battery_soc || 50,
      solarPower: currentState.pv_power || 0,
      loadPower: currentState.load || 500,
      gridPrice: priceForecast[0]?.total || 10,
      batteryCapacity,
      futureSolar: solarForecast,
      futureLoad: loadForecast,
      futurePrices: priceForecast
    };

    // Get optimal action
    const state = this.encodeState(scenario);
    const action = this.selectAction(state, false); // Production mode
    
    // Calculate expected outcomes
    const expectedReward = this.calculateReward(scenario, action);
    const confidence = this.calculateActionConfidence(state, action);
    
    // Generate detailed decision
    const decision = this.generateDecision(scenario, action, expectedReward, patterns);
    
    return {
      type: decision.type,
      action: decision.action || action,
      reason: decision.reason,
      expectedSavings: decision.expectedSavings || '0',
      confidence,
      reasoning: this.explainDecision(scenario, action),
      alternatives: this.getAlternativeActions(state)
    };
  }

  generateDecision(scenario, action, expectedReward, patterns) {
    const soc = scenario.currentSOC;
    const price = scenario.gridPrice;
    const solar = scenario.solarPower;
    const load = scenario.loadPower;
    
    switch (action) {
      case 'CHARGE_GRID':
        return {
          type: 'CHARGE',
          action: 'CHARGE_GRID',
          source: 'GRID',
          reason: `Optimal grid charging at ${price.toFixed(1)}¢/kWh (SOC: ${soc.toFixed(0)}%)`,
          priority: 'HIGH',
          expectedSavings: expectedReward > 0 ? `¢${expectedReward.toFixed(1)}/h` : `¢${expectedReward.toFixed(1)}/h`
        };
        
      case 'CHARGE_SOLAR':
        return {
          type: 'CHARGE',
          action: 'CHARGE_SOLAR',
          source: 'SOLAR',
          reason: `Solar surplus charging: ${(solar - load).toFixed(0)}W available`,
          priority: 'HIGH',
          expectedSavings: `¢${expectedReward.toFixed(1)}/h`
        };
        
      case 'DISCHARGE':
        return {
          type: 'DISCHARGE',
          action: 'DISCHARGE',
          source: 'BATTERY',
          reason: `Peak discharge at ${price.toFixed(1)}¢/kWh (SOC: ${soc.toFixed(0)}%)`,
          priority: 'MEDIUM',
          expectedSavings: `¢${expectedReward.toFixed(1)}/h`
        };
        
      case 'HOLD':
        return {
          type: 'HOLD',
          action: 'HOLD',
          source: 'NONE',
          reason: `Waiting for better conditions (SOC: ${soc.toFixed(0)}%)`,
          priority: 'LOW',
          expectedSavings: '¢0.0/h'
        };
        
      case 'STOP_CHARGING':
        return {
          type: 'STOP',
          action: 'STOP_CHARGING',
          source: 'NONE',
          reason: `Stop charging - price too high (${price.toFixed(1)}¢/kWh) or battery full`,
          priority: 'HIGH',
          expectedSavings: '¢0.0/h'
        };
        
      default:
        return {
          type: 'MONITOR',
          action: 'MONITOR',
          source: 'NONE',
          reason: 'Monitoring conditions',
          priority: 'LOW',
          expectedSavings: '¢0.0/h'
        };
    }
  }

  explainDecision(scenario, action) {
    const reasons = [];
    const price = scenario.gridPrice;
    const soc = scenario.currentSOC;
    const solar = scenario.solarPower;
    const load = scenario.loadPower;
    
    // Price-based reasoning
    if (price <= this.academicParams.chargeThreshold) {
      reasons.push(`Excellent price: ${price.toFixed(1)}¢ ≤ ${this.academicParams.chargeThreshold}¢ threshold`);
    } else if (price > this.academicParams.maxPrice) {
      reasons.push(`Price too high: ${price.toFixed(1)}¢ > ${this.academicParams.maxPrice}¢ limit`);
    }
    
    // SOC-based reasoning
    if (soc < this.academicParams.socMin) {
      reasons.push(`Low battery: ${soc.toFixed(0)}% < ${this.academicParams.socMin}% minimum`);
    } else if (soc > 90) {
      reasons.push(`Battery nearly full: ${soc.toFixed(0)}%`);
    }
    
    // Solar-based reasoning
    const solarSurplus = solar - load;
    if (solarSurplus > 100) {
      reasons.push(`Solar surplus available: ${solarSurplus.toFixed(0)}W`);
    } else if (solar > 0) {
      reasons.push(`Solar active: ${solar.toFixed(0)}W generation`);
    }
    
    // Action-specific reasoning
    switch (action) {
      case 'CHARGE_GRID':
        reasons.push('AI learned: Grid charging optimal now');
        break;
      case 'CHARGE_SOLAR':
        reasons.push('AI learned: Maximize self-consumption');
        break;
      case 'DISCHARGE':
        reasons.push('AI learned: Peak arbitrage opportunity');
        break;
    }
    
    return reasons;
  }

  calculateActionConfidence(state, action) {
    if (!this.qTable.has(state)) return 0.3;
    
    const stateActions = this.qTable.get(state);
    const qValue = stateActions.get(action) || 0;
    
    // Calculate confidence based on Q-value and training data
    const maxQ = Math.max(...Array.from(stateActions.values()));
    const minQ = Math.min(...Array.from(stateActions.values()));
    
    if (maxQ === minQ) return 0.5; // No clear preference
    
    const normalizedQ = (qValue - minQ) / (maxQ - minQ);
    return Math.min(0.95, 0.3 + normalizedQ * 0.6);
  }

  getAlternativeActions(state) {
    if (!this.qTable.has(state)) return [];
    
    const stateActions = this.qTable.get(state);
    const alternatives = [];
    
    for (const [action, qValue] of stateActions.entries()) {
      alternatives.push({ action, qValue: qValue.toFixed(2) });
    }
    
    return alternatives.sort((a, b) => b.qValue - a.qValue);
  }

  async updateRewards(outcomeData) {
    // Learn from actual outcomes
    const actualReward = this.calculateActualReward(outcomeData);
    this.rewardHistory.push({
      timestamp: outcomeData.timestamp,
      actualReward,
      cost: outcomeData.cost
    });
    
    // Limit reward history to prevent memory leaks
    if (this.rewardHistory.length > this.maxRewardHistory) {
      this.rewardHistory = this.rewardHistory.slice(-this.maxRewardHistory);
    }
    
    // Adjust learning if needed
    if (this.rewardHistory.length > 100) {
      this.adjustLearningRate();
    }
  }

  calculateActualReward(outcomeData) {
    // Calculate reward based on actual outcomes
    let reward = 0;
    
    // Cost savings
    if (outcomeData.cost < 0) {
      reward += Math.abs(outcomeData.cost) * 10; // Earned money
    } else {
      reward -= outcomeData.cost * 5; // Spent money
    }
    
    // Self-consumption bonus
    if (outcomeData.selfConsumption > 0.8) {
      reward += 5;
    }
    
    return reward;
  }

  adjustLearningRate() {
    // Adaptive learning rate based on performance
    const recentRewards = this.rewardHistory.slice(-50);
    const avgReward = recentRewards.reduce((sum, r) => sum + r.actualReward, 0) / recentRewards.length;
    
    if (avgReward > 0) {
      this.learningRate *= 0.95; // Reduce learning rate when performing well
    } else {
      this.learningRate *= 1.05; // Increase when performing poorly
    }
    
    this.learningRate = Math.max(0.01, Math.min(0.3, this.learningRate));
  }

  getStatus() {
    return {
      trained: this.trained,
      qTableSize: this.qTable.size,
      rewardHistory: this.rewardHistory.length,
      learningRate: this.learningRate,
      explorationRate: this.explorationRate,
      avgReward: this.rewardHistory.length > 0 ? 
        this.rewardHistory.slice(-100).reduce((sum, r) => sum + r.reward, 0) / Math.min(100, this.rewardHistory.length) : 0
    };
  }
}

module.exports = ChargingOptimizer;