// AI-Powered Solar Charging Optimizer
// Pattern-based learning without weather APIs

const SolarPredictor = require('./models/solarPredictor');
const LoadForecaster = require('./models/loadForecaster');
const ChargingOptimizer = require('./models/chargingOptimizer');
const PatternDetector = require('./models/patternDetector');
const DataProcessor = require('./utils/dataProcessor');

class AIChargingSystem {
  constructor() {
    this.solarPredictor = new SolarPredictor();
    this.loadForecaster = new LoadForecaster();
    this.chargingOptimizer = new ChargingOptimizer();
    this.patternDetector = new PatternDetector();
    this.dataProcessor = new DataProcessor();
    
    this.initialized = false;
    this.learningMode = true;
    this.lastPrediction = null;
    this.performanceMetrics = {
      solarAccuracy: 0,
      loadAccuracy: 0,
      costSavings: 0,
      selfConsumption: 0
    };
  }

  async initialize(influxClient, tibberService) {
    try {
      console.log('🤖 Initializing AI Charging System...');
      
      this.influx = influxClient;
      this.tibber = tibberService;
      
      // Load historical data for training
      const historicalData = await this.dataProcessor.loadHistoricalData(influxClient, 365);
      
      if (historicalData.solar.length < 100) {
        console.log('⚠️  Insufficient historical data - AI will learn as it operates');
        this.learningMode = true;
      } else {
        console.log(`✅ Loaded ${historicalData.solar.length} days of historical data`);
        
        // Train models with historical data
        await this.trainModels(historicalData);
        this.learningMode = false;
      }
      
      this.initialized = true;
      console.log('🚀 AI Charging System initialized successfully');
      
      return { success: true, learningMode: this.learningMode };
    } catch (error) {
      console.error('❌ Failed to initialize AI system:', error);
      return { success: false, error: error.message };
    }
  }

  async trainModels(historicalData) {
    console.log('🧠 Training AI models...');
    
    // Train solar predictor
    await this.solarPredictor.train(historicalData.solar);
    console.log('✅ Solar predictor trained');
    
    // Train load forecaster
    await this.loadForecaster.train(historicalData.load);
    console.log('✅ Load forecaster trained');
    
    // Detect patterns
    await this.patternDetector.analyzePatterns(historicalData);
    console.log('✅ Pattern detection complete');
    
    // Train charging optimizer
    await this.chargingOptimizer.train(historicalData, this.tibber);
    console.log('✅ Charging optimizer trained');
  }

  async makePredictions(currentState, batteryCapacity) {
    if (!this.initialized) {
      throw new Error('AI system not initialized');
    }

    const now = new Date();
    
    // Generate solar forecast (next 24-48 hours)
    const solarForecast = await this.solarPredictor.predict(now, 48);
    
    // Generate load forecast
    const loadForecast = await this.loadForecaster.predict(now, 48);
    
    // Get price forecast from Tibber
    const priceForecast = this.tibber.cache.forecast || [];
    
    // Optimize charging strategy
    const chargingDecision = await this.chargingOptimizer.optimize({
      currentState,
      batteryCapacity,
      solarForecast,
      loadForecast,
      priceForecast,
      patterns: this.patternDetector.getRelevantPatterns(now)
    });

    this.lastPrediction = {
      timestamp: now,
      solar: solarForecast,
      load: loadForecast,
      charging: chargingDecision,
      confidence: this.calculateConfidence()
    };

    return this.lastPrediction;
  }

  async learnFromOutcome(actualSolar, actualLoad, actualCost) {
    if (!this.lastPrediction) return;

    // Update model accuracy
    const solarError = Math.abs(actualSolar - this.lastPrediction.solar[0].power) / actualSolar;
    const loadError = Math.abs(actualLoad - this.lastPrediction.load[0].power) / actualLoad;
    
    this.performanceMetrics.solarAccuracy = 1 - solarError;
    this.performanceMetrics.loadAccuracy = 1 - loadError;
    
    // Retrain models with new data if in learning mode
    if (this.learningMode) {
      await this.incrementalLearning(actualSolar, actualLoad, actualCost);
    }
  }

  async incrementalLearning(actualSolar, actualLoad, actualCost) {
    // Add new data point to models
    const dataPoint = {
      timestamp: new Date(),
      solar: actualSolar,
      load: actualLoad,
      cost: actualCost
    };
    
    await this.solarPredictor.updateModel(dataPoint);
    await this.loadForecaster.updateModel(dataPoint);
    await this.chargingOptimizer.updateRewards(dataPoint);
  }

  calculateConfidence() {
    const baseConfidence = this.learningMode ? 0.3 : 0.8;
    const accuracyBonus = (this.performanceMetrics.solarAccuracy + this.performanceMetrics.loadAccuracy) / 2 * 0.2;
    
    return Math.min(baseConfidence + accuracyBonus, 0.95);
  }

  getStatus() {
    return {
      initialized: this.initialized,
      learningMode: this.learningMode,
      performance: this.performanceMetrics,
      lastPrediction: this.lastPrediction ? {
        timestamp: this.lastPrediction.timestamp,
        confidence: this.lastPrediction.confidence
      } : null,
      models: {
        solar: this.solarPredictor.getStatus(),
        load: this.loadForecaster.getStatus(),
        optimizer: this.chargingOptimizer.getStatus(),
        patterns: this.patternDetector.getStatus()
      }
    };
  }
}

module.exports = AIChargingSystem;