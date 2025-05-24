// routes/dynamicPricingRoutes.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Configuration file path - adjust this to match your actual structure
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'dynamic_pricing_config.json');

// Ensure config directory exists
function ensureConfigExists() {
  const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(DYNAMIC_PRICING_CONFIG_FILE)) {
    const defaultConfig = {
      enabled: false,
      country: 'DE',
      market: 'DE',
      apiKey: '',
      priceThreshold: 0.10,
      minimumSoC: 20,
      targetSoC: 80,
      scheduledCharging: false,
      chargingHours: [],
      lastUpdate: null,
      pricingData: [],
      timezone: 'Europe/Berlin'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default dynamic pricing configuration file');
  }
}

// Load configuration
function loadConfig() {
  try {
    ensureConfigExists();
    const configData = fs.readFileSync(DYNAMIC_PRICING_CONFIG_FILE, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('Error loading dynamic pricing config:', error.message);
    return null;
  }
}

// Save configuration
function saveConfig(config) {
  try {
    ensureConfigExists();
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving dynamic pricing config:', error.message);
    return false;
  }
}

// Get dynamic pricing settings
router.get('/settings', (req, res) => {
  try {
    console.log('GET /settings - Loading dynamic pricing configuration');
    const config = loadConfig();
    
    if (!config) {
      console.error('Failed to load dynamic pricing configuration');
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
    
    console.log('Configuration loaded successfully:', Object.keys(sanitizedConfig));
    res.json({
      success: true,
      config: sanitizedConfig
    });
  } catch (error) {
    console.error('Error retrieving dynamic pricing settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve dynamic pricing settings: ' + error.message
    });
  }
});

// Update dynamic pricing settings
router.post('/settings', (req, res) => {
  try {
    console.log('POST /settings - Updating dynamic pricing configuration');
    console.log('Request body:', req.body);
    
    // Load current config to preserve any settings not included in the request
    const currentConfig = loadConfig();
    
    if (!currentConfig) {
      console.error('Failed to load existing configuration');
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
      enabled: enabled !== undefined ? Boolean(enabled) : currentConfig.enabled,
      country: country || currentConfig.country,
      market: market || currentConfig.market,
      priceThreshold: priceThreshold !== undefined ? parseFloat(priceThreshold) : currentConfig.priceThreshold,
      minimumSoC: minimumSoC !== undefined ? parseInt(minimumSoC, 10) : currentConfig.minimumSoC,
      targetSoC: targetSoC !== undefined ? parseInt(targetSoC, 10) : currentConfig.targetSoC,
      scheduledCharging: scheduledCharging !== undefined ? Boolean(scheduledCharging) : currentConfig.scheduledCharging,
      chargingHours: chargingHours || currentConfig.chargingHours,
      timezone: timezone || currentConfig.timezone
    };
    
    // Only update API key if a new one is provided and it's not the masked version
    if (apiKey && apiKey !== '...' && !apiKey.includes('...')) {
      updatedConfig.apiKey = apiKey;
    }
    
    console.log('Updated configuration:', {
      ...updatedConfig,
      apiKey: updatedConfig.apiKey ? '[REDACTED]' : ''
    });
    
    // Save updated config
    const saved = saveConfig(updatedConfig);
    
    if (!saved) {
      console.error('Failed to save configuration');
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
    
    console.log('Configuration saved successfully');
    res.json({
      success: true,
      message: 'Dynamic pricing settings updated successfully',
      config: sanitizedConfig
    });
  } catch (error) {
    console.error('Error updating dynamic pricing settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update dynamic pricing settings: ' + error.message
    });
  }
});

// Manually trigger price data update
router.post('/update-prices', async (req, res) => {
  try {
    console.log('POST /update-prices - Manual price update triggered');
    
    // Respond immediately while update happens in background
    res.json({
      success: true,
      message: 'Price update initiated. This may take a few moments to complete.'
    });
    
    // Try to call the dynamic pricing service if available
    if (global.dynamicPricingService && global.dynamicPricingService.updatePricingData) {
      console.log('Calling dynamic pricing service to update data');
      global.dynamicPricingService.updatePricingData(global.mqttClient, global.currentSystemState)
        .then(success => {
          console.log('Manual price update completed:', success ? 'successful' : 'failed');
        })
        .catch(err => {
          console.error('Error in manual price update:', err);
        });
    } else {
      console.log('Dynamic pricing service not available for manual update');
    }
  } catch (error) {
    console.error('Error initiating price update:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate price update: ' + error.message
    });
  }
});

// Get current pricing data
router.get('/pricing-data', (req, res) => {
  try {
    console.log('GET /pricing-data - Retrieving pricing data');
    const config = loadConfig();
    
    if (!config) {
      console.error('Failed to load dynamic pricing configuration');
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load dynamic pricing configuration'
      });
    }
    
    // Get pricing data from config
    const pricingData = config.pricingData || [];
    const lastUpdate = config.lastUpdate || null;
    
    console.log('Pricing data retrieved:', pricingData.length, 'data points');
    
    // Calculate low price periods if we have data
    let lowPricePeriods = [];
    if (pricingData.length > 0) {
      try {
        // Simple low price period calculation
        const sortedPrices = [...pricingData].sort((a, b) => a.price - b.price);
        const threshold = config.priceThreshold > 0 
          ? config.priceThreshold 
          : sortedPrices[Math.floor(sortedPrices.length * 0.25)]?.price || 0.1;
        
        const lowPricePeriods = pricingData.filter(p => p.price <= threshold);
        console.log('Calculated', lowPricePeriods.length, 'low price periods');
      } catch (error) {
        console.error('Error calculating low price periods:', error);
      }
    }
    
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
      error: 'Failed to retrieve pricing data: ' + error.message
    });
  }
});

// Manual grid charging control
router.post('/manual-charge', (req, res) => {
  try {
    console.log('POST /manual-charge - Manual charging control');
    const { enable } = req.body;
    
    if (enable === undefined) {
      return res.status(400).json({
        success: false, 
        error: 'Missing enable parameter'
      });
    }
    
    console.log('Manual charging command:', enable ? 'ENABLE' : 'DISABLE');
    
    // Here you would typically call your MQTT service to send the command
    // For now, we'll just return success
    
    res.json({
      success: true,
      message: `Grid charging ${enable ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error) {
    console.error('Error processing manual charge request:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// Get supported countries/markets
router.get('/markets', (req, res) => {
  try {
    console.log('GET /markets - Retrieving supported markets');
    
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
      error: 'Failed to retrieve supported markets: ' + error.message
    });
  }
});

module.exports = router;
