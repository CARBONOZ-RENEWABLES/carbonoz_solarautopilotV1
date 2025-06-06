// routes/dynamicPricingRoutes.js - COMPLETE FIXED VERSION WITH REAL DATA SUPPORT

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Import the pricing APIs to get country data
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
      market: 'DE',
      apiKey: '',
      priceThreshold: 0.10,
      minimumSoC: 20,
      targetSoC: 80,
      scheduledCharging: false,
      chargingHours: [],
      lastUpdate: null,
      pricingData: [], // Start with empty data, will fetch real or generate sample as needed
      timezone: 'Europe/Berlin'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default dynamic pricing configuration');
  }
}

// Generate sample pricing data for testing when no API key - FIXED timezone handling
function generateSamplePricingData() {
  const prices = [];
  const timezone = 'Europe/Berlin';
  
  const now = new Date();
  const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: timezone}));
  
  const startHour = new Date(nowInTimezone);
  startHour.setMinutes(0, 0, 0);
  
  // Generate 48 hours of sample data
  for (let i = 0; i < 48; i++) {
    const timestamp = new Date(startHour);
    timestamp.setHours(timestamp.getHours() + i);
    
    const hour = timestamp.getHours();
    let basePrice = 0.10;
    
    if (hour >= 7 && hour <= 9) {
      basePrice = 0.18; // Morning peak
    } else if (hour >= 17 && hour <= 21) {
      basePrice = 0.20; // Evening peak
    } else if (hour >= 1 && hour <= 5) {
      basePrice = 0.06; // Night valley
    } else if (hour >= 11 && hour <= 14) {
      basePrice = 0.08; // Midday valley
    }
    
    const randomFactor = 0.85 + (Math.random() * 0.3);
    const price = basePrice * randomFactor;
    
    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(price.toFixed(4)),
      currency: 'EUR',
      unit: 'kWh',
      timezone: timezone,
      localHour: hour,
      source: 'sample' // Mark as sample data
    });
  }
  
  return prices;
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

// Calculate low price periods - FIXED timezone handling
function calculateLowPricePeriods(pricingData, threshold, timezone = 'Europe/Berlin') {
  if (!pricingData || pricingData.length === 0) return [];
  
  try {
    // If no threshold provided, use 25% lowest prices
    if (!threshold || threshold <= 0) {
      const sortedPrices = [...pricingData].sort((a, b) => a.price - b.price);
      threshold = sortedPrices[Math.floor(sortedPrices.length * 0.25)]?.price || 0.1;
    }
    
    // Find periods below threshold
    const lowPricePeriods = pricingData.filter(p => p.price <= threshold);
    
    // Group consecutive periods with timezone awareness
    const groupedPeriods = [];
    let currentGroup = null;
    
    lowPricePeriods.forEach(period => {
      const periodTime = new Date(period.timestamp);
      
      if (!currentGroup) {
        currentGroup = {
          start: period.timestamp,
          end: new Date(periodTime.getTime() + 3600000).toISOString(),
          avgPrice: period.price,
          timezone: timezone
        };
      } else {
        const currentEnd = new Date(currentGroup.end);
        
        if (Math.abs(periodTime.getTime() - currentEnd.getTime()) <= 3600000) {
          currentGroup.end = new Date(periodTime.getTime() + 3600000).toISOString();
          currentGroup.avgPrice = (currentGroup.avgPrice + period.price) / 2;
        } else {
          groupedPeriods.push(currentGroup);
          currentGroup = {
            start: period.timestamp,
            end: new Date(periodTime.getTime() + 3600000).toISOString(),
            avgPrice: period.price,
            timezone: timezone
          };
        }
      }
    });
    
    if (currentGroup) {
      groupedPeriods.push(currentGroup);
    }
    
    return groupedPeriods;
  } catch (error) {
    console.error('Error calculating low price periods:', error);
    return [];
  }
}

// Helper function to check if timestamp is older than specified hours
function isOlderThan(timestamp, hours) {
  if (!timestamp) return true;
  
  const then = new Date(timestamp);
  const now = new Date();
  const diffHours = (now - then) / (1000 * 60 * 60);
  
  return diffHours > hours;
}

// Helper function to get country names
function getCountryName(countryCode) {
  const countryNames = {
    'DE': 'Germany', 'FR': 'France', 'ES': 'Spain', 'IT': 'Italy',
    'UK': 'United Kingdom', 'NL': 'Netherlands', 'BE': 'Belgium',
    'AT': 'Austria', 'CH': 'Switzerland', 'DK': 'Denmark',
    'NO': 'Norway', 'SE': 'Sweden', 'FI': 'Finland', 'PL': 'Poland'
  };
  
  return countryNames[countryCode] || countryCode;
}

// API Routes

// Get available countries and timezones
router.get('/countries-timezones', (req, res) => {
  try {
    const supportedCountries = pricingApis.getSupportedCountries();
    const timezones = [...new Set(supportedCountries.map(country => country.timezone))].sort();
    
    const countries = supportedCountries.map(country => ({
      code: country.code,
      name: getCountryName(country.code),
      timezone: country.timezone,
      currency: country.currency,
      market: country.market
    })).sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({
      success: true,
      countries: countries,
      timezones: timezones
    });
  } catch (error) {
    console.error('Error getting countries and timezones:', error);
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
        error: 'Failed to load dynamic pricing configuration'
      });
    }
    
    // Sanitize API key
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
      market, 
      apiKey, 
      priceThreshold,
      minimumSoC,
      targetSoC,
      scheduledCharging,
      chargingHours,
      timezone,
      gridChargingOverride
    } = req.body;
    
    // Handle grid charging override command
    if (gridChargingOverride !== undefined) {
      console.log('Grid charging override command:', gridChargingOverride ? 'ENABLE' : 'DISABLE');
      
      if (global.mqttClient && global.mqttClient.connected) {
        const dynamicPricingMqtt = require('../services/dynamicPricingMqtt');
        const success = dynamicPricingMqtt.sendGridChargeCommand(global.mqttClient, gridChargingOverride, currentConfig);
        
        return res.json({
          success: success,
          message: `Grid charging ${gridChargingOverride ? 'enabled' : 'disabled'} ${success ? 'successfully' : 'failed'}`
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
      market: market || currentConfig.market,
      priceThreshold: priceThreshold !== undefined ? parseFloat(priceThreshold) : currentConfig.priceThreshold,
      minimumSoC: minimumSoC !== undefined ? parseInt(minimumSoC, 10) : currentConfig.minimumSoC,
      targetSoC: targetSoC !== undefined ? parseInt(targetSoC, 10) : currentConfig.targetSoC,
      scheduledCharging: scheduledCharging !== undefined ? Boolean(scheduledCharging) : currentConfig.scheduledCharging,
      chargingHours: chargingHours || currentConfig.chargingHours,
      timezone: timezone || currentConfig.timezone
    };
    
    // Update API key if provided and not masked
    if (apiKey && apiKey !== '...' && !apiKey.includes('...')) {
      updatedConfig.apiKey = apiKey;
    }
    
    // If country or timezone changed, clear old pricing data to force refresh with new settings
    if ((country && country !== currentConfig.country) || (timezone && timezone !== currentConfig.timezone)) {
      console.log(`Country/timezone changed, clearing old pricing data...`);
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
      error: 'Failed to update dynamic pricing settings: ' + error.message
    });
  }
});

// Get pricing data - ENHANCED with real data support
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
    
    // Check if data is stale or missing
    const isDataStale = !lastUpdate || !pricingData.length || isOlderThan(lastUpdate, 6);
    const isDataVeryOld = !lastUpdate || isOlderThan(lastUpdate, 24);
    
    // Automatically refresh stale data or fetch real data if API key is available
    if (isDataStale || isDataVeryOld) {
      console.log(`Pricing data is ${isDataVeryOld ? 'very old' : 'stale'}, fetching fresh data...`);
      
      try {
        // Try to fetch real data first if API key is available
        if (config.apiKey && config.apiKey.trim() !== '') {
          console.log(`Fetching real pricing data for ${config.country} using API key...`);
          pricingData = await pricingApis.fetchElectricityPrices(config);
          
          if (pricingData && pricingData.length > 0) {
            // Mark as real data
            pricingData = pricingData.map(p => ({ ...p, source: 'real' }));
            console.log(`✅ Retrieved ${pricingData.length} real price points for ${config.country}`);
          } else {
            throw new Error('No real data returned from API');
          }
        } else {
          throw new Error('No API key provided');
        }
      } catch (realDataError) {
        console.log(`❌ Real data fetch failed: ${realDataError.message}, generating sample data...`);
        // Fallback to sample data
        pricingData = generateSamplePricingData();
      }
      
      // Update config with new data
      config.pricingData = pricingData;
      config.lastUpdate = new Date().toISOString();
      
      // Save updated config
      saveConfig(config);
    }
    
    // Calculate low price periods with timezone awareness
    const lowPricePeriods = calculateLowPricePeriods(pricingData, config.priceThreshold, timezone);
    
    // Determine data source
    const isRealData = pricingData.length > 0 && pricingData[0].source === 'real';
    
    console.log(`Pricing data served: ${pricingData.length} ${isRealData ? 'REAL' : 'SAMPLE'} data points, ${lowPricePeriods.length} low price periods for timezone ${timezone}`);
    
    res.json({
      success: true,
      pricingData,
      lowPricePeriods,
      lastUpdate: config.lastUpdate,
      timezone: timezone,
      autoRefreshed: isDataStale || isDataVeryOld,
      dataSource: isRealData ? 'real' : 'sample',
      hasApiKey: !!(config.apiKey && config.apiKey.trim() !== '')
    });
  } catch (error) {
    console.error('Error retrieving pricing data:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to retrieve pricing data: ' + error.message
    });
  }
});

// Enhanced manual price update with real data support
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
    
    console.log(`Manual price update requested for country: ${config.country}, timezone: ${timezone}`);
    
    let pricingData = [];
    let dataSource = 'sample';
    
    try {
      // Try to fetch real data first if API key is available
      if (config.apiKey && config.apiKey.trim() !== '') {
        console.log(`Fetching real pricing data using API key...`);
        pricingData = await pricingApis.fetchElectricityPrices(config);
        
        if (pricingData && pricingData.length > 0) {
          dataSource = 'real';
          pricingData = pricingData.map(p => ({ ...p, source: 'real' }));
          console.log(`✅ Manual update: Retrieved ${pricingData.length} real price points`);
        } else {
          throw new Error('No real data returned from API');
        }
      } else {
        throw new Error('No API key provided');
      }
    } catch (realDataError) {
      console.log(`❌ Real data fetch failed: ${realDataError.message}, generating sample data...`);
      // Fallback to sample data
      pricingData = generateSamplePricingData();
      dataSource = 'sample';
    }
    
    // Update config
    config.pricingData = pricingData;
    config.lastUpdate = new Date().toISOString();
    
    // Save updated config
    saveConfig(config);
    
    console.log(`Manual pricing data update completed for timezone ${timezone} with ${pricingData.length} ${dataSource} data points`);
    
    // Respond immediately
    res.json({
      success: true,
      message: `Price update completed. ${dataSource === 'real' ? 'Real data retrieved' : 'Sample data generated'}.`,
      dataSource: dataSource,
      dataPoints: pricingData.length
    });
  } catch (error) {
    console.error('Error updating prices:', error);
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
    
    console.log('Manual charging command:', enable ? 'ENABLE' : 'DISABLE');
    
    if (global.mqttClient && global.mqttClient.connected) {
      const dynamicPricingMqtt = require('../services/dynamicPricingMqtt');
      const config = loadConfig();
      const success = dynamicPricingMqtt.sendGridChargeCommand(global.mqttClient, enable, config);
      
      res.json({
        success: success,
        message: `Grid charging ${enable ? 'enabled' : 'disabled'} ${success ? 'successfully' : 'failed'}`
      });
    } else {
      res.status(503).json({
        success: false,
        error: 'MQTT client not available'
      });
    }
  } catch (error) {
    console.error('Error processing manual charge request:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// Get current recommendation - FIXED timezone handling
router.get('/recommendation', (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config || !config.enabled) {
      return res.json({
        success: true,
        recommendation: {
          shouldCharge: false,
          reason: 'Dynamic pricing is disabled',
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
        const lowPricePeriods = calculateLowPricePeriods(pricingData, config.priceThreshold, timezone);
        const isInLowPricePeriod = lowPricePeriods.some(period => {
          const start = new Date(period.start);
          const end = new Date(period.end);
          return now >= start && now < end;
        });
        
        if (isInLowPricePeriod) {
          shouldCharge = true;
          reason = 'Current electricity price is low';
          details = { batterySoC, currentPrice: currentPrice.price, timezone, dataSource: currentPrice.source };
        } else {
          shouldCharge = false;
          reason = 'Current electricity price is not optimal';
          details = { batterySoC, currentPrice: currentPrice.price, timezone, dataSource: currentPrice.source };
        }
      } else {
        shouldCharge = false;
        reason = 'No price data available for current hour';
        details = { batterySoC, timezone };
      }
    } else {
      shouldCharge = false;
      reason = 'No pricing data available';
      details = { batterySoC, timezone };
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
    console.error('Error generating recommendation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate recommendation: ' + error.message
    });
  }
});

// Get pricing summary - FIXED timezone handling
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
          averagePrice: null,
          lowestPrice: null,
          highestPrice: null,
          pricesAvailable: false,
          timezone: timezone,
          dataSource: 'none'
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
        averagePrice: averagePrice,
        lowestPrice: lowestPrice,
        highestPrice: highestPrice,
        pricesAvailable: true,
        timezone: timezone,
        timestamp: now.toISOString(),
        dataSource: dataSource
      }
    });
  } catch (error) {
    console.error('Error generating pricing summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate pricing summary: ' + error.message
    });
  }
});

// Get actions log - MINIMAL logging to prevent HA crashes
router.get('/actions-log', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 10); // Max 10 entries
    const logFile = path.join(__dirname, '..', 'logs', 'dynamic_pricing.log');
    
    if (!fs.existsSync(logFile)) {
      return res.json({
        success: true,
        actions: []
      });
    }
    
    const logContent = fs.readFileSync(logFile, 'utf8');
    const logLines = logContent.split('\n').filter(line => line.trim() !== '');
    
    // Only keep recent lines to prevent file from growing too large
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
      actions
    });
  } catch (error) {
    console.error('Error retrieving actions log:', error);
    res.json({
      success: true,
      actions: []
    });
  }
});

module.exports = router;
