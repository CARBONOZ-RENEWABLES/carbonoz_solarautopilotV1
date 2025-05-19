// dynamicPricingRoutes.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const dynamicPricingService = require('../services/dynamicPricingService');

// Configuration file path (must match the one in the service)
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'dynamic_pricing_config.json');

// Get dynamic pricing settings
router.get('/settings', (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    
    if (!config) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load dynamic pricing configuration'
      });
    }
    
    // Remove API key from response for security
    const sanitizedConfig = { ...config };
    if (sanitizedConfig.apiKey) {
      sanitizedConfig.apiKey = sanitizedConfig.apiKey.substring(0, 4) + '...' + 
        (sanitizedConfig.apiKey.length > 8 ? sanitizedConfig.apiKey.substring(sanitizedConfig.apiKey.length - 4) : '');
    }
    
    res.json({
      success: true,
      config: sanitizedConfig
    });
  } catch (error) {
    console.error('Error retrieving dynamic pricing settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve dynamic pricing settings'
    });
  }
});

// Update dynamic pricing settings
router.post('/settings', (req, res) => {
  try {
    // Load current config to preserve any settings not included in the request
    const currentConfig = dynamicPricingService.loadConfig();
    
    if (!currentConfig) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load existing configuration'
      });
    }
    
    // Extract fields from request body
    const { 
      enabled, 
      country, 
      market, 
      apiKey, 
      priceThreshold,
      minimumSoC,
      targetSoC,
      scheduledCharging,
      chargingHours,
      timezone
    } = req.body;
    
    // Update config with new values, but only if they are provided
    const updatedConfig = {
      ...currentConfig,
      enabled: enabled !== undefined ? enabled : currentConfig.enabled,
      country: country || currentConfig.country,
      market: market || currentConfig.market,
      priceThreshold: priceThreshold !== undefined ? parseFloat(priceThreshold) : currentConfig.priceThreshold,
      minimumSoC: minimumSoC !== undefined ? parseInt(minimumSoC, 10) : currentConfig.minimumSoC,
      targetSoC: targetSoC !== undefined ? parseInt(targetSoC, 10) : currentConfig.targetSoC,
      scheduledCharging: scheduledCharging !== undefined ? scheduledCharging : currentConfig.scheduledCharging,
      chargingHours: chargingHours || currentConfig.chargingHours,
      timezone: timezone || currentConfig.timezone
    };
    
    // Only update API key if a new one is provided
    if (apiKey && apiKey !== '...') {
      updatedConfig.apiKey = apiKey;
    }
    
    // Save updated config
    const saved = dynamicPricingService.saveConfig(updatedConfig);
    
    if (!saved) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save configuration'
      });
    }
    
    // Return success with sanitized config
    const sanitizedConfig = { ...updatedConfig };
    if (sanitizedConfig.apiKey) {
      sanitizedConfig.apiKey = sanitizedConfig.apiKey.substring(0, 4) + '...' + 
        (sanitizedConfig.apiKey.length > 8 ? sanitizedConfig.apiKey.substring(sanitizedConfig.apiKey.length - 4) : '');
    }
    
    res.json({
      success: true,
      message: 'Dynamic pricing settings updated successfully',
      config: sanitizedConfig
    });
  } catch (error) {
    console.error('Error updating dynamic pricing settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update dynamic pricing settings'
    });
  }
});

// Manually trigger price data update
router.post('/update-prices', async (req, res) => {
  try {
    // This will trigger in the background and return immediately
    dynamicPricingService.updatePricingData(global.mqttClient, global.currentSystemState)
      .then(success => {
        console.log('Manual price update completed:', success ? 'successful' : 'failed');
      })
      .catch(err => {
        console.error('Error in manual price update:', err);
      });
    
    res.json({
      success: true,
      message: 'Price update initiated. This may take a few moments to complete.'
    });
  } catch (error) {
    console.error('Error initiating price update:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate price update'
    });
  }
});

// Get current pricing data
router.get('/pricing-data', (req, res) => {
  try {
    const config = dynamicPricingService.loadConfig();
    
    if (!config) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load dynamic pricing configuration'
      });
    }
    
    // Get pricing data from config
    const pricingData = config.pricingData || [];
    const lastUpdate = config.lastUpdate || null;
    
    // Calculate low price periods
    const lowPricePeriods = dynamicPricingService.determineLowPricePeriods(pricingData, config);
    
    res.json({
      success: true,
      pricingData,
      lowPricePeriods,
      lastUpdate
    });
  } catch (error) {
    console.error('Error retrieving pricing data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve pricing data'
    });
  }
});

// Get supported countries/markets
router.get('/markets', (req, res) => {
  try {
    // List of supported countries and markets
    const markets = [
      { code: 'DE', name: 'Germany', provider: 'aWATTar' },
      { code: 'AT', name: 'Austria', provider: 'aWATTar' },
      { code: 'FR', name: 'France', provider: 'ENTSO-E' },
      { code: 'ES', name: 'Spain', provider: 'ENTSO-E' },
      { code: 'IT', name: 'Italy', provider: 'ENTSO-E' },
      { code: 'UK', name: 'United Kingdom', provider: 'ENTSO-E' },
      { code: 'NL', name: 'Netherlands', provider: 'ENTSO-E' }
    ];
    
    // Get timezones list
    const timezones = [
      'Europe/Berlin',
      'Europe/London',
      'Europe/Paris',
      'Europe/Madrid',
      'Europe/Rome',
      'Europe/Vienna',
      'Europe/Amsterdam',
      'Europe/Brussels',
      'Europe/Zurich',
      'Europe/Copenhagen',
      'Europe/Stockholm',
      'Europe/Oslo',
      'Europe/Helsinki',
      'Europe/Athens',
      'Europe/Bucharest',
      'Europe/Istanbul'
    ];
    
    res.json({
      success: true,
      markets,
      timezones
    });
  } catch (error) {
    console.error('Error retrieving supported markets:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve supported markets'
    });
  }
});

module.exports = router;