// routes/dynamicPricingRoutes.js - TIBBER API ROUTES

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Import the Tibber pricing APIs
const pricingApis = require('../services/pricingApis');

// Configuration file path
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
      apiKey: '', // Tibber API token
      priceThreshold: 0, // Use automatic threshold
      minimumSoC: 20,
      targetSoC: 80,
      scheduledCharging: false,
      chargingHours: [],
      lastUpdate: null,
      pricingData: [],
      timezone: 'Europe/Berlin',
      useTibberLevels: true,
      lowPriceLevels: ['VERY_CHEAP', 'CHEAP'],
      currency: 'EUR'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default Tibber dynamic pricing configuration');
  }
}

// Load configuration
function loadConfig() {
  try {
    ensureConfigExists();
    const configData = fs.readFileSync(DYNAMIC_PRICING_CONFIG_FILE, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('Error loading Tibber dynamic pricing config:', error.message);
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
    console.error('Error saving Tibber dynamic pricing config:', error.message);
    return false;
  }
}

// Helper function to check if data is stale
function isDataStale(lastUpdateString) {
  if (!lastUpdateString) return true;
  
  const lastUpdate = new Date(lastUpdateString);
  const now = new Date();
  const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
  
  return hoursSinceUpdate > 4; // Consider data stale if older than 4 hours
}

// Helper function to get country names
function getCountryName(countryCode) {
  const countryNames = {
    'NO': 'Norway',
    'SE': 'Sweden', 
    'DK': 'Denmark',
    'FI': 'Finland',
    'DE': 'Germany',
    'NL': 'Netherlands'
  };
  
  return countryNames[countryCode] || countryCode;
}

// API Routes

// Get available countries and timezones (Tibber supported countries)
router.get('/countries-timezones', (req, res) => {
  try {
    const supportedCountries = pricingApis.getSupportedCountries();
    const timezones = [...new Set(supportedCountries.map(country => country.timezone))].sort();
    
    const countries = supportedCountries.map(country => ({
      code: country.code,
      name: getCountryName(country.code),
      timezone: country.timezone,
      currency: country.currency,
      market: 'Tibber'
    }));
    
    res.json({
      success: true,
      countries: countries,
      timezones: timezones,
      provider: 'Tibber'
    });
  } catch (error) {
    console.error('Error getting Tibber countries and timezones:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get countries and timezones: ' + error.message
    });
  }
});

// Get dynamic pricing settings
router.get('/settings', (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load Tibber dynamic pricing configuration'
      });
    }
    
    // Sanitize API token for security
    const sanitizedConfig = { ...config };
    if (sanitizedConfig.apiKey) {
      const token = sanitizedConfig.apiKey;
      sanitizedConfig.apiKey = token.length > 8 
        ? token.substring(0, 8) + '...' + token.substring(token.length - 4)
        : token.substring(0, 4) + '...';
    }
    
    res.json({
      success: true,
      config: sanitizedConfig,
      provider: 'Tibber'
    });
  } catch (error) {
    console.error('Error retrieving Tibber dynamic pricing settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve dynamic pricing settings: ' + error.message
    });
  }
});

// Update dynamic pricing settings
router.post('/settings', async (req, res) => {
  try {
    const currentConfig = loadConfig();
    
    if (!currentConfig) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load existing configuration'
      });
    }
    
    const { 
      enabled, 
      country, 
      apiKey, 
      priceThreshold,
      minimumSoC,
      targetSoC,
      scheduledCharging,
      chargingHours,
      timezone,
      useTibberLevels,
      lowPriceLevels,
      gridChargingOverride
    } = req.body;
    
    // Handle manual grid charging override command
    if (gridChargingOverride !== undefined) {
      console.log('Tibber grid charging override command:', gridChargingOverride ? 'ENABLE' : 'DISABLE');
      
      if (global.mqttClient && global.mqttClient.connected) {
        const dynamicPricingMqtt = require('../services/dynamicPricingMqtt');
        const success = dynamicPricingMqtt.sendGridChargeCommand(global.mqttClient, gridChargingOverride, currentConfig);
        
        return res.json({
          success: success,
          message: `Tibber grid charging ${gridChargingOverride ? 'enabled' : 'disabled'} ${success ? 'successfully' : 'failed'}`
        });
      } else {
        return res.status(503).json({
          success: false,
          error: 'MQTT client not available'
        });
      }
    }
    
    // Update configuration
    const updatedConfig = {
      ...currentConfig,
      enabled: enabled !== undefined ? Boolean(enabled) : currentConfig.enabled,
      country: country || currentConfig.country,
      priceThreshold: priceThreshold !== undefined ? parseFloat(priceThreshold) : currentConfig.priceThreshold,
      minimumSoC: minimumSoC !== undefined ? parseInt(minimumSoC, 10) : currentConfig.minimumSoC,
      targetSoC: targetSoC !== undefined ? parseInt(targetSoC, 10) : currentConfig.targetSoC,
      scheduledCharging: scheduledCharging !== undefined ? Boolean(scheduledCharging) : currentConfig.scheduledCharging,
      chargingHours: chargingHours || currentConfig.chargingHours,
      timezone: timezone || currentConfig.timezone,
      useTibberLevels: useTibberLevels !== undefined ? Boolean(useTibberLevels) : (currentConfig.useTibberLevels !== undefined ? currentConfig.useTibberLevels : true),
      lowPriceLevels: lowPriceLevels || currentConfig.lowPriceLevels || ['VERY_CHEAP', 'CHEAP']
    };
    
    // Update API token if provided and not masked
    if (apiKey && apiKey !== '...' && !apiKey.includes('...')) {
      updatedConfig.apiKey = apiKey;
    }
    
    // If country or timezone changed, clear old pricing data
    if ((country && country !== currentConfig.country) || (timezone && timezone !== currentConfig.timezone)) {
      console.log(`Country/timezone changed, clearing old Tibber pricing data...`);
      updatedConfig.pricingData = [];
      updatedConfig.lastUpdate = null;
    }
    
    const saved = saveConfig(updatedConfig);
    
    if (!saved) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to save configuration'
      });
    }
    
    // Sanitize response
    const sanitizedConfig = { ...updatedConfig };
    if (sanitizedConfig.apiKey) {
      const token = sanitizedConfig.apiKey;
      sanitizedConfig.apiKey = token.length > 8 
        ? token.substring(0, 8) + '...' + token.substring(token.length - 4)
        : token.substring(0, 4) + '...';
    }
    
    res.json({
      success: true,
      message: 'Tibber dynamic pricing settings updated successfully',
      config: sanitizedConfig,
      provider: 'Tibber'
    });
  } catch (error) {
    console.error('Error updating Tibber dynamic pricing settings:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update dynamic pricing settings: ' + error.message
    });
  }
});

// Get pricing data with automatic refresh
router.get('/pricing-data', async (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to load configuration'
      });
    }

    let pricingData = config.pricingData || [];
    const lastUpdate = config.lastUpdate;
    const timezone = config.timezone || 'Europe/Berlin';
    
    // Check if data needs refreshing
    const needsRefresh = !lastUpdate || !pricingData.length || isDataStale(lastUpdate);
    
    // Automatically refresh if needed and API key is available
    if (needsRefresh) {
      console.log(`Tibber pricing data is stale, fetching fresh data...`);
      
      if (config.apiKey && config.apiKey.trim() !== '') {
        try {
          console.log(`Fetching real Tibber pricing data for ${config.country}...`);
          pricingData = await pricingApis.fetchElectricityPrices(config);
          
          if (pricingData && pricingData.length > 0) {
            console.log(`✅ Retrieved ${pricingData.length} real Tibber price points`);
            
            // Update currency and timezone from real data
            if (pricingData[0].currency) config.currency = pricingData[0].currency;
            if (pricingData[0].timezone) config.timezone = pricingData[0].timezone;
            
            // Update config with new data
            config.pricingData = pricingData;
            config.lastUpdate = new Date().toISOString();
            saveConfig(config);
          } else {
            throw new Error('No real data returned from Tibber API');
          }
        } catch (realDataError) {
          console.log(`❌ Tibber data fetch failed: ${realDataError.message}`);
          
          // Don't generate sample data - return error instead
          return res.status(503).json({
            success: false,
            error: `Failed to fetch real Tibber data: ${realDataError.message}. Please check your API token and try again.`,
            needsApiKey: true
          });
        }
      } else {
        // No API key provided and no existing data
        if (pricingData.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'No Tibber API token configured and no existing pricing data available. Please configure your Tibber API token.',
            needsApiKey: true
          });
        }
      }
    }
    
    // Calculate low price periods using Tibber intelligence
    const lowPricePeriods = pricingApis.determineLowPricePeriods(pricingData, config);
    
    // Determine data source
    const isRealData = pricingData.length > 0 && pricingData[0].source === 'real';
    
    // Add Tibber-specific information
    const tibberInfo = {
      hasLevels: pricingData.some(p => p.level),
      useLevelBasedCharging: config.useTibberLevels,
      lowPriceLevels: config.lowPriceLevels || ['VERY_CHEAP', 'CHEAP']
    };
    
    console.log(`Tibber pricing data served: ${pricingData.length} ${isRealData ? 'REAL' : 'SAMPLE'} data points, ${lowPricePeriods.length} low price periods for timezone ${timezone}`);
    
    res.json({
      success: true,
      pricingData,
      lowPricePeriods,
      lastUpdate: config.lastUpdate,
      timezone: timezone,
      autoRefreshed: needsRefresh,
      dataSource: isRealData ? 'real' : 'sample',
      hasApiKey: !!(config.apiKey && config.apiKey.trim() !== ''),
      provider: 'Tibber',
      tibberInfo,
      currency: config.currency || 'EUR'
    });
  } catch (error) {
    console.error('Error retrieving Tibber pricing data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve pricing data: ' + error.message
    });
  }
});

// Manual price update
router.post('/update-prices', async (req, res) => {
  try {
    const config = loadConfig();
    if (!config) {
      return res.status(500).json({
        success: false,
        error: 'Failed to load configuration'
      });
    }
    
    const timezone = config.timezone || 'Europe/Berlin';
    
    console.log(`Manual Tibber price update requested for country: ${config.country}, timezone: ${timezone}`);
    
    let pricingData = [];
    let dataSource = 'real';
    
    if (!config.apiKey || config.apiKey.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Tibber API token is required for fetching real pricing data. Please configure your API token first.',
        needsApiKey: true
      });
    }
    
    try {
      console.log(`Fetching real Tibber pricing data using API token...`);
      pricingData = await pricingApis.fetchElectricityPrices(config);
      
      if (pricingData && pricingData.length > 0) {
        dataSource = 'real';
        console.log(`✅ Manual update: Retrieved ${pricingData.length} real Tibber price points`);
        
        // Update currency and timezone from real data
        if (pricingData[0].currency) config.currency = pricingData[0].currency;
        if (pricingData[0].timezone) config.timezone = pricingData[0].timezone;
      } else {
        throw new Error('No real data returned from Tibber API');
      }
    } catch (realDataError) {
      console.log(`❌ Tibber data fetch failed: ${realDataError.message}`);
      
      return res.status(503).json({
        success: false,
        error: `Failed to fetch Tibber pricing data: ${realDataError.message}. Please check your API token and internet connection.`,
        needsApiKey: true
      });
    }
    
    // Update config
    config.pricingData = pricingData;
    config.lastUpdate = new Date().toISOString();
    saveConfig(config);
    
    console.log(`Manual Tibber pricing data update completed for timezone ${timezone} with ${pricingData.length} ${dataSource} data points`);
    
    res.json({
      success: true,
      message: `Tibber price update completed. ${dataSource === 'real' ? 'Real data retrieved from Tibber API' : 'Sample data generated'}.`,
      dataSource: dataSource,
      dataPoints: pricingData.length,
      provider: 'Tibber',
      currency: config.currency
    });
  } catch (error) {
    console.error('Error updating Tibber prices:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update prices: ' + error.message
    });
  }
});

// Manual grid charging control
router.post('/manual-charge', (req, res) => {
  try {
    const { enable } = req.body;
    
    if (enable === undefined) {
      return res.status(400).json({
        success: false, 
        error: 'Missing enable parameter'
      });
    }
    
    console.log('Manual Tibber charging command:', enable ? 'ENABLE' : 'DISABLE');
    
    if (global.mqttClient && global.mqttClient.connected) {
      const dynamicPricingMqtt = require('../services/dynamicPricingMqtt');
      const config = loadConfig();
      const success = dynamicPricingMqtt.sendGridChargeCommand(global.mqttClient, enable, config);
      
      res.json({
        success: success,
        message: `Tibber grid charging ${enable ? 'enabled' : 'disabled'} ${success ? 'successfully' : 'failed'}`
      });
    } else {
      res.status(503).json({
        success: false,
        error: 'MQTT client not available'
      });
    }
  } catch (error) {
    console.error('Error processing manual Tibber charge request:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// Get current recommendation using Tibber data
router.get('/recommendation', (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config || !config.enabled) {
      return res.json({
        success: true,
        recommendation: {
          shouldCharge: false,
          reason: 'Tibber dynamic pricing is disabled',
          details: null
        }
      });
    }
    
    const batterySoC = global.currentSystemState?.battery_soc || 0;
    const pricingData = config.pricingData || [];
    const timezone = config.timezone || 'Europe/Berlin';
    
    let shouldCharge = false;
    let reason = '';
    let details = null;
    
    if (batterySoC >= config.targetSoC) {
      shouldCharge = false;
      reason = 'Battery SoC has reached target level';
      details = { batterySoC, targetSoC: config.targetSoC };
    } else if (batterySoC < config.minimumSoC) {
      shouldCharge = true;
      reason = 'Battery SoC below minimum level';
      details = { batterySoC, minimumSoC: config.minimumSoC };
    } else if (pricingData.length > 0) {
      const now = new Date();
      const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: timezone}));
      
      const currentPrice = pricingData.find(p => {
        const priceTime = new Date(p.timestamp);
        const priceInTimezone = new Date(priceTime.toLocaleString("en-US", {timeZone: timezone}));
        
        return nowInTimezone.getHours() === priceInTimezone.getHours() && 
               nowInTimezone.getDate() === priceInTimezone.getDate() &&
               nowInTimezone.getMonth() === priceInTimezone.getMonth();
      });
      
      if (currentPrice) {
        // Use Tibber price levels if available
        if (currentPrice.level && config.useTibberLevels) {
          const lowPriceLevels = config.lowPriceLevels || ['VERY_CHEAP', 'CHEAP'];
          const isLowPrice = lowPriceLevels.includes(currentPrice.level);
          
          if (isLowPrice) {
            shouldCharge = true;
            reason = `Current electricity price level is favorable (${currentPrice.level})`;
            details = { 
              batterySoC, 
              currentPrice: currentPrice.price, 
              priceLevel: currentPrice.level,
              currency: currentPrice.currency,
              timezone, 
              dataSource: currentPrice.source,
              provider: 'Tibber'
            };
          } else {
            shouldCharge = false;
            reason = `Current electricity price level is not optimal (${currentPrice.level})`;
            details = { 
              batterySoC, 
              currentPrice: currentPrice.price, 
              priceLevel: currentPrice.level,
              currency: currentPrice.currency,
              timezone, 
              dataSource: currentPrice.source,
              provider: 'Tibber'
            };
          }
        } else {
          // Fallback to threshold-based
          const lowPricePeriods = pricingApis.determineLowPricePeriods(pricingData, config);
          const isInLowPricePeriod = lowPricePeriods.some(period => {
            const start = new Date(period.start);
            const end = new Date(period.end);
            return now >= start && now < end;
          });
          
          if (isInLowPricePeriod) {
            shouldCharge = true;
            reason = 'Current electricity price is below threshold';
            details = { 
              batterySoC, 
              currentPrice: currentPrice.price, 
              currency: currentPrice.currency,
              timezone, 
              dataSource: currentPrice.source,
              provider: 'Tibber'
            };
          } else {
            shouldCharge = false;
            reason = 'Current electricity price is above threshold';
            details = { 
              batterySoC, 
              currentPrice: currentPrice.price, 
              currency: currentPrice.currency,
              timezone, 
              dataSource: currentPrice.source,
              provider: 'Tibber'
            };
          }
        }
      } else {
        shouldCharge = false;
        reason = 'No Tibber price data available for current hour';
        details = { batterySoC, timezone, provider: 'Tibber' };
      }
    } else {
      shouldCharge = false;
      reason = 'No Tibber pricing data available';
      details = { batterySoC, timezone, provider: 'Tibber' };
    }
    
    res.json({
      success: true,
      recommendation: {
        shouldCharge,
        reason,
        details
      }
    });
  } catch (error) {
    console.error('Error generating Tibber recommendation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate recommendation: ' + error.message
    });
  }
});

// Get pricing summary with Tibber-specific information
router.get('/pricing-summary', (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config) {
      return res.status(500).json({
        success: false,
        error: 'Failed to load configuration'
      });
    }
    
    const pricingData = config.pricingData || [];
    const timezone = config.timezone || 'Europe/Berlin';
    
    if (pricingData.length === 0) {
      return res.json({
        success: true,
        summary: {
          currentPrice: null,
          currentLevel: null,
          averagePrice: null,
          lowestPrice: null,
          highestPrice: null,
          pricesAvailable: false,
          timezone: timezone,
          dataSource: 'none',
          provider: 'Tibber',
          currency: config.currency || 'EUR'
        }
      });
    }
    
    const now = new Date();
    const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: timezone}));
    
    const currentPrice = pricingData.find(p => {
      const priceTime = new Date(p.timestamp);
      const priceInTimezone = new Date(priceTime.toLocaleString("en-US", {timeZone: timezone}));
      
      return nowInTimezone.getHours() === priceInTimezone.getHours() && 
             nowInTimezone.getDate() === priceInTimezone.getDate() &&
             nowInTimezone.getMonth() === priceInTimezone.getMonth();
    });
    
    const prices = pricingData.map(p => p.price);
    const averagePrice = prices.reduce((acc, price) => acc + price, 0) / prices.length;
    const lowestPrice = Math.min(...prices);
    const highestPrice = Math.max(...prices);
    
    // Determine data source
    const dataSource = pricingData.length > 0 && pricingData[0].source === 'real' ? 'real' : 'sample';
    
    res.json({
      success: true,
      summary: {
        currentPrice: currentPrice ? currentPrice.price : null,
        currentLevel: currentPrice ? currentPrice.level : null,
        averagePrice: averagePrice,
        lowestPrice: lowestPrice,
        highestPrice: highestPrice,
        pricesAvailable: true,
        timezone: timezone,
        timestamp: now.toISOString(),
        dataSource: dataSource,
        provider: 'Tibber',
        currency: config.currency || 'EUR',
        hasLevels: pricingData.some(p => p.level)
      }
    });
  } catch (error) {
    console.error('Error generating Tibber pricing summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate pricing summary: ' + error.message
    });
  }
});

// Get actions log
router.get('/actions-log', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 10);
    const logFile = path.join(__dirname, '..', 'logs', 'dynamic_pricing.log');
    
    if (!fs.existsSync(logFile)) {
      return res.json({
        success: true,
        actions: []
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
          action: parts.slice(1).join(' - ')
        };
      }
      return {
        timestamp: new Date().toISOString(),
        action: line
      };
    });
    
    res.json({
      success: true,
      actions,
      provider: 'Tibber'
    });
  } catch (error) {
    console.error('Error retrieving Tibber actions log:', error);
    res.json({
      success: true,
      actions: []
    });
  }
});

module.exports = router;