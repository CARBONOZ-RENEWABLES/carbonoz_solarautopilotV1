// AI System Management Routes

const express = require('express');
const router = express.Router();

// AI System Status
router.get('/ai/status', async (req, res) => {
  try {
    const aiChargingEngine = require('../services/aiChargingEngine');
    const status = aiChargingEngine.getStatus();
    
    res.json({
      success: true,
      ai: status.ai,
      performance: status.ai?.status?.performance || {},
      models: status.ai?.status?.models || {},
      lastPrediction: status.ai?.status?.lastPrediction || null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// AI Predictions
router.get('/ai/predictions', async (req, res) => {
  try {
    const aiChargingEngine = require('../services/aiChargingEngine');
    
    if (!aiChargingEngine.aiEnabled || !aiChargingEngine.aiInitialized) {
      return res.json({
        success: false,
        error: 'AI system not initialized'
      });
    }
    
    const currentState = aiChargingEngine.currentSystemState;
    const batteryCapacity = aiChargingEngine.config.batteryCapacity;
    
    const predictions = await aiChargingEngine.aiSystem.makePredictions(currentState, batteryCapacity);
    
    res.json({
      success: true,
      predictions: {
        solar: predictions.solar.slice(0, 24), // Next 24 hours
        load: predictions.load.slice(0, 24),
        charging: predictions.charging,
        confidence: predictions.confidence,
        timestamp: predictions.timestamp
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// AI Training Data Quality
router.get('/ai/data-quality', async (req, res) => {
  try {
    const aiChargingEngine = require('../services/aiChargingEngine');
    
    if (!aiChargingEngine.aiInitialized) {
      return res.json({
        success: false,
        error: 'AI system not initialized'
      });
    }
    
    const dataProcessor = aiChargingEngine.aiSystem.dataProcessor;
    
    // Load recent data quality assessment
    const historicalData = await dataProcessor.loadHistoricalData(global.influx, 30);
    
    res.json({
      success: true,
      dataQuality: historicalData.statistics.dataQuality,
      statistics: {
        solar: historicalData.statistics.solar,
        load: historicalData.statistics.load,
        price: historicalData.statistics.price,
        battery: historicalData.statistics.battery
      },
      timeRange: historicalData.timeRange,
      correlations: historicalData.statistics.correlations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// AI Model Performance
router.get('/ai/performance', async (req, res) => {
  try {
    const aiChargingEngine = require('../services/aiChargingEngine');
    
    if (!aiChargingEngine.aiInitialized) {
      return res.json({
        success: false,
        error: 'AI system not initialized'
      });
    }
    
    const aiStatus = aiChargingEngine.aiSystem.getStatus();
    
    res.json({
      success: true,
      performance: aiStatus.performance,
      models: {
        solar: aiStatus.models.solar,
        load: aiStatus.models.load,
        optimizer: aiStatus.models.optimizer,
        patterns: aiStatus.models.patterns
      },
      learningMode: aiStatus.learningMode,
      initialized: aiStatus.initialized
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Toggle AI System
router.post('/ai/toggle', async (req, res) => {
  try {
    const aiChargingEngine = require('../services/aiChargingEngine');
    const { enabled } = req.body;
    
    if (enabled && !aiChargingEngine.aiInitialized) {
      // Try to initialize AI system
      const aiResult = await aiChargingEngine.aiSystem.initialize(global.influx, require('../services/tibberService'));
      if (aiResult.success) {
        aiChargingEngine.aiInitialized = true;
        aiChargingEngine.aiEnabled = true;
      } else {
        return res.json({
          success: false,
          error: 'Failed to initialize AI system'
        });
      }
    } else {
      aiChargingEngine.aiEnabled = enabled;
    }
    
    res.json({
      success: true,
      aiEnabled: aiChargingEngine.aiEnabled,
      aiInitialized: aiChargingEngine.aiInitialized,
      message: `AI system ${enabled ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clear AI Cache and Retrain
router.post('/ai/retrain', async (req, res) => {
  try {
    const aiChargingEngine = require('../services/aiChargingEngine');
    
    if (!aiChargingEngine.aiInitialized) {
      return res.json({
        success: false,
        error: 'AI system not initialized'
      });
    }
    
    // Clear cache and retrain
    aiChargingEngine.aiSystem.dataProcessor.clearCache();
    
    const aiResult = await aiChargingEngine.aiSystem.initialize(global.influx, require('../services/tibberService'));
    
    res.json({
      success: aiResult.success,
      message: aiResult.success ? 'AI system retrained successfully' : 'Retraining failed',
      learningMode: aiResult.learningMode
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;