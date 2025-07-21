// routes/dynamicPricingRoutes.js - ENHANCED WITH TIBBER AND SMART CONDITIONS

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Import services
const dynamicPricingService = require('../services/dynamicPricingService');
const pricingApis = require('../services/pricingApis');
const dynamicPricingMqtt = require('../services/dynamicPricingMqtt');

// Helper function to get inverter type summary
function getInverterTypeSummary() {
  try {
    if (!global.inverterTypes || Object.keys(global.inverterTypes).length === 0) {
      return {
        totalInverters: 0,
        typesSummary: {},
        detectionStatus: 'waiting for MQTT messages'
      };
    }
    
    const typesSummary = {};
    Object.values(global.inverterTypes).forEach(inverter => {
      const type = inverter.type || 'unknown';
      typesSummary[type] = (typesSummary[type] || 0) + 1;
    });
    
    return {
      totalInverters: Object.keys(global.inverterTypes).length,
      typesSummary: typesSummary,
      detectionStatus: 'detected'
    };
  } catch (error) {
    return {
      totalInverters: 0,
      typesSummary: {},
      detectionStatus: 'error'
    };
  }
}

// GET /api/dynamic-pricing/settings - Get enhanced configuration
router.get('/settings', (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    
    if (!config) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load enhanced configuration'
      });
    }
    
    // Sanitize API keys for security
    const sanitizedConfig = JSON.parse(JSON.stringify(config));
    if (sanitizedConfig.tibberApiKey) {
      const token = sanitizedConfig.tibberApiKey;
      sanitizedConfig.tibberApiKey = token.length > 8 
        ? token.substring(0, 8) + '...' + token.substring(token.length - 4)
        : token.substring(0, 4) + '...';
    }
    
    if (sanitizedConfig.weatherConditions?.weatherApiKey) {
      const key = sanitizedConfig.weatherConditions.weatherApiKey;
      sanitizedConfig.weatherConditions.weatherApiKey = key.length > 8 
        ? key.substring(0, 8) + '...' + key.substring(key.length - 4)
        : key.substring(0, 4) + '...';
    }
    
    // Add system status
    const systemState = global.currentSystemState || {};
    const status = dynamicPricingService.getStatus(config, systemState);
    const inverterInfo = getInverterTypeSummary();
    
    // Get current real-time price if available
    let currentPrice = null;
    if (config.tibberApiKey && config.priceBasedCharging?.useRealTibberPrices) {
      currentPrice = config.currentPrice || 'Loading...';
    }
    
    res.json({
      success: true,
      config: sanitizedConfig,
      status: status,
      provider: 'Enhanced Dynamic Pricing with Tibber',
      features: {
        tibberIntegration: true,
        smartPowerConditions: true,
        realTimePricing: true,
        weatherForecast: true,
        cooldownManagement: true,
        inverterTypeSupport: true,
        autoCommandMapping: true
      },
      inverterStatus: inverterInfo,
      currentPrice: currentPrice,
      learnerModeActive: dynamicPricingMqtt.isLearnerModeActive(),
      supportedCountries: pricingApis.getTibberCountriesAndCities()
    });
  } catch (error) {
    console.error('Error retrieving enhanced settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve enhanced settings: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/settings - Update enhanced configuration
router.post('/settings', async (req, res) => {
  try {
    const currentConfig = dynamicPricingService.loadConfig();
    
    if (!currentConfig) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load existing configuration'
      });
    }
    
    const {
      enabled,
      
      // Tibber integration
      tibberApiKey,
      country,
      city,
      timezone,
      
      // Price-based charging settings
      priceBasedCharging,
      
      // Battery settings
      battery,
      
      // Smart power conditions
      smartPowerConditions,
      
      // Weather conditions
      weatherConditions,
      
      // Time conditions
      timeConditions,
      
      // Cooldown settings
      cooldownSettings,
      
      // Scheduled charging
      scheduledCharging,
      chargingHours,
      
      // Manual override command
      gridChargingOverride
    } = req.body;
    
    // Handle manual grid charging override command first
    if (gridChargingOverride !== undefined) {
      console.log('Enhanced grid charging override:', gridChargingOverride ? 'ENABLE' : 'DISABLE');
      
      if (global.mqttClient && global.mqttClient.connected) {
        const success = await dynamicPricingService.sendGridChargeCommand(
          global.mqttClient, 
          gridChargingOverride, 
          currentConfig
        );
        
        const inverterInfo = getInverterTypeSummary();
        
        return res.json({
          success: success,
          message: `Enhanced grid charging ${gridChargingOverride ? 'enabled' : 'disabled'} ${success ? 'successfully' : 'failed'}`,
          inverterStatus: inverterInfo,
          enhanced: true
        });
      } else {
        return res.status(503).json({
          success: false,
          error: 'MQTT client not available for commands'
        });
      }
    }
    
    // Update configuration
    const updatedConfig = {
      ...currentConfig,
      enabled: enabled !== undefined ? Boolean(enabled) : currentConfig.enabled,
      
      // Tibber integration
      country: country || currentConfig.country,
      city: city || currentConfig.city,
      timezone: timezone || currentConfig.timezone,
      scheduledCharging: scheduledCharging !== undefined ? Boolean(scheduledCharging) : currentConfig.scheduledCharging,
      chargingHours: chargingHours || currentConfig.chargingHours
    };
    
    // Update Tibber API key if provided and not masked
    if (tibberApiKey && tibberApiKey !== '...' && !tibberApiKey.includes('...')) {
      updatedConfig.tibberApiKey = tibberApiKey;
    }
    
    // Update price-based charging settings
    if (priceBasedCharging) {
      updatedConfig.priceBasedCharging = {
        ...currentConfig.priceBasedCharging,
        ...priceBasedCharging
      };
    }
    
    // Update battery settings
    if (battery) {
      updatedConfig.battery = {
        ...currentConfig.battery,
        ...battery
      };
    }
    
    // Update smart power conditions
    if (smartPowerConditions) {
      updatedConfig.smartPowerConditions = {
        ...currentConfig.smartPowerConditions,
        ...smartPowerConditions
      };
    }
    
    // Update weather conditions with location
    if (weatherConditions) {
      const newWeatherConditions = {
        ...currentConfig.weatherConditions,
        ...weatherConditions
      };
      
      // Set location based on country/city
      if (updatedConfig.country && updatedConfig.city) {
        try {
          const location = pricingApis.getLocationByCountryCity(updatedConfig.country, updatedConfig.city);
          newWeatherConditions.location = location;
        } catch (locationError) {
          console.log('Location lookup failed:', locationError.message);
        }
      }
      
      updatedConfig.weatherConditions = newWeatherConditions;
    }
    
    // Update time conditions
    if (timeConditions) {
      updatedConfig.timeConditions = {
        ...currentConfig.timeConditions,
        ...timeConditions
      };
    }
    
    // Update cooldown settings
    if (cooldownSettings) {
      updatedConfig.cooldown = {
        ...currentConfig.cooldown,
        ...cooldownSettings
      };
    }
    
    // Clear old pricing data if country or Tibber settings changed
    if ((country && country !== currentConfig.country) || 
        (tibberApiKey && tibberApiKey !== currentConfig.tibberApiKey)) {
      console.log('Tibber settings changed, clearing old pricing data...');
      updatedConfig.pricingData = [];
      updatedConfig.currentPrice = null;
      updatedConfig.lastUpdate = null;
    }
    
    // Save the updated configuration
    const saved = dynamicPricingService.saveConfig(updatedConfig);
    
    if (!saved) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save enhanced configuration'
      });
    }
    
    // Sanitize response
    const sanitizedConfig = JSON.parse(JSON.stringify(updatedConfig));
    if (sanitizedConfig.tibberApiKey) {
      const token = sanitizedConfig.tibberApiKey;
      sanitizedConfig.tibberApiKey = token.length > 8 
        ? token.substring(0, 8) + '...' + token.substring(token.length - 4)
        : token.substring(0, 4) + '...';
    }
    
    if (sanitizedConfig.weatherConditions?.weatherApiKey) {
      const key = sanitizedConfig.weatherConditions.weatherApiKey;
      sanitizedConfig.weatherConditions.weatherApiKey = key.length > 8 
        ? key.substring(0, 8) + '...' + key.substring(key.length - 4)
        : key.substring(0, 4) + '...';
    }
    
    // Get status
    const systemState = global.currentSystemState || {};
    const status = dynamicPricingService.getStatus(updatedConfig, systemState);
    const inverterInfo = getInverterTypeSummary();
    
    res.json({
      success: true,
      message: 'Enhanced dynamic pricing settings updated successfully',
      config: sanitizedConfig,
      status: status,
      provider: 'Enhanced Dynamic Pricing with Tibber',
      features: {
        tibberIntegration: true,
        smartPowerConditions: true,
        realTimePricing: true,
        weatherForecast: true,
        cooldownManagement: true,
        inverterTypeSupport: true,
        autoCommandMapping: true
      },
      inverterStatus: inverterInfo
    });
  } catch (error) {
    console.error('Error updating enhanced settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update enhanced settings: ' + error.message
    });
  }
});

// GET /api/dynamic-pricing/current-price - Get real-time current price
router.get('/current-price', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    
    if (!config || !config.enabled) {
      return res.json({
        success: false,
        error: 'Enhanced dynamic pricing is disabled'
      });
    }
    
    if (!config.tibberApiKey) {
      return res.json({
        success: false,
        error: 'Tibber API key not configured'
      });
    }
    
    const currentPrice = await pricingApis.getTibberCurrentPrice(config);
    
    // Update config with current price
    config.currentPrice = currentPrice;
    dynamicPricingService.saveConfig(config);
    
    res.json({
      success: true,
      currentPrice: currentPrice,
      timestamp: new Date().toISOString(),
      provider: 'Tibber Real-time'
    });
  } catch (error) {
    console.error('Error getting current price:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get current price: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/test-tibber - Test Tibber API connection
router.post('/test-tibber', async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey || apiKey.includes('...')) {
      return res.status(400).json({
        success: false,
        error: 'Valid Tibber API key is required'
      });
    }
    
    const testResult = await pricingApis.testTibberConnection(apiKey);
    
    res.json(testResult);
  } catch (error) {
    console.error('Error testing Tibber connection:', error);
    res.status(500).json({
      success: false,
      error: 'Test failed: ' + error.message
    });
  }
});

// GET /api/dynamic-pricing/countries-cities - Get supported countries and cities
router.get('/countries-cities', (req, res) => {
  try {
    const countriesData = pricingApis.getTibberCountriesAndCities();
    res.json(countriesData);
  } catch (error) {
    console.error('Error getting countries/cities:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get countries and cities: ' + error.message
    });
  }
});

// GET /api/dynamic-pricing/recommendation - Get enhanced charging recommendation
router.get('/recommendation', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    
    if (!config || !config.enabled) {
      return res.json({
        success: true,
        recommendation: {
          shouldCharge: false,
          reason: 'Enhanced dynamic pricing is disabled',
          details: null,
          enhanced: true
        }
      });
    }
    
    const systemState = global.currentSystemState || {};
    const decision = await dynamicPricingService.shouldChargeNow(config, systemState);
    
    // Get additional status information
    const status = dynamicPricingService.getStatus(config, systemState);
    const inverterInfo = getInverterTypeSummary();
    
    res.json({
      success: true,
      recommendation: {
        shouldCharge: decision.shouldCharge,
        reason: decision.reason,
        details: decision.details,
        priority: decision.priority,
        enhanced: true,
        tibberIntegration: !!config.tibberApiKey,
        smartPowerRules: config.smartPowerConditions?.enabled || false
      },
      status: status,
      inverterStatus: inverterInfo,
      learnerModeActive: dynamicPricingMqtt.isLearnerModeActive()
    });
  } catch (error) {
    console.error('Error generating enhanced recommendation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate recommendation: ' + error.message
    });
  }
});

// GET /api/dynamic-pricing/status - Get detailed enhanced status
router.get('/status', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    const systemState = global.currentSystemState || {};
    const status = dynamicPricingService.getStatus(config, systemState);
    const inverterInfo = getInverterTypeSummary();
    
    // Get current decision without executing
    let currentDecision = null;
    if (config && config.enabled) {
      try {
        currentDecision = await dynamicPricingService.shouldChargeNow(config, systemState);
      } catch (error) {
        console.error('Error getting current decision:', error);
      }
    }
    
    res.json({
      success: true,
      status: {
        ...status,
        currentDecision: currentDecision
      },
      systemState: {
        battery_soc: systemState.battery_soc || 0,
        pv_power: systemState.pv_power || 0,
        load: systemState.load || 0,
        grid_power: systemState.grid_power || 0,
        grid_voltage: systemState.grid_voltage || 0,
        battery_power: systemState.battery_power || 0, // ADDED BATTERY POWER
        timestamp: systemState.timestamp || new Date().toISOString()
      },
      provider: 'Enhanced Dynamic Pricing with Tibber',
      features: {
        tibberIntegration: true,
        smartPowerConditions: true,
        realTimePricing: true,
        weatherForecast: true,
        cooldownManagement: true,
        inverterTypeSupport: true,
        autoCommandMapping: true,
        userDefinedRules: true // NEW FEATURE
      },
      inverterStatus: inverterInfo,
      learnerModeActive: dynamicPricingMqtt.isLearnerModeActive()
    });
  } catch (error) {
    console.error('Error getting enhanced status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get status: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/test-conditions - Test specific enhanced conditions
router.post('/test-conditions', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    const systemState = global.currentSystemState || {};
    const { testType } = req.body;
    
    let testResult = {};
    
    switch (testType) {
      case 'weather':
        if (config.weatherConditions?.enabled) {
          testResult = await dynamicPricingService.testWeatherAPI(config);
        } else {
          testResult = { success: false, error: 'Weather conditions are disabled' };
        }
        break;
        
      case 'time':
        testResult = dynamicPricingService.checkTimeConditions(config);
        break;
        
      case 'smartpower':
      case 'power':
        testResult = dynamicPricingService.checkSmartPowerConditions(config, systemState);
        break;
        
      case 'price':
        testResult = await dynamicPricingService.checkPriceConditions(config);
        break;
        
      case 'cooldown':
        testResult = {
          inCooldown: dynamicPricingService.isInCooldown(config),
          status: dynamicPricingService.getStatus(config, systemState).cooldown
        };
        break;
        
      case 'tibber':
        if (config.tibberApiKey) {
          try {
            const currentPrice = await pricingApis.getTibberCurrentPrice(config);
            testResult = { 
              success: true, 
              currentPrice: currentPrice,
              message: 'Tibber API connection successful'
            };
          } catch (tibberError) {
            testResult = { 
              success: false, 
              error: tibberError.message 
            };
          }
        } else {
          testResult = { 
            success: false, 
            error: 'Tibber API key not configured' 
          };
        }
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid test type. Use: weather, time, smartpower, price, cooldown, or tibber'
        });
    }
    
    res.json({
      success: true,
      testType: testType,
      result: testResult,
      systemState: {
        ...systemState,
        battery_power: systemState.battery_power || 0 // ENSURE BATTERY POWER IS INCLUDED
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error testing enhanced conditions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test conditions: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/manual-charge - Enhanced manual charging with logic
router.post('/manual-charge', async (req, res) => {
  try {
    const { enable, force } = req.body;
    
    if (enable === undefined) {
      return res.status(400).json({
        success: false, 
        error: 'Missing enable parameter'
      });
    }
    
    console.log('Enhanced manual charging command:', enable ? 'ENABLE' : 'DISABLE', force ? '(FORCED)' : '');
    
    if (global.mqttClient && global.mqttClient.connected) {
      const config = dynamicPricingService.loadConfig();
      
      // Check enhanced conditions unless forced
      if (!force && enable) {
        const systemState = global.currentSystemState || {};
        const decision = await dynamicPricingService.shouldChargeNow(config, systemState);
        
        if (!decision.shouldCharge) {
          return res.json({
            success: false,
            message: `Enhanced conditions not met for charging: ${decision.reason}`,
            recommendation: decision,
            canForce: true,
            enhanced: true
          });
        }
      }
      
      const success = await dynamicPricingService.sendGridChargeCommand(
        global.mqttClient, 
        enable, 
        config
      );
      
      const inverterInfo = getInverterTypeSummary();
      
      res.json({
        success: success,
        message: `Enhanced grid charging ${enable ? 'enabled' : 'disabled'} ${success ? 'successfully' : 'failed'} ${force ? '(forced)' : 'with condition checking'}`,
        enhanced: true,
        tibberIntegration: !!config.tibberApiKey,
        inverterStatus: inverterInfo,
        learnerModeActive: dynamicPricingMqtt.isLearnerModeActive()
      });
    } else {
      res.status(503).json({
        success: false,
        error: 'MQTT client not available for commands'
      });
    }
  } catch (error) {
    console.error('Error processing enhanced manual charge request:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// GET /api/dynamic-pricing/actions-log - Get enhanced actions log
router.get('/actions-log', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    const logFile = path.join(__dirname, '..', 'logs', 'dynamic_pricing.log');
    
    if (!fs.existsSync(logFile)) {
      const inverterInfo = getInverterTypeSummary();
      
      return res.json({
        success: true,
        actions: [],
        enhanced: true,
        tibberIntegration: true,
        inverterStatus: inverterInfo
      });
    }
    
    const logContent = fs.readFileSync(logFile, 'utf8');
    const logLines = logContent.split('\n').filter(line => line.trim() !== '');
    
    const recentLines = logLines.slice(-limit).reverse();
    
    const actions = recentLines.map(line => {
      const parts = line.split(' - ');
      if (parts.length >= 2) {
        return {
          timestamp: parts[0],
          action: parts.slice(1).join(' - '),
          enhanced: true
        };
      }
      return {
        timestamp: new Date().toISOString(),
        action: line,
        enhanced: true
      };
    });
    
    const inverterInfo = getInverterTypeSummary();
    
    res.json({
      success: true,
      actions,
      provider: 'Enhanced Dynamic Pricing with Tibber',
      enhanced: true,
      tibberIntegration: true,
      inverterStatus: inverterInfo,
      learnerModeActive: dynamicPricingMqtt.isLearnerModeActive()
    });
  } catch (error) {
    console.error('Error retrieving enhanced actions log:', error);
    res.json({
      success: true,
      actions: [],
      enhanced: true,
      error: error.message
    });
  }
});

// GET /api/dynamic-pricing/pricing-data - Get current pricing data with Tibber integration
router.get('/pricing-data', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    let pricingData = config?.pricingData || [];
    
    // Try to get fresh data from Tibber if enabled
    if (config.tibberApiKey && config.priceBasedCharging?.useRealTibberPrices) {
      try {
        const freshData = await pricingApis.fetchTibberPrices(config);
        if (freshData && freshData.length > 0) {
          pricingData = freshData;
          
          // Update config with fresh data
          config.pricingData = freshData;
          config.lastUpdate = new Date().toISOString();
          dynamicPricingService.saveConfig(config);
        }
      } catch (tibberError) {
        console.log('Failed to get fresh Tibber data, using cached:', tibberError.message);
      }
    }
    
    // Get the next 24 hours of data
    const now = new Date();
    const next24Hours = pricingData.filter(item => {
      const itemTime = new Date(item.timestamp);
      const hoursDiff = (itemTime - now) / (1000 * 60 * 60);
      return hoursDiff >= -1 && hoursDiff <= 24; // Include current hour and next 24
    });
    
    res.json({
      success: true,
      data: next24Hours,
      total: pricingData.length,
      lastUpdate: config?.lastUpdate || null,
      country: config?.country || 'Unknown',
      city: config?.city || 'Unknown',
      currency: config?.currency || 'EUR',
      provider: config.tibberApiKey ? 'Tibber' : 'Sample Data',
      enhanced: true,
      tibberIntegration: !!config.tibberApiKey
    });
  } catch (error) {
    console.error('Error retrieving enhanced pricing data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve pricing data: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/refresh-prices - Force refresh Tibber prices
router.post('/refresh-prices', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    
    if (!config.tibberApiKey) {
      return res.status(400).json({
        success: false,
        error: 'Tibber API key not configured'
      });
    }
    
    const freshData = await pricingApis.fetchTibberPrices(config);
    
    if (freshData && freshData.length > 0) {
      config.pricingData = freshData;
      config.lastUpdate = new Date().toISOString();
      
      // Also get current price
      try {
        config.currentPrice = await pricingApis.getTibberCurrentPrice(config);
      } catch (currentPriceError) {
        console.log('Failed to get current price:', currentPriceError.message);
      }
      
      dynamicPricingService.saveConfig(config);
      
      res.json({
        success: true,
        message: `Successfully refreshed ${freshData.length} price points from Tibber`,
        dataPoints: freshData.length,
        lastUpdate: config.lastUpdate,
        currentPrice: config.currentPrice
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'No data returned from Tibber API'
      });
    }
  } catch (error) {
    console.error('Error refreshing Tibber prices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh prices: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/test-weather - Test weather API
router.post('/test-weather', async (req, res) => {
  try {
    const { weatherApiKey, country, city } = req.body;
    
    if (!weatherApiKey) {
      return res.status(400).json({
        success: false,
        error: 'Weather API key is required'
      });
    }
    
    // Create test config
    const testConfig = {
      weatherConditions: {
        enabled: true,
        weatherApiKey: weatherApiKey
      },
      country: country,
      city: city
    };
    
    // If country/city provided, get location
    if (country && city) {
      try {
        testConfig.weatherConditions.location = pricingApis.getLocationByCountryCity(country, city);
      } catch (locationError) {
        return res.status(400).json({
          success: false,
          error: 'Invalid country/city combination: ' + locationError.message
        });
      }
    }
    
    const testResult = await dynamicPricingService.testWeatherAPI(testConfig);
    
    res.json(testResult);
  } catch (error) {
    console.error('Error testing weather API:', error);
    res.status(500).json({
      success: false,
      error: 'Weather API test failed: ' + error.message
    });
  }
});

// POST /api/dynamic-pricing/smart-power-rule - Add user smart power rule
router.post('/smart-power-rule', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    const { rule } = req.body;
    
    if (!rule || !rule.name || !rule.conditions) {
      return res.status(400).json({
        success: false,
        error: 'Rule must have name and conditions'
      });
    }
    
    const ruleId = dynamicPricingService.addUserSmartPowerRule(config, rule);
    const saved = dynamicPricingService.saveConfig(config);
    
    if (saved) {
      res.json({
        success: true,
        message: 'Smart power rule added successfully',
        ruleId: ruleId
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save rule'
      });
    }
  } catch (error) {
    console.error('Error adding smart power rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add rule: ' + error.message
    });
  }
});

// PUT /api/dynamic-pricing/smart-power-rule/:ruleId - Update user smart power rule
router.put('/smart-power-rule/:ruleId', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    const { ruleId } = req.params;
    const { rule } = req.body;
    
    const updated = dynamicPricingService.updateUserSmartPowerRule(config, ruleId, rule);
    
    if (updated) {
      const saved = dynamicPricingService.saveConfig(config);
      if (saved) {
        res.json({
          success: true,
          message: 'Smart power rule updated successfully'
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to save updated rule'
        });
      }
    } else {
      res.status(404).json({
        success: false,
        error: 'Rule not found'
      });
    }
  } catch (error) {
    console.error('Error updating smart power rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update rule: ' + error.message
    });
  }
});

// DELETE /api/dynamic-pricing/smart-power-rule/:ruleId - Delete user smart power rule
router.delete('/smart-power-rule/:ruleId', async (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    const { ruleId } = req.params;
    
    const removed = dynamicPricingService.removeUserSmartPowerRule(config, ruleId);
    
    if (removed) {
      const saved = dynamicPricingService.saveConfig(config);
      if (saved) {
        res.json({
          success: true,
          message: 'Smart power rule deleted successfully'
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to save after deletion'
        });
      }
    } else {
      res.status(404).json({
        success: false,
        error: 'Rule not found'
      });
    }
  } catch (error) {
    console.error('Error deleting smart power rule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete rule: ' + error.message
    });
  }
});

module.exports = router;