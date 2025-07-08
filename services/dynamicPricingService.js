// dynamicPricingService.js - TIBBER INTEGRATION

const axios = require('axios');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const pricingApis = require('./pricingApis');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, 'data', 'dynamic_pricing_config.json');

// Ensure the config file exists
function ensureConfigExists() {
  const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(DYNAMIC_PRICING_CONFIG_FILE)) {
    const defaultConfig = {
      enabled: false,
      country: 'DE', // Default to Germany
      apiKey: '', // Tibber API token
      priceThreshold: 0, // Use automatic threshold based on Tibber levels
      minimumSoC: 20, // Minimum battery SoC to allow grid charging
      targetSoC: 80, // Target battery SoC for charging
      scheduledCharging: false,
      chargingHours: [], // Additional manual time periods
      lastUpdate: null,
      pricingData: [],
      timezone: 'Europe/Berlin',
      useTibberLevels: true, // Use Tibber's price level classification
      lowPriceLevels: ['VERY_CHEAP', 'CHEAP'], // Which Tibber levels to consider as low
      currency: 'EUR'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default Tibber dynamic pricing configuration');
  }
}

// Load the configuration
function loadConfig() {
  try {
    const configData = fs.readFileSync(DYNAMIC_PRICING_CONFIG_FILE, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('Error loading dynamic pricing config:', error.message);
    return null;
  }
}

// Save the configuration
function saveConfig(config) {
  try {
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving dynamic pricing config:', error.message);
    return false;
  }
}

// Determine low price periods using Tibber's intelligent price levels
function determineLowPricePeriods(prices, config) {
  if (!prices || prices.length === 0) {
    return [];
  }
  
  try {
    // If we have Tibber data with price levels, use them
    const hasTibberLevels = prices.some(p => p.level);
    
    if (hasTibberLevels && config.useTibberLevels) {
      console.log('Using Tibber price levels for low price detection');
      
      const lowPriceLevels = config.lowPriceLevels || ['VERY_CHEAP', 'CHEAP'];
      const lowPricePeriods = prices.filter(p => 
        lowPriceLevels.includes(p.level)
      );
      
      return groupConsecutivePeriods(lowPricePeriods, config.timezone);
    }
    
    // Fallback to manual threshold
    let threshold = config.priceThreshold;
    
    if (!threshold || threshold <= 0) {
      // Use automatic threshold - 25% lowest prices
      const sortedPrices = [...prices].sort((a, b) => a.price - b.price);
      threshold = sortedPrices[Math.floor(sortedPrices.length * 0.25)]?.price || 0.1;
      console.log(`Using automatic threshold: ${threshold} ${config.currency || 'EUR'}/kWh`);
    }
    
    const lowPricePeriods = prices.filter(p => p.price <= threshold);
    return groupConsecutivePeriods(lowPricePeriods, config.timezone);
    
  } catch (error) {
    console.error('Error determining low price periods:', error);
    return [];
  }
}

// Group consecutive price periods
function groupConsecutivePeriods(periods, timezone = 'Europe/Berlin') {
  if (periods.length === 0) return [];
  
  const groupedPeriods = [];
  let currentGroup = null;
  
  periods.forEach(period => {
    const periodTime = moment(period.timestamp).tz(timezone);
    
    if (!currentGroup) {
      currentGroup = {
        start: period.timestamp,
        end: moment(periodTime).add(1, 'hour').toISOString(),
        avgPrice: period.price,
        level: period.level || 'LOW',
        timezone: timezone
      };
    } else {
      const currentEnd = moment(currentGroup.end).tz(timezone);
      
      // If this period starts within 1 hour of current group end, extend it
      if (Math.abs(periodTime.diff(currentEnd, 'hours')) <= 1) {
        currentGroup.end = moment(periodTime).add(1, 'hour').toISOString();
        currentGroup.avgPrice = (currentGroup.avgPrice + period.price) / 2;
      } else {
        // Start a new group
        groupedPeriods.push(currentGroup);
        currentGroup = {
          start: period.timestamp,
          end: moment(periodTime).add(1, 'hour').toISOString(),
          avgPrice: period.price,
          level: period.level || 'LOW',
          timezone: timezone
        };
      }
    }
  });
  
  if (currentGroup) {
    groupedPeriods.push(currentGroup);
  }
  
  return groupedPeriods;
}

// Check if current time is within a low price period
function isCurrentlyLowPrice(config, currentSystemState) {
  if (!config.enabled || !config.pricingData) {
    return false;
  }
  
  const timezone = config.timezone || 'Europe/Berlin';
  const now = moment().tz(timezone);
  
  // Find current hour price
  const currentPrice = config.pricingData.find(p => {
    const priceTime = moment(p.timestamp).tz(timezone);
    return now.isSame(priceTime, 'hour');
  });
  
  if (!currentPrice) {
    return false;
  }
  
  // If we have Tibber levels, use them
  if (currentPrice.level && config.useTibberLevels) {
    const lowPriceLevels = config.lowPriceLevels || ['VERY_CHEAP', 'CHEAP'];
    return lowPriceLevels.includes(currentPrice.level);
  }
  
  // Fallback to threshold check
  const lowPricePeriods = determineLowPricePeriods(config.pricingData, config);
  
  return lowPricePeriods.some(period => {
    const periodStart = moment(period.start).tz(timezone);
    const periodEnd = moment(period.end).tz(timezone);
    return now.isBetween(periodStart, periodEnd, null, '[)');
  });
}

// Check if current time is within a scheduled charging period
function isWithinScheduledChargingTime(config, currentTime) {
  if (!config.scheduledCharging || !config.chargingHours || config.chargingHours.length === 0) {
    return false;
  }
  
  const timeFormat = 'HH:mm';
  const currentTimeStr = currentTime.format(timeFormat);
  
  return config.chargingHours.some(period => {
    // Handle cases where start time is later than end time (overnight periods)
    if (period.start > period.end) {
      return currentTimeStr >= period.start || currentTimeStr < period.end;
    } else {
      return currentTimeStr >= period.start && currentTimeStr < period.end;
    }
  });
}

// Main scheduling logic for battery charging
function scheduleCharging(config, mqttClient, currentSystemState) {
  if (!config.enabled) {
    return false;
  }
  
  const timezone = config.timezone || 'Europe/Berlin';
  const now = moment().tz(timezone);
  const batterySoC = currentSystemState?.battery_soc || 0;
  
  console.log(`Tibber charging evaluation: SoC=${batterySoC}%, Target=${config.targetSoC}%, Min=${config.minimumSoC}%`);
  
  // Battery is already at target level
  if (batterySoC >= config.targetSoC) {
    sendGridChargeCommand(mqttClient, false, config);
    console.log(`Battery full (${batterySoC}% >= ${config.targetSoC}%), disabling grid charging`);
    return true;
  }
  
  // Battery is below minimum level - emergency charging
  if (batterySoC < config.minimumSoC) {
    sendGridChargeCommand(mqttClient, true, config);
    console.log(`Emergency charging: Battery low (${batterySoC}% < ${config.minimumSoC}%)`);
    return true;
  }
  
  // Check if we're in a scheduled charging time
  if (isWithinScheduledChargingTime(config, now)) {
    sendGridChargeCommand(mqttClient, true, config);
    console.log('Charging due to scheduled time period');
    return true;
  }
  
  // Check if current price is low (using Tibber intelligence)
  if (isCurrentlyLowPrice(config, currentSystemState)) {
    sendGridChargeCommand(mqttClient, true, config);
    
    // Get current price info for logging
    const currentPrice = config.pricingData.find(p => {
      const priceTime = moment(p.timestamp).tz(timezone);
      return now.isSame(priceTime, 'hour');
    });
    
    if (currentPrice) {
      console.log(`Charging due to low price: ${currentPrice.price} ${config.currency}/kWh (Level: ${currentPrice.level || 'N/A'})`);
    }
    
    return true;
  }
  
  // Price is not favorable, disable charging
  sendGridChargeCommand(mqttClient, false, config);
  console.log('Current price not favorable for charging');
  return true;
}

// Send a command to enable or disable grid charging
function sendGridChargeCommand(mqttClient, enable, config) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send grid charge command');
    return false;
  }
  
  try {
    // Read the global options to get the MQTT topic prefix
    const optionsPath = path.join(__dirname, '..', 'data', 'options.json');
    let options;
    
    try {
      options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    } catch (error) {
      // Fallback to /data/options.json for Home Assistant add-on
      options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    }
    
    const mqttTopicPrefix = options.mqtt_topic_prefix || 'energy';
    const inverterNumber = options.inverter_number || 1;
    
    // Send command to each inverter
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/grid_charge/set`;
      const value = enable ? 'Enabled' : 'Disabled';
      
      mqttClient.publish(topic, value, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          console.log(`Tibber grid charge command sent: ${topic} = ${value}`);
        }
      });
    }
    
    // Log the action
    const logMessage = `${new Date().toISOString()} - Tibber dynamic pricing ${enable ? 'enabled' : 'disabled'} grid charging`;
    const logFile = path.join(__dirname, 'logs', 'dynamic_pricing.log');
    
    // Ensure logs directory exists
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    fs.appendFileSync(logFile, logMessage + '\n');
    
    return true;
  } catch (error) {
    console.error('Error sending grid charge command:', error.message);
    return false;
  }
}

// Update pricing data from Tibber API
async function updatePricingData(mqttClient, currentSystemState) {
  console.log('Updating Tibber electricity pricing data...');
  
  try {
    const config = loadConfig();
    
    if (!config || !config.enabled) {
      console.log('Tibber dynamic pricing is disabled, skipping price update');
      return false;
    }
    
    if (!config.apiKey || config.apiKey.trim() === '') {
      console.error('Tibber API token not configured');
      return false;
    }
    
    // Fetch latest pricing data from Tibber
    const prices = await pricingApis.fetchElectricityPrices(config);
    
    if (prices && prices.length > 0) {
      // Update the config with new pricing data
      config.pricingData = prices;
      config.lastUpdate = new Date().toISOString();
      
      // Update currency if we got it from Tibber data
      if (prices[0].currency) {
        config.currency = prices[0].currency;
      }
      
      // Update timezone if we got it from Tibber data
      if (prices[0].timezone) {
        config.timezone = prices[0].timezone;
      }
      
      // Save the updated config
      saveConfig(config);
      
      console.log(`Updated Tibber pricing data: ${prices.length} price points for ${config.country}`);
      console.log(`Currency: ${config.currency}, Timezone: ${config.timezone}`);
      
      // Immediately evaluate charging decision with new data
      scheduleCharging(config, mqttClient, currentSystemState);
      
      return true;
    } else {
      console.error('Failed to fetch Tibber pricing data or no price points received');
      return false;
    }
  } catch (error) {
    console.error('Error updating Tibber pricing data:', error.message);
    return false;
  }
}

// Get the next best charging times based on Tibber data
function getNextBestChargingTimes(config, hours = 4) {
  if (!config || !config.pricingData || config.pricingData.length === 0) {
    return [];
  }
  
  const timezone = config.timezone || 'Europe/Berlin';
  const now = moment().tz(timezone);
  
  // Get future prices only
  const futurePrices = config.pricingData.filter(p => {
    const priceTime = moment(p.timestamp).tz(timezone);
    return priceTime.isAfter(now);
  });
  
  if (futurePrices.length === 0) {
    return [];
  }
  
  // If we have Tibber levels, prioritize by level
  if (futurePrices.some(p => p.level) && config.useTibberLevels) {
    const levelPriority = {
      'VERY_CHEAP': 1,
      'CHEAP': 2,
      'NORMAL': 3,
      'EXPENSIVE': 4,
      'VERY_EXPENSIVE': 5
    };
    
    const sortedByLevel = futurePrices.sort((a, b) => {
      const priorityA = levelPriority[a.level] || 3;
      const priorityB = levelPriority[b.level] || 3;
      
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      
      // If same level, sort by price
      return a.price - b.price;
    });
    
    return sortedByLevel.slice(0, hours).map(p => ({
      time: moment(p.timestamp).tz(timezone).format('HH:mm'),
      date: moment(p.timestamp).tz(timezone).format('MMM D'),
      price: p.price,
      currency: p.currency || config.currency,
      level: p.level
    }));
  }
  
  // Fallback to price-based sorting
  const sortedByPrice = futurePrices.sort((a, b) => a.price - b.price);
  
  return sortedByPrice.slice(0, hours).map(p => ({
    time: moment(p.timestamp).tz(timezone).format('HH:mm'),
    date: moment(p.timestamp).tz(timezone).format('MMM D'),
    price: p.price,
    currency: p.currency || config.currency,
    level: p.level || 'UNKNOWN'
  }));
}

// Initialize dynamic pricing module with Tibber
function initializeDynamicPricing(mqttClient, currentSystemState) {
  try {
    // Ensure config file exists
    ensureConfigExists();
    
    console.log('🔋 Initializing Tibber dynamic pricing module...');
    
    // Set up scheduled jobs - less frequent to avoid API limits
    
    // Update pricing data every 4 hours (Tibber updates prices daily around 13:00)
    cron.schedule('0 */4 * * *', async () => {
      await updatePricingData(mqttClient, currentSystemState);
    });
    
    // Check charging schedule every 30 minutes
    cron.schedule('*/30 * * * *', () => {
      const config = loadConfig();
      if (config && config.enabled) {
        scheduleCharging(config, mqttClient, currentSystemState);
      }
    });
    
    // Special schedule at 13:30 when Tibber typically updates next day prices
    cron.schedule('30 13 * * *', async () => {
      console.log('Tibber daily price update time - fetching latest prices');
      await updatePricingData(mqttClient, currentSystemState);
    });
    
    // Do an initial update
    setTimeout(() => {
      updatePricingData(mqttClient, currentSystemState);
    }, 5000);
    
    // Make functions available globally
    global.tibberDynamicPricing = {
      loadConfig,
      saveConfig,
      updatePricingData,
      scheduleCharging,
      determineLowPricePeriods,
      getNextBestChargingTimes,
      isCurrentlyLowPrice
    };
    
    console.log('✅ Tibber dynamic electricity pricing module initialized');
    return true;
  } catch (error) {
    console.error('❌ Error initializing Tibber dynamic pricing module:', error.message);
    return false;
  }
}

module.exports = {
  initializeDynamicPricing,
  updatePricingData,
  scheduleCharging,
  determineLowPricePeriods,
  loadConfig,
  saveConfig,
  ensureConfigExists,
  getNextBestChargingTimes,
  isCurrentlyLowPrice
};