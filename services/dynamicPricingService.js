// dynamicPricingService.js
const axios = require('axios');
const moment = require('moment-timezone');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

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
      market: 'DE', // Default to German market
      apiKey: '',
      priceThreshold: 0.10, // Default threshold in EUR/kWh
      minimumSoC: 20, // Minimum battery SoC to allow grid charging
      targetSoC: 80, // Target battery SoC for charging
      scheduledCharging: true,
      chargingHours: [], // Will contain objects with start and end times
      lastUpdate: null,
      pricingData: [],
      timezone: 'Europe/Berlin'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default dynamic pricing configuration file');
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

// Fetch electricity prices from Entso-E API
async function fetchEntsoeElectricityPrices(config) {
  if (!config.apiKey) {
    console.error('API key for Entso-E is missing');
    return [];
  }
  
  try {
    const today = moment().format('YYYYMMDD');
    const tomorrow = moment().add(1, 'day').format('YYYYMMDD');
    
    // Entso-E API uses specific area codes
    const areaCodeMap = {
      'DE': '10Y1001A1001A83F', // Germany
      'FR': '10Y1001A1001A39I', // France
      'ES': '10YES-REE------0', // Spain
      'IT': '10Y1001A1001A73I', // Italy
      'UK': '10Y1001A1001A92E', // UK
      'NL': '10Y1001A1001A16H'  // Netherlands
    };
    
    const areaCode = areaCodeMap[config.market] || areaCodeMap['DE'];
    
    const url = `https://transparency.entsoe.eu/api?documentType=A44&in_Domain=${areaCode}&out_Domain=${areaCode}&periodStart=${today}0000&periodEnd=${tomorrow}2300&securityToken=${config.apiKey}`;
    
    const response = await axios.get(url, { 
      headers: { 'Content-Type': 'application/xml' },
      timeout: 10000
    });
    
    // Parse XML response to extract price points
    // For simplicity, we'll use a placeholder function
    // In production, you would use an XML parser library
    const prices = parseEntsoeXmlResponse(response.data);
    
    return prices;
  } catch (error) {
    console.error('Error fetching Entso-E electricity prices:', error.message);
    return [];
  }
}

// Placeholder function to parse Entso-E XML response
// In a real implementation, you would use xml2js or another XML parser
function parseEntsoeXmlResponse(xmlData) {
  // This is a placeholder - in a real implementation,
  // you would parse the XML to extract prices
  
  // Sample placeholder data structure
  const prices = [];
  const now = moment();
  
  // Generate 48 hourly price points (24 hours x 2 days)
  for (let i = 0; i < 48; i++) {
    const timestamp = moment(now).add(i, 'hours');
    
    // Generate a random price between 0.05 and 0.20 EUR/kWh
    // In a real implementation, this would come from the XML
    const price = (Math.random() * 0.15 + 0.05).toFixed(4);
    
    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(price),
      currency: 'EUR',
      unit: 'kWh'
    });
  }
  
  return prices;
}

// Alternative: Fetch prices from AWATTAR API (available in Germany and Austria)
async function fetchAwattarPrices(config) {
  try {
    const countryDomain = config.country.toLowerCase() === 'at' ? 'at' : 'de';
    const url = `https://api.awattar.${countryDomain}/v1/marketdata`;
    
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data && response.data.data) {
      return response.data.data.map(item => ({
        timestamp: moment(item.start_timestamp).toISOString(),
        price: item.marketprice / 1000, // Convert from EUR/MWh to EUR/kWh
        currency: 'EUR',
        unit: 'kWh'
      }));
    }
    
    return [];
  } catch (error) {
    console.error('Error fetching aWATTar prices:', error.message);
    return [];
  }
}

// Fetch prices from selected provider based on country settings
async function fetchElectricityPrices(config) {
  // Default to using aWATTar for Germany and Austria
  if (config.country === 'DE' || config.country === 'AT') {
    return await fetchAwattarPrices(config);
  } else {
    // Use Entso-E for other European countries
    return await fetchEntsoeElectricityPrices(config);
  }
}

// Determine charging periods based on price thresholds
function determineLowPricePeriods(prices, config) {
  if (!prices || prices.length === 0) {
    return [];
  }
  
  // Sort prices ascending
  const sortedPrices = [...prices].sort((a, b) => a.price - b.price);
  
  // Determine threshold - either use the configured threshold or
  // use the lowest 25% of prices if no specific threshold is set
  const threshold = config.priceThreshold > 0 
    ? config.priceThreshold 
    : sortedPrices[Math.floor(sortedPrices.length * 0.25)].price;
  
  // Filter for periods below threshold
  const lowPricePeriods = prices.filter(p => p.price <= threshold);
  
  // Group consecutive periods
  const chargingPeriods = [];
  let currentPeriod = null;
  
  for (const period of lowPricePeriods) {
    const periodTime = moment(period.timestamp);
    
    if (!currentPeriod) {
      currentPeriod = {
        start: periodTime.toISOString(),
        end: moment(periodTime).add(1, 'hour').toISOString(),
        avgPrice: period.price
      };
    } else {
      // If this period starts at the end of the current period, extend it
      const currentEnd = moment(currentPeriod.end);
      
      if (periodTime.isSame(currentEnd)) {
        currentPeriod.end = moment(periodTime).add(1, 'hour').toISOString();
        // Update average price
        const currentDuration = moment.duration(moment(currentPeriod.end).diff(moment(currentPeriod.start))).asHours();
        const previousDuration = currentDuration - 1;
        currentPeriod.avgPrice = (currentPeriod.avgPrice * previousDuration + period.price) / currentDuration;
      } else {
        // This is a new period
        chargingPeriods.push(currentPeriod);
        currentPeriod = {
          start: periodTime.toISOString(),
          end: moment(periodTime).add(1, 'hour').toISOString(),
          avgPrice: period.price
        };
      }
    }
  }
  
  // Add the last period if it exists
  if (currentPeriod) {
    chargingPeriods.push(currentPeriod);
  }
  
  return chargingPeriods;
}

// Schedule charging based on pricing
function scheduleCharging(config, mqttClient, currentSystemState) {
  if (!config.enabled) {
    return false;
  }
  
  // Get current electricity prices
  const currentPrices = config.pricingData;
  
  if (!currentPrices || currentPrices.length === 0) {
    console.log('No pricing data available for dynamic charging decision');
    return false;
  }
  
  // Get the current time and find the current price
  const now = moment().tz(config.timezone);
  const currentPrice = currentPrices.find(p => {
    const priceTime = moment(p.timestamp).tz(config.timezone);
    return now.isSame(priceTime, 'hour');
  });
  
  if (!currentPrice) {
    console.log('No price data available for current hour');
    return false;
  }
  
  // Determine if we should charge now based on pricing
  const lowPricePeriods = determineLowPricePeriods(currentPrices, config);
  
  // Check if current time is within a low price period
  const isLowPriceNow = lowPricePeriods.some(period => {
    const periodStart = moment(period.start).tz(config.timezone);
    const periodEnd = moment(period.end).tz(config.timezone);
    return now.isBetween(periodStart, periodEnd, null, '[)');
  });
  
  // Check battery state
  const batterySoC = currentSystemState?.battery_soc || 0;
  
  // Only charge if:
  // 1. Current price is low OR we're in a specifically scheduled charging period
  // 2. Battery is below target level
  // 3. Battery is above minimum level (to prevent over-discharging)
  const shouldCharge = (
    isLowPriceNow || 
    isWithinScheduledChargingTime(config, now)
  ) && 
  batterySoC < config.targetSoC && 
  batterySoC >= config.minimumSoC;
  
  if (shouldCharge) {
    // Send command to enable grid charging
    sendGridChargeCommand(mqttClient, true, config);
    
    console.log(`Dynamic pricing: Enabling grid charging at price ${currentPrice.price} ${currentPrice.currency}/${currentPrice.unit}`);
    return true;
  } else if (batterySoC >= config.targetSoC) {
    // Battery is fully charged, disable grid charging
    sendGridChargeCommand(mqttClient, false, config);
    
    console.log(`Dynamic pricing: Disabling grid charging as battery SoC (${batterySoC}%) is at or above target (${config.targetSoC}%)`);
    return true;
  } else if (!isLowPriceNow && !isWithinScheduledChargingTime(config, now)) {
    // Not in a low price period, disable grid charging
    sendGridChargeCommand(mqttClient, false, config);
    
    console.log(`Dynamic pricing: Disabling grid charging as current price (${currentPrice.price}) is not low enough`);
    return true;
  }
  
  return false;
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

// Send a command to enable or disable grid charging
function sendGridChargeCommand(mqttClient, enable, config) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send grid charge command');
    return false;
  }
  
  try {
    // Read the global options to get the MQTT topic prefix
    const optionsPath = path.join(__dirname, 'options.json');
    const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    const mqttTopicPrefix = options.mqtt_topic_prefix || 'energy';
    
    // Determine which inverters to send the command to
    const inverterNumber = options.inverter_number || 1;
    
    // Send command to each inverter
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/grid_charge/set`;
      const value = enable ? 'Enabled' : 'Disabled';
      
      mqttClient.publish(topic, value, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
          return false;
        }
        
        console.log(`Dynamic pricing grid charge command sent: ${topic} = ${value}`);
      });
    }
    
    // Log the action to a dedicated log file
    const logMessage = `${new Date().toISOString()} - Dynamic pricing ${enable ? 'enabled' : 'disabled'} grid charging`;
    fs.appendFileSync(path.join(__dirname, 'logs', 'dynamic_pricing.log'), logMessage + '\n');
    
    return true;
  } catch (error) {
    console.error('Error sending grid charge command:', error.message);
    return false;
  }
}

// Update the pricing data on a schedule
async function updatePricingData(mqttClient, currentSystemState) {
  console.log('Updating electricity pricing data...');
  
  try {
    // Load current config
    const config = loadConfig();
    
    if (!config || !config.enabled) {
      console.log('Dynamic pricing is disabled, skipping price update');
      return false;
    }
    
    // Fetch latest pricing data
    const prices = await fetchElectricityPrices(config);
    
    if (prices && prices.length > 0) {
      // Update the config with new pricing data
      config.pricingData = prices;
      config.lastUpdate = new Date().toISOString();
      
      // Save the updated config
      saveConfig(config);
      
      console.log(`Updated electricity pricing data with ${prices.length} price points`);
      
      // Determine if we should charge based on new data
      scheduleCharging(config, mqttClient, currentSystemState);
      
      return true;
    } else {
      console.error('Failed to fetch pricing data or no price points received');
      return false;
    }
  } catch (error) {
    console.error('Error updating pricing data:', error.message);
    return false;
  }
}

// Initialize dynamic pricing module
function initializeDynamicPricing(mqttClient, currentSystemState) {
  try {
    // Ensure config file exists
    ensureConfigExists();
    
    // Set up scheduled jobs
    
    // Update pricing data every 6 hours
    cron.schedule('0 */6 * * *', async () => {
      await updatePricingData(mqttClient, currentSystemState);
    });
    
    // Check charging schedule every 15 minutes
    cron.schedule('*/15 * * * *', () => {
      const config = loadConfig();
      if (config && config.enabled) {
        scheduleCharging(config, mqttClient, currentSystemState);
      }
    });
    
    // Do an initial update
    updatePricingData(mqttClient, currentSystemState);
    
    // Make the functions available globally for the web interface
    global.dynamicPricingService = {
      loadConfig,
      saveConfig,
      updatePricingData,
      scheduleCharging,
      determineLowPricePeriods,
      fetchElectricityPrices
    };
    
    console.log('✅ Dynamic electricity pricing module initialized');
    return true;
  } catch (error) {
    console.error('❌ Error initializing dynamic pricing module:', error.message);
    return false;
  }
}

module.exports = {
  initializeDynamicPricing,
  updatePricingData,
  scheduleCharging,
  determineLowPricePeriods,
  fetchElectricityPrices,
  loadConfig,
  saveConfig
};