// dynamicPricingService.js
const axios = require('axios');
const moment = require('moment-timezone');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const pricingApis = require('./pricingApis');

let pricingUpdateJob = null;
let chargingCheckJob = null;

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
      timezone: 'Europe/Berlin',
      preferAwattar: false, // Preference for aWATTar API (DE, AT)
      preferEpex: false, // Preference for EPEX Spot
      currency: 'EUR', // Default currency
      pricingSource: 'auto' // 'auto', 'entso-e', 'awattar', 'nordpool', 'epex', etc.
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
    console.log(`[Dynamic Pricing] Saving config - enabled: ${config.enabled}`);
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
    
    // If dynamic pricing is being disabled, stop cron jobs and disable charging
    if (!config.enabled) {
      console.log('[Dynamic Pricing] Dynamic pricing disabled - stopping scheduled jobs');
      stopCronJobs();
      
      // Disable grid charging when dynamic pricing is turned off
      const mqttClient = global.mqttClient; // Assuming MQTT client is available globally
      if (mqttClient) {
        sendGridChargeCommand(mqttClient, false, config);
        console.log('[Dynamic Pricing] Grid charging disabled due to dynamic pricing being turned off');
      }
    } else {
      console.log('[Dynamic Pricing] Dynamic pricing enabled - starting scheduled jobs');
      // Restart cron jobs when enabled
      const currentSystemState = global.currentSystemState; // Assuming system state is available globally
      startCronJobs(global.mqttClient, currentSystemState);
    }
    
    return true;
  } catch (error) {
    console.error('Error saving dynamic pricing config:', error.message);
    return false;
  }
}


// New function to start cron jobs
function startCronJobs(mqttClient, currentSystemState) {
  console.log('[Dynamic Pricing] Starting cron jobs...');
  
  // Stop existing jobs first to prevent duplicates
  stopCronJobs();
  
  // Update pricing data every 6 hours
  pricingUpdateJob = cron.schedule('0 */6 * * *', async () => {
    console.log('[Dynamic Pricing] Running scheduled pricing data update...');
    const config = loadConfig();
    if (config && config.enabled) {
      await updatePricingData(mqttClient, currentSystemState);
    } else {
      console.log('[Dynamic Pricing] Skipping pricing update - dynamic pricing is disabled');
    }
  });
  
  // Check charging schedule every 15 minutes
  chargingCheckJob = cron.schedule('*/15 * * * *', () => {
    console.log('[Dynamic Pricing] Running scheduled charging check...');
    const config = loadConfig();
    if (config && config.enabled) {
      scheduleCharging(config, mqttClient, currentSystemState);
    } else {
      console.log('[Dynamic Pricing] Skipping charging check - dynamic pricing is disabled');
    }
  });
  
  console.log('[Dynamic Pricing] Cron jobs started successfully');
}


// New function to stop cron jobs
function stopCronJobs() {
  console.log('[Dynamic Pricing] Stopping cron jobs...');
  
  if (pricingUpdateJob) {
    pricingUpdateJob.destroy();
    pricingUpdateJob = null;
    console.log('[Dynamic Pricing] Pricing update job stopped');
  }
  
  if (chargingCheckJob) {
    chargingCheckJob.destroy();
    chargingCheckJob = null;
    console.log('[Dynamic Pricing] Charging check job stopped');
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

// Modified scheduleCharging function with better logging
function scheduleCharging(config, mqttClient, currentSystemState) {
  console.log(`[Dynamic Pricing] Checking if charging should be scheduled - enabled: ${config.enabled}`);
  
  if (!config.enabled) {
    console.log('[Dynamic Pricing] Dynamic pricing is disabled, skipping charging decision');
    return false;
  }
  
  // Get current electricity prices
  const currentPrices = config.pricingData;
  
  if (!currentPrices || currentPrices.length === 0) {
    console.log('[Dynamic Pricing] No pricing data available for dynamic charging decision');
    return false;
  }
  
  // Get the current time and find the current price
  const now = moment().tz(config.timezone);
  const currentPrice = currentPrices.find(p => {
    const priceTime = moment(p.timestamp).tz(config.timezone);
    return now.isSame(priceTime, 'hour');
  });
  
  if (!currentPrice) {
    console.log('[Dynamic Pricing] No price data available for current hour');
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
  
  console.log(`[Dynamic Pricing] Current conditions - Price: ${currentPrice.price}, Low price period: ${isLowPriceNow}, Battery SoC: ${batterySoC}%, Target: ${config.targetSoC}%`);
  
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
    
    console.log(`[Dynamic Pricing] Enabling grid charging at price ${currentPrice.price} ${currentPrice.currency}/${currentPrice.unit}`);
    return true;
  } else if (batterySoC >= config.targetSoC) {
    // Battery is fully charged, disable grid charging
    sendGridChargeCommand(mqttClient, false, config);
    
    console.log(`[Dynamic Pricing] Disabling grid charging as battery SoC (${batterySoC}%) is at or above target (${config.targetSoC}%)`);
    return true;
  } else if (!isLowPriceNow && !isWithinScheduledChargingTime(config, now)) {
    // Not in a low price period, disable grid charging
    sendGridChargeCommand(mqttClient, false, config);
    
    console.log(`[Dynamic Pricing] Disabling grid charging as current price (${currentPrice.price}) is not low enough`);
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

// Modified sendGridChargeCommand function with better logging
function sendGridChargeCommand(mqttClient, enable, config) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('[Dynamic Pricing] MQTT client is not connected, cannot send grid charge command');
    return false;
  }
  
  try {
    // Read configuration from Home Assistant add-on options (same as main server)
    const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    const mqttTopicPrefix = options.mqtt_topic_prefix || 'energy';
    const inverterNumber = options.inverter_number || 1;
    
    console.log(`[Dynamic Pricing] Using MQTT topic prefix: ${mqttTopicPrefix}, inverter count: ${inverterNumber}`);
    
    console.log(`[Dynamic Pricing] Sending grid charge command: ${enable ? 'ENABLE' : 'DISABLE'} to ${inverterNumber} inverter(s)`);
    
    // Send command to each inverter
    let commandsSent = 0;
    
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/grid_charge/set`;
      const value = enable ? 'Enabled' : 'Disabled';
      
      mqttClient.publish(topic, value, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`[Dynamic Pricing] Error publishing to ${topic}: ${err.message}`);
        } else {
          console.log(`[Dynamic Pricing] Grid charge command sent: ${topic} = ${value}`);
        }
      });
      
      commandsSent++;
    }
    
    // Log the action to a dedicated log file
    const logMessage = `${new Date().toISOString()} - Dynamic pricing ${enable ? 'enabled' : 'disabled'} grid charging (${commandsSent} commands sent)`;
    const logDir = path.join(__dirname, 'logs');
    
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    try {
      fs.appendFileSync(path.join(logDir, 'dynamic_pricing.log'), logMessage + '\n');
    } catch (logError) {
      console.error(`[Dynamic Pricing] Could not write to log file: ${logError.message}`);
    }
    
    return commandsSent > 0;
  } catch (error) {
    console.error('[Dynamic Pricing] Error sending grid charge command:', error.message);
    return false;
  }
}

// Alternative function to find the options file (you can call this once during initialization)
function findOptionsFile() {
  const possiblePaths = [
    path.join(__dirname, 'options.json'),
    path.join(__dirname, '..', 'options.json'),
    path.join(__dirname, '..', '..', 'options.json'),
    path.join(__dirname, 'config', 'options.json'),
    path.join(__dirname, '..', 'config', 'options.json'),
    path.join(process.cwd(), 'options.json'),
    path.join(process.cwd(), 'config', 'options.json'),
    path.join(process.cwd(), 'services', 'options.json')
  ];
  
  console.log('[Dynamic Pricing] Searching for options.json file...');
  
  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      console.log(`[Dynamic Pricing] Found options.json at: ${filePath}`);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const options = JSON.parse(content);
        console.log(`[Dynamic Pricing] Options loaded - MQTT prefix: ${options.mqtt_topic_prefix || 'energy'}, Inverters: ${options.inverter_number || 1}`);
        return { path: filePath, options };
      } catch (error) {
        console.error(`[Dynamic Pricing] Error reading options from ${filePath}: ${error.message}`);
      }
    }
  }
  
  console.warn('[Dynamic Pricing] No options.json file found. Will use default values.');
  console.warn('[Dynamic Pricing] Searched paths:', possiblePaths);
  return null;
}


// Modified updatePricingData function with better logging
async function updatePricingData(mqttClient, currentSystemState) {
  console.log('[Dynamic Pricing] Updating electricity pricing data...');
  
  try {
    // Load current config
    const config = loadConfig();
    
    if (!config || !config.enabled) {
      console.log('[Dynamic Pricing] Dynamic pricing is disabled, skipping price update');
      return false;
    }
    
    // Fetch latest pricing data using the pricingApis module
    const prices = await pricingApis.fetchElectricityPrices(config);
    
    if (prices && prices.length > 0) {
      // Update the config with new pricing data
      config.pricingData = prices;
      config.lastUpdate = new Date().toISOString();
      
      // Save the updated config (but don't trigger the disable logic)
      try {
        fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log(`[Dynamic Pricing] Updated electricity pricing data with ${prices.length} price points for ${config.country}`);
      } catch (error) {
        console.error('[Dynamic Pricing] Error saving updated pricing data:', error.message);
        return false;
      }
      
      // Determine if we should charge based on new data
      scheduleCharging(config, mqttClient, currentSystemState);
      
      return true;
    } else {
      console.error('[Dynamic Pricing] Failed to fetch pricing data or no price points received');
      return false;
    }
  } catch (error) {
    console.error('[Dynamic Pricing] Error updating pricing data:', error.message);
    return false;
  }
}


// Get available pricing sources for a country
function getAvailablePricingSources(country) {
  // Define country groups based on available APIs
  const awattarCountries = ['DE', 'AT']; // AWATTAR is available in Germany and Austria
  const nordpoolCountries = ['NO', 'SE', 'FI', 'DK', 'EE', 'LV', 'LT']; // Nordic and Baltic countries
  const epexSpotCountries = ['DE', 'FR', 'AT', 'CH', 'BE', 'NL', 'UK']; // EPEX spot market countries
  const entsoeCountries = [
    'DE', 'FR', 'ES', 'IT', 'UK', 'NL', 'BE', 'AT', 'CH', 'DK', 'NO', 'SE', 'FI', 'PL', 'CZ', 'SK', 'HU', 
    'RO', 'BG', 'GR', 'PT', 'IE', 'LU', 'EE', 'LV', 'LT', 'SI', 'HR', 'RS', 'ME', 'AL', 'MK', 'BA', 'XK'
  ]; // European countries in ENTSO-E
  
  // African countries with specific implementations
  const africanCountries = ['ZA', 'KE', 'EG', 'NG', 'MA', 'MU'];
  
  // Define other countries with specific implementations
  const specificCountries = ['US', 'CA', 'AU', 'NZ', 'JP', 'CN', 'IN', 'BR', 'KY'];
  
  // Build the list of available sources
  const sources = ['auto'];
  
  if (entsoeCountries.includes(country)) sources.push('entso-e');
  if (awattarCountries.includes(country)) sources.push('awattar');
  if (nordpoolCountries.includes(country)) sources.push('nordpool');
  if (epexSpotCountries.includes(country)) sources.push('epex');
  
  // Add specific sources for certain countries
  if (africanCountries.includes(country)) {
    const africanSourcesMap = {
      'ZA': 'eskom',
      'KE': 'kplc',
      'EG': 'egypt',
      'NG': 'nigeria',
      'MA': 'morocco',
      'MU': 'mauritius'
    };
    if (africanSourcesMap[country]) sources.push(africanSourcesMap[country]);
  }
  
  if (specificCountries.includes(country)) {
    sources.push('country-specific');
  }
  
  // Add the fallback source
  sources.push('sample');
  
  return sources;
}

// Set up predefined timezones based on country
function getTimezoneForCountry(country) {
  const timezonesMap = {
    // Europe
    'DE': 'Europe/Berlin',
    'FR': 'Europe/Paris',
    'ES': 'Europe/Madrid',
    'IT': 'Europe/Rome',
    'GB': 'Europe/London',
    'UK': 'Europe/London',
    'NL': 'Europe/Amsterdam',
    'BE': 'Europe/Brussels',
    'AT': 'Europe/Vienna',
    'CH': 'Europe/Zurich',
    'DK': 'Europe/Copenhagen',
    'NO': 'Europe/Oslo',
    'SE': 'Europe/Stockholm',
    'FI': 'Europe/Helsinki',
    'PL': 'Europe/Warsaw',
    'CZ': 'Europe/Prague',
    'SK': 'Europe/Bratislava',
    'HU': 'Europe/Budapest',
    'RO': 'Europe/Bucharest',
    'BG': 'Europe/Sofia',
    'GR': 'Europe/Athens',
    'PT': 'Europe/Lisbon',
    'IE': 'Europe/Dublin',
    'LU': 'Europe/Luxembourg',
    'IS': 'Atlantic/Reykjavik',
    'MT': 'Europe/Malta',
    'CY': 'Asia/Nicosia',
    'EE': 'Europe/Tallinn',
    'LV': 'Europe/Riga',
    'LT': 'Europe/Vilnius',
    'SI': 'Europe/Ljubljana',
    'HR': 'Europe/Zagreb',
    'RS': 'Europe/Belgrade',
    'ME': 'Europe/Podgorica',
    'AL': 'Europe/Tirane',
    'MK': 'Europe/Skopje',
    'BA': 'Europe/Sarajevo',
    
    // Africa
    'ZA': 'Africa/Johannesburg',
    'EG': 'Africa/Cairo',
    'MA': 'Africa/Casablanca',
    'DZ': 'Africa/Algiers',
    'TN': 'Africa/Tunis',
    'NG': 'Africa/Lagos',
    'KE': 'Africa/Nairobi',
    'ET': 'Africa/Addis_Ababa',
    'GH': 'Africa/Accra',
    'CI': 'Africa/Abidjan',
    'TZ': 'Africa/Dar_es_Salaam',
    'CD': 'Africa/Kinshasa',
    'MU': 'Indian/Mauritius',
    'SN': 'Africa/Dakar',
    'CM': 'Africa/Douala',
    'UG': 'Africa/Kampala',
    'ZM': 'Africa/Lusaka',
    'ZW': 'Africa/Harare',
    'AO': 'Africa/Luanda',
    'NA': 'Africa/Windhoek',
    'BW': 'Africa/Gaborone',
    'MZ': 'Africa/Maputo',
    'RW': 'Africa/Kigali',
    'MG': 'Indian/Antananarivo',
    
    // Americas
    'US': 'America/New_York', // Default to Eastern Time, should be adjusted based on state
    'CA': 'America/Toronto',  // Default to Eastern Time, should be adjusted based on province
    'MX': 'America/Mexico_City',
    'BR': 'America/Sao_Paulo',
    'AR': 'America/Argentina/Buenos_Aires',
    'CO': 'America/Bogota',
    'CL': 'America/Santiago',
    'PE': 'America/Lima',
    'KY': 'America/Cayman',
    'JM': 'America/Jamaica',
    'BS': 'America/Nassau',
    'BB': 'America/Barbados',
    'TT': 'America/Port_of_Spain',
    
    // Asia
    'CN': 'Asia/Shanghai',
    'JP': 'Asia/Tokyo',
    'KR': 'Asia/Seoul',
    'IN': 'Asia/Kolkata',
    'ID': 'Asia/Jakarta',
    'MY': 'Asia/Kuala_Lumpur',
    'SG': 'Asia/Singapore',
    'TH': 'Asia/Bangkok',
    'VN': 'Asia/Ho_Chi_Minh',
    'PH': 'Asia/Manila',
    
    // Oceania
    'AU': 'Australia/Sydney', // Default to Sydney, should be adjusted based on state
    'NZ': 'Pacific/Auckland'
  };
  
  return timezonesMap[country] || 'UTC';
}

// Initialize dynamic pricing module
function initializeDynamicPricing(mqttClient, currentSystemState) {
  try {
    console.log('[Dynamic Pricing] Initializing dynamic pricing module...');
    
    // Verify we can read the Home Assistant add-on options
    try {
      const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
      console.log(`[Dynamic Pricing] Successfully loaded Home Assistant options - MQTT prefix: ${options.mqtt_topic_prefix || 'energy'}, Inverters: ${options.inverter_number || 1}`);
    } catch (optionsError) {
      console.warn(`[Dynamic Pricing] Warning: Could not read Home Assistant options: ${optionsError.message}`);
    }
    
    // Ensure config file exists
    ensureConfigExists();
    
    // Store references globally for use in saveConfig
    global.mqttClient = mqttClient;
    global.currentSystemState = currentSystemState;
    
    // Load config and start cron jobs only if enabled
    const config = loadConfig();
    if (config && config.enabled) {
      console.log('[Dynamic Pricing] Dynamic pricing is enabled, starting scheduled jobs');
      startCronJobs(mqttClient, currentSystemState);
      
      // Do an initial update
      updatePricingData(mqttClient, currentSystemState);
    } else {
      console.log('[Dynamic Pricing] Dynamic pricing is disabled, not starting scheduled jobs');
    }
    
    // Make the functions available globally for the web interface
    global.dynamicPricingService = {
      loadConfig,
      saveConfig,
      updatePricingData,
      scheduleCharging,
      determineLowPricePeriods,
      getAvailablePricingSources,
      getTimezoneForCountry,
      startCronJobs,
      stopCronJobs
    };
    
    console.log('✅ [Dynamic Pricing] Dynamic electricity pricing module initialized with support for multiple countries');
    return true;
  } catch (error) {
    console.error('❌ [Dynamic Pricing] Error initializing dynamic pricing module:', error.message);
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
  getAvailablePricingSources,
  getTimezoneForCountry,
  ensureConfigExists,
  startCronJobs,
  stopCronJobs
};
