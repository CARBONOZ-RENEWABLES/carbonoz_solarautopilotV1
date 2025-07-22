// services/dynamicPricingService.js - ENHANCED WITH TIBBER AND SMART CONDITIONS

const axios = require('axios');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const pricingApis = require('./pricingApis');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'dynamic_pricing_config.json');
const COOLDOWN_STATE_FILE = path.join(__dirname, '..', 'data', 'cooldown_state.json');

// Default configuration with enhanced features
function getDefaultConfig() {
  return {
    enabled: false,
    
    // Tibber integration
    tibberApiKey: '',
    country: 'DE',
    city: 'Berlin',
    timezone: 'Europe/Berlin',
    currency: 'EUR',
    
    // Price-based charging settings with Tibber levels
    priceBasedCharging: {
      enabled: true,
      useRealTibberPrices: true,
      useTibberLevels: true,
      allowedTibberLevels: ['VERY_CHEAP', 'CHEAP'], // Tibber price levels
      maxPriceThreshold: 0.20, // Fallback threshold if not using Tibber levels
      preferTibberLevels: true // Prefer Tibber levels over price threshold
    },
    
    // Battery settings
    battery: {
      targetSoC: 80,
      minimumSoC: 20,
      emergencySoC: 15, // Emergency charging threshold
      maxSoC: 95 // Maximum allowed SoC
    },
    
    // COMPLETELY EMPTY smart power conditions - user creates their own
    smartPowerConditions: {
      enabled: false,
      rules: [] // Start with empty rules array - NO DEFAULT RULES
    },
    
    // Weather-based charging with country/city selection
    weatherConditions: {
      enabled: false,
      chargeOnCloudyDays: true,
      chargeBeforeStorm: true,
      cloudCoverThreshold: 70, // % cloud cover to trigger charging
      weatherApiKey: '', // OpenWeatherMap API key
      location: null // Will be set based on country/city selection
    },
    
    // Time-based conditions
    timeConditions: {
      enabled: true,
      preferNightCharging: false,
      nightStart: '22:00',
      nightEnd: '06:00',
      avoidPeakHours: true,
      peakStart: '17:00',
      peakEnd: '21:00'
    },
    
    // Cooldown settings
    cooldown: {
      enabled: true,
      chargingCooldownMinutes: 30,
      errorCooldownMinutes: 60,
      maxChargingCyclesPerDay: 8
    },
    
    // Scheduled charging (additional to smart charging)
    scheduledCharging: false,
    chargingHours: [],
    
    // Data and status
    lastUpdate: null,
    pricingData: [],
    currentPrice: null,
    
    // Features
    inverterSupport: true,
    autoCommandMapping: true,
    intelligentCurrentAdjustment: true,
    supportedInverterTypes: ['legacy', 'new', 'hybrid']
  };
}

// Ensure config file exists
function ensureConfigExists() {
  const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(DYNAMIC_PRICING_CONFIG_FILE)) {
    const defaultConfig = getDefaultConfig();
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created enhanced dynamic pricing configuration with Tibber integration');
  }
}

// Load configuration
function loadConfig() {
  try {
    ensureConfigExists();
    const configData = fs.readFileSync(DYNAMIC_PRICING_CONFIG_FILE, 'utf8');
    const config = JSON.parse(configData);
    
    // Merge with defaults to ensure all new properties exist
    const defaultConfig = getDefaultConfig();
    const mergedConfig = mergeDeep(defaultConfig, config);
    
    return mergedConfig;
  } catch (error) {
    console.error('Error loading dynamic pricing config:', error.message);
    return getDefaultConfig();
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

// Deep merge utility function
function mergeDeep(target, source) {
  const output = Object.assign({}, target);
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target))
          Object.assign(output, { [key]: source[key] });
        else
          output[key] = mergeDeep(target[key], source[key]);
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

// Cooldown state management
function loadCooldownState() {
  try {
    if (fs.existsSync(COOLDOWN_STATE_FILE)) {
      const data = fs.readFileSync(COOLDOWN_STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading cooldown state:', error);
  }
  
  return {
    lastChargingCommand: null,
    lastErrorTime: null,
    chargingCyclesToday: 0,
    lastResetDate: moment().format('YYYY-MM-DD')
  };
}

function saveCooldownState(state) {
  try {
    const dir = path.dirname(COOLDOWN_STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(COOLDOWN_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error saving cooldown state:', error);
  }
}

// Check if we're in cooldown period
function isInCooldown(config) {
  if (!config.cooldown.enabled) return false;
  
  const cooldownState = loadCooldownState();
  const now = moment();
  
  // Reset daily cycle count if it's a new day
  const today = now.format('YYYY-MM-DD');
  if (cooldownState.lastResetDate !== today) {
    cooldownState.chargingCyclesToday = 0;
    cooldownState.lastResetDate = today;
    saveCooldownState(cooldownState);
  }
  
  // Check daily cycle limit
  if (cooldownState.chargingCyclesToday >= config.cooldown.maxChargingCyclesPerDay) {
    console.log(`🔄 Cooldown: Daily charging cycle limit reached (${cooldownState.chargingCyclesToday}/${config.cooldown.maxChargingCyclesPerDay})`);
    return true;
  }
  
  // Check error cooldown
  if (cooldownState.lastErrorTime) {
    const errorCooldownEnd = moment(cooldownState.lastErrorTime).add(config.cooldown.errorCooldownMinutes, 'minutes');
    if (now.isBefore(errorCooldownEnd)) {
      console.log(`🔄 Cooldown: Error cooldown active until ${errorCooldownEnd.format('HH:mm')}`);
      return true;
    }
  }
  
  // Check charging command cooldown
  if (cooldownState.lastChargingCommand) {
    const chargingCooldownEnd = moment(cooldownState.lastChargingCommand).add(config.cooldown.chargingCooldownMinutes, 'minutes');
    if (now.isBefore(chargingCooldownEnd)) {
      const remainingMinutes = chargingCooldownEnd.diff(now, 'minutes');
      console.log(`🔄 Cooldown: Charging command cooldown active for ${remainingMinutes} more minutes`);
      return true;
    }
  }
  
  return false;
}

// Update cooldown state after an action
function updateCooldownState(actionType, success = true) {
  const cooldownState = loadCooldownState();
  const now = moment();
  
  if (actionType === 'charging_command' && success) {
    cooldownState.lastChargingCommand = now.toISOString();
    cooldownState.chargingCyclesToday += 1;
  } else if (actionType === 'error') {
    cooldownState.lastErrorTime = now.toISOString();
  } else if (actionType === 'reset' || actionType === 'daily_reset') {
    cooldownState.chargingCyclesToday = 0;
    cooldownState.lastChargingCommand = null;
    cooldownState.lastErrorTime = null;
  }
  
  saveCooldownState(cooldownState);
}

// Get weather forecast data with country/city support
async function getWeatherForecast(config) {
  if (!config.weatherConditions.enabled || !config.weatherConditions.weatherApiKey) {
    return { success: false, error: 'Weather conditions disabled or no API key' };
  }
  
  try {
    let location = config.weatherConditions.location;
    
    // If no location set, get from country/city
    if (!location && config.country && config.city) {
      try {
        location = pricingApis.getLocationByCountryCity(config.country, config.city);
      } catch (locationError) {
        console.error('Location lookup failed:', locationError.message);
        return { success: false, error: 'Failed to get location coordinates' };
      }
    }
    
    if (!location || !location.lat || !location.lon) {
      return { success: false, error: 'No location configured for weather forecast' };
    }
    
    const { lat, lon } = location;
    const apiKey = config.weatherConditions.weatherApiKey.trim();
    
    if (!apiKey) {
      return { success: false, error: 'Weather API key is empty' };
    }
    
    console.log(`🌤️ Fetching weather forecast for lat:${lat}, lon:${lon}`);
    
    const response = await axios.get(`https://api.openweathermap.org/data/2.5/forecast`, {
      params: {
        lat: lat,
        lon: lon,
        appid: apiKey,
        units: 'metric',
        cnt: 8 // Next 24 hours (8 x 3-hour periods)
      },
      timeout: 15000,
      headers: {
        'User-Agent': 'SolarAutopilot/1.0'
      }
    });
    
    if (response.data && response.data.list && response.data.list.length > 0) {
      console.log(`✅ Weather forecast received: ${response.data.list.length} periods`);
      return {
        success: true,
        forecast: response.data.list,
        location: response.data.city ? response.data.city.name : 'Unknown',
        coordinates: { lat, lon },
        apiResponseCode: response.status
      };
    } else {
      return { 
        success: false, 
        error: 'No forecast data in API response',
        apiResponseCode: response.status
      };
    }
    
  } catch (error) {
    console.error('Weather API Error:', error.message);
    
    // Provide specific error messages based on error type
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      
      switch (status) {
        case 401:
          return { success: false, error: 'Invalid weather API key (401 Unauthorized)' };
        case 429:
          return { success: false, error: 'Weather API rate limit exceeded (429 Too Many Requests)' };
        case 404:
          return { success: false, error: 'Weather API endpoint not found (404)' };
        default:
          return { 
            success: false, 
            error: `Weather API error: ${status} ${statusText}`,
            details: error.response.data
          };
      }
    } else if (error.code === 'ECONNABORTED') {
      return { success: false, error: 'Weather API request timeout' };
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return { success: false, error: 'Cannot connect to weather API server' };
    } else {
      return { success: false, error: error.message };
    }
  }
}

// Analyze weather conditions for charging decision
function analyzeWeatherConditions(config, weatherData) {
  if (!weatherData || !weatherData.success) {
    return { shouldInfluenceCharging: false, reason: 'No weather data available' };
  }
  
  const forecast = weatherData.forecast;
  const settings = config.weatherConditions;
  
  // Analyze next 12 hours weather
  const next12Hours = forecast.slice(0, 4);
  
  let cloudyCount = 0;
  let stormCount = 0;
  let avgCloudCover = 0;
  
  next12Hours.forEach(period => {
    const cloudCover = period.clouds.all; // Percentage
    avgCloudCover += cloudCover;
    
    if (cloudCover > settings.cloudCoverThreshold) cloudyCount++;
    
    // Check for storms or heavy weather
    const weather = period.weather[0];
    if (weather.main === 'Thunderstorm' || (weather.main === 'Rain' && weather.description.includes('heavy'))) {
      stormCount++;
    }
  });
  
  avgCloudCover = avgCloudCover / next12Hours.length;
  
  // Determine if weather should influence charging
  if (settings.chargeBeforeStorm && stormCount > 0) {
    return { 
      shouldInfluenceCharging: true, 
      reason: 'Storm expected in next 12 hours - charging recommended',
      priority: 'high',
      details: { stormCount, avgCloudCover }
    };
  }
  
  if (settings.chargeOnCloudyDays && avgCloudCover > settings.cloudCoverThreshold) {
    return { 
      shouldInfluenceCharging: true, 
      reason: `High cloud cover expected (${Math.round(avgCloudCover)}%) - charging recommended`,
      priority: 'medium',
      details: { avgCloudCover, cloudyCount }
    };
  }
  
  if (avgCloudCover < 30) {
    return { 
      shouldInfluenceCharging: false, 
      reason: 'Clear skies expected - good solar conditions',
      priority: 'low',
      details: { avgCloudCover }
    };
  }
  
  return { 
    shouldInfluenceCharging: false, 
    reason: 'Weather conditions neutral',
    details: { avgCloudCover, cloudyCount, stormCount }
  };
}

// Check time-based conditions
function checkTimeConditions(config) {
  if (!config.timeConditions.enabled) {
    return { allow: true, reason: 'Time conditions disabled' };
  }
  
  const now = moment().tz(config.timezone);
  const currentTime = now.format('HH:mm');
  const timeSettings = config.timeConditions;
  
  // Check if we're in peak hours (avoid charging during peak if enabled)
  if (timeSettings.avoidPeakHours) {
    const peakStart = timeSettings.peakStart;
    const peakEnd = timeSettings.peakEnd;
    
    if (isTimeInRange(currentTime, peakStart, peakEnd)) {
      return { 
        allow: false, 
        reason: `Peak hours (${peakStart}-${peakEnd}) - charging avoided`,
        priority: 'high'
      };
    }
  }
  
  // Check if night charging is preferred
  if (timeSettings.preferNightCharging) {
    const nightStart = timeSettings.nightStart;
    const nightEnd = timeSettings.nightEnd;
    
    if (isTimeInRange(currentTime, nightStart, nightEnd)) {
      return { 
        allow: true, 
        reason: `Night time charging preferred (${nightStart}-${nightEnd})`,
        priority: 'medium'
      };
    } else {
      return { 
        allow: false, 
        reason: 'Outside preferred night charging hours',
        priority: 'low'
      };
    }
  }
  
  return { allow: true, reason: 'Time conditions satisfied' };
}

// Check if current time is within a time range
function isTimeInRange(currentTime, startTime, endTime) {
  const current = moment(currentTime, 'HH:mm');
  const start = moment(startTime, 'HH:mm');
  const end = moment(endTime, 'HH:mm');
  
  if (end.isBefore(start)) {
    // Overnight range (e.g., 22:00 to 06:00)
    return current.isAfter(start) || current.isBefore(end);
  } else {
    // Same day range
    return current.isBetween(start, end, null, '[)');
  }
}

// Enhanced smart power conditions checker - NO DEFAULT RULES
function checkSmartPowerConditions(config, systemState) {
  if (!config.smartPowerConditions.enabled || !config.smartPowerConditions.rules.length) {
    return { 
      allow: true, 
      reason: 'Smart power conditions disabled or no custom rules defined',
      details: { 
        rulesCount: 0,
        userDefined: true,
        optional: true
      }
    };
  }
  
  const rules = config.smartPowerConditions.rules;
  const results = [];
  
  console.log(`🔧 Evaluating ${rules.length} user-defined smart power rule(s)...`);
  
  // Check each user-defined power rule
  for (const rule of rules) {
    if (!rule.enabled) {
      console.log(`⏭️ Skipping disabled rule: ${rule.name}`);
      continue;
    }
    
    console.log(`🔍 Evaluating rule: "${rule.name}" (Priority: ${rule.priority})`);
    const ruleResult = evaluateSmartPowerRule(rule, systemState);
    
    results.push({
      ruleId: rule.id,
      ruleName: rule.name,
      passed: ruleResult.passed,
      reason: ruleResult.reason,
      priority: rule.priority,
      details: ruleResult.details
    });
    
    console.log(`📋 Rule "${rule.name}": ${ruleResult.passed ? 'PASSED' : 'FAILED'} - ${ruleResult.reason}`);
  }
  
  // Find highest priority passing rule
  const passingRules = results.filter(r => r.passed);
  
  if (passingRules.length > 0) {
    // Sort by priority (high > medium > low)
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    passingRules.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
    
    const bestRule = passingRules[0];
    return {
      allow: true,
      reason: `Custom rule "${bestRule.ruleName}" conditions satisfied`,
      priority: bestRule.priority,
      details: {
        passingRules: passingRules.length,
        appliedRule: bestRule,
        allResults: results,
        userDefined: true
      }
    };
  }
  
  // No rules passed
  const failedReasons = results
    .filter(r => !r.passed)
    .map(r => `${r.ruleName}: ${r.reason}`)
    .slice(0, 3); // Show first 3 failures
    
  return {
    allow: false,
    reason: `No custom power rules satisfied (${results.length} rules checked)`,
    priority: 'low',
    details: {
      failedRules: results.filter(r => !r.passed).length,
      failedReasons: failedReasons,
      allResults: results,
      userDefined: true
    }
  };
}

// Enhanced rule evaluation with better parameter support
function evaluateSmartPowerRule(rule, systemState) {
  const conditions = rule.conditions;
  const results = [];
  
  console.log(`🔧 Evaluating ${Object.keys(conditions).length} condition(s) for rule "${rule.name}"`);
  
  for (const [parameter, condition] of Object.entries(conditions)) {
    const result = evaluateEnhancedCondition(parameter, condition, systemState);
    results.push(result);
    
    console.log(`   📊 ${parameter}: ${result.reason} → ${result.passed ? 'PASS' : 'FAIL'}`);
    
    if (!result.passed) {
      return {
        passed: false,
        reason: `Condition failed: ${result.reason}`,
        details: { 
          failedCondition: parameter, 
          allConditions: results,
          systemState: {
            battery_soc: systemState.battery_soc,
            pv_power: systemState.pv_power,
            load: systemState.load,
            grid_power: systemState.grid_power,
            battery_power: systemState.battery_power,
            grid_voltage: systemState.grid_voltage
          }
        }
      };
    }
  }
  
  return {
    passed: true,
    reason: `All ${results.length} condition(s) satisfied`,
    details: { 
      passedConditions: results.length, 
      conditions: results,
      systemState: {
        battery_soc: systemState.battery_soc,
        pv_power: systemState.pv_power,
        load: systemState.load,
        grid_power: systemState.grid_power,
        battery_power: systemState.battery_power,
        grid_voltage: systemState.grid_voltage
      }
    }
  };
}

// Enhanced condition evaluation with more parameters and better handling
function evaluateEnhancedCondition(parameter, condition, systemState) {
  let currentValue = getCurrentSystemValue(parameter, systemState);
  let compareValue;
  
  // Handle comparison with other parameters or fixed values
  if (condition.compare) {
    compareValue = getCurrentSystemValue(condition.compare, systemState);
    if (condition.offset) {
      compareValue += condition.offset;
    }
  } else {
    compareValue = condition.value;
  }
  
  // Validate current value
  if (currentValue === null || currentValue === undefined) {
    return {
      passed: false,
      reason: `${parameter} not available (current: ${currentValue})`,
      values: { current: currentValue, compare: compareValue },
      parameterStatus: 'unavailable'
    };
  }
  
  // Validate compare value
  if (compareValue === null || compareValue === undefined) {
    return {
      passed: false,
      reason: `Comparison value not available for ${parameter} (compare: ${compareValue})`,
      values: { current: currentValue, compare: compareValue },
      parameterStatus: 'compare_unavailable'
    };
  }
  
  let passed = false;
  let operator = condition.operator;
  
  // Enhanced operator support
  switch (operator) {
    case 'gt':
      passed = currentValue > compareValue;
      break;
    case 'lt':
      passed = currentValue < compareValue;
      break;
    case 'eq':
      passed = Math.abs(currentValue - compareValue) < 0.01;
      break;
    case 'gte':
      passed = currentValue >= compareValue;
      break;
    case 'lte':
      passed = currentValue <= compareValue;
      break;
    case 'ne': // Not equal
      passed = Math.abs(currentValue - compareValue) >= 0.01;
      break;
    case 'between': // For range conditions
      if (condition.maxValue !== undefined) {
        passed = currentValue >= compareValue && currentValue <= condition.maxValue;
      } else {
        passed = false;
      }
      break;
    default:
      return {
        passed: false,
        reason: `Invalid operator "${operator}" for ${parameter}`,
        values: { current: currentValue, compare: compareValue },
        parameterStatus: 'invalid_operator'
      };
  }
  
  const compareText = condition.compare ? 
    `${condition.compare}${condition.offset ? ' + ' + condition.offset : ''}` : 
    compareValue.toString();
  
  const operatorText = getOperatorText(operator);
  
  return {
    passed: passed,
    reason: `${parameter} ${currentValue} ${operatorText} ${compareText} (${compareValue})`,
    values: { 
      current: currentValue, 
      compare: compareValue, 
      operator: operator,
      operatorText: operatorText
    },
    parameterStatus: 'evaluated'
  };
}

// Get current system value with enhanced parameter support
function getCurrentSystemValue(parameter, systemState) {
  const parameterMap = {
    'battery_soc': systemState.battery_soc,
    'pv_power': systemState.pv_power,
    'load_power': systemState.load,
    'load': systemState.load, // Alias
    'grid_power': systemState.grid_power,
    'battery_power': systemState.battery_power,
    'grid_voltage': systemState.grid_voltage,
    // Additional calculated values
    'net_power': (systemState.pv_power || 0) - (systemState.load || 0),
    'battery_charging_power': Math.max(0, systemState.battery_power || 0),
    'battery_discharging_power': Math.max(0, -(systemState.battery_power || 0)),
    'grid_import': Math.max(0, systemState.grid_power || 0),
    'grid_export': Math.max(0, -(systemState.grid_power || 0))
  };
  
  return parameterMap[parameter];
}

// Get human-readable operator text
function getOperatorText(operator) {
  const operatorMap = {
    'gt': 'greater than',
    'lt': 'less than',
    'gte': 'greater than or equal to',
    'lte': 'less than or equal to',
    'eq': 'equal to',
    'ne': 'not equal to',
    'between': 'between'
  };
  
  return operatorMap[operator] || operator;
}

// Enhanced price conditions with real Tibber integration
async function checkPriceConditions(config) {
  const priceSettings = config.priceBasedCharging;
  
  if (!priceSettings.enabled) {
    return { allow: false, reason: 'Price-based charging disabled' };
  }
  
  try {
    let currentPrice = null;
    
    // Try to get real-time Tibber price first
    if (config.tibberApiKey && priceSettings.useRealTibberPrices) {
      try {
        currentPrice = await pricingApis.getTibberCurrentPrice(config);
        console.log(`💰 Real-time Tibber price: ${currentPrice.price} ${currentPrice.currency}/kWh (Level: ${currentPrice.level})`);
      } catch (tibberError) {
        console.log(`❌ Tibber API error: ${tibberError.message}, falling back to stored data`);
      }
    }
    
    // Fallback to stored pricing data
    if (!currentPrice && config.pricingData && config.pricingData.length > 0) {
      const timezone = config.timezone || 'Europe/Berlin';
      const now = moment().tz(timezone);
      
      currentPrice = config.pricingData.find(p => {
        const priceTime = moment(p.timestamp).tz(timezone);
        return now.isSame(priceTime, 'hour');
      });
    }
    
    if (!currentPrice) {
      return { allow: false, reason: 'No current price data available' };
    }
    
    // Use Tibber levels if available and enabled
    if (priceSettings.useTibberLevels && currentPrice.level && priceSettings.preferTibberLevels) {
      const allowedLevels = priceSettings.allowedTibberLevels || ['VERY_CHEAP', 'CHEAP'];
      const isAllowedLevel = allowedLevels.includes(currentPrice.level);
      
      if (isAllowedLevel) {
        return { 
          allow: true, 
          reason: `Tibber price level favorable (${currentPrice.level}): ${currentPrice.price.toFixed(4)} ${config.currency}/kWh`,
          details: {
            price: currentPrice.price,
            level: currentPrice.level,
            source: currentPrice.isRealTime ? 'Real-time Tibber' : 'Cached data'
          }
        };
      } else {
        return { 
          allow: false, 
          reason: `Tibber price level unfavorable (${currentPrice.level}): ${currentPrice.price.toFixed(4)} ${config.currency}/kWh`,
          details: {
            price: currentPrice.price,
            level: currentPrice.level,
            allowedLevels: allowedLevels
          }
        };
      }
    }
    
    // Use price threshold
    const maxPrice = priceSettings.maxPriceThreshold;
    
    if (currentPrice.price <= maxPrice) {
      return { 
        allow: true, 
        reason: `Price below threshold: ${currentPrice.price.toFixed(4)} ${config.currency}/kWh ≤ ${maxPrice.toFixed(4)} ${config.currency}/kWh`,
        details: {
          price: currentPrice.price,
          threshold: maxPrice,
          level: currentPrice.level || 'N/A'
        }
      };
    } else {
      return { 
        allow: false, 
        reason: `Price above threshold: ${currentPrice.price.toFixed(4)} ${config.currency}/kWh > ${maxPrice.toFixed(4)} ${config.currency}/kWh`,
        details: {
          price: currentPrice.price,
          threshold: maxPrice,
          level: currentPrice.level || 'N/A'
        }
      };
    }
  } catch (error) {
    console.error('Error checking price conditions:', error.message);
    return { 
      allow: false, 
      reason: `Price check failed: ${error.message}` 
    };
  }
}

// Main charging decision logic with enhanced conditions
async function shouldChargeNow(config, currentSystemState) {
  console.log('🔋 Enhanced dynamic pricing: Charging decision analysis starting...');
  
  // Check if feature is enabled
  if (!config.enabled) {
    return {
      shouldCharge: false,
      reason: 'Enhanced dynamic pricing is disabled',
      details: { enabled: false }
    };
  }
  
  // Check cooldown first
  if (isInCooldown(config)) {
    return {
      shouldCharge: false,
      reason: 'System is in cooldown period',
      details: { cooldown: true }
    };
  }
  
  const batterySoC = currentSystemState?.battery_soc || 0;
  const batterySettings = config.battery;
  
  // Emergency charging check
  if (batterySoC < batterySettings.emergencySoC) {
    console.log(`🚨 Emergency charging: SoC ${batterySoC}% < ${batterySettings.emergencySoC}%`);
    return {
      shouldCharge: true,
      reason: 'Emergency charging - battery critically low',
      details: { emergency: true, batterySoC },
      priority: 'emergency'
    };
  }
  
  // Check if battery is already full
  if (batterySoC >= batterySettings.targetSoC) {
    return {
      shouldCharge: false,
      reason: `Battery at target SoC (${batterySoC}% >= ${batterySettings.targetSoC}%)`,
      details: { batteryFull: true, batterySoC }
    };
  }
  
  // Check maximum SoC limit
  if (batterySoC >= batterySettings.maxSoC) {
    return {
      shouldCharge: false,
      reason: `Battery at maximum SoC (${batterySoC}% >= ${batterySettings.maxSoC}%)`,
      details: { batteryMax: true, batterySoC }
    };
  }
  
  const analysisResults = {
    price: null,
    weather: null,
    time: null,
    smartPower: null,
    scheduled: null
  };
  
  // 1. Check scheduled charging first
  if (config.scheduledCharging && config.chargingHours && config.chargingHours.length > 0) {
    const now = moment().tz(config.timezone);
    const currentTime = now.format('HH:mm');
    
    const inScheduledTime = config.chargingHours.some(period => {
      return isTimeInRange(currentTime, period.start, period.end);
    });
    
    if (inScheduledTime) {
      analysisResults.scheduled = {
        allow: true,
        reason: 'Within scheduled charging period',
        priority: 'high'
      };
      
      console.log('✅ Scheduled charging time detected');
      return {
        shouldCharge: true,
        reason: 'Scheduled charging period active',
        details: { scheduled: true, batterySoC, analysisResults },
        priority: 'scheduled'
      };
    }
  }
  
  // 2. Check time conditions
  const timeCheck = checkTimeConditions(config);
  analysisResults.time = timeCheck;
  
  if (!timeCheck.allow && timeCheck.priority === 'high') {
    console.log(`⏰ Time condition blocked: ${timeCheck.reason}`);
    return {
      shouldCharge: false,
      reason: timeCheck.reason,
      details: { timeBlocked: true, batterySoC, analysisResults }
    };
  }
  
  // 3. Check enhanced smart power conditions
  const smartPowerCheck = checkSmartPowerConditions(config, currentSystemState);
  analysisResults.smartPower = smartPowerCheck;
  
  // 4. Check weather conditions
  let weatherAnalysis = null;
  if (config.weatherConditions.enabled) {
    try {
      const weatherData = await getWeatherForecast(config);
      weatherAnalysis = analyzeWeatherConditions(config, weatherData);
      analysisResults.weather = weatherAnalysis;
      
      console.log(`🌤️ Weather analysis: ${weatherAnalysis.reason}`);
    } catch (error) {
      console.error('Weather analysis failed:', error);
      analysisResults.weather = { shouldInfluenceCharging: false, reason: 'Weather analysis failed' };
    }
  }
  
  // 5. Check price conditions with real Tibber prices
  const priceCheck = await checkPriceConditions(config);
  analysisResults.price = priceCheck;
  
  console.log(`💰 Enhanced price analysis: ${priceCheck.reason}`);
  
  // Enhanced decision logic combining all factors
  let shouldCharge = false;
  let primaryReason = '';
  let priority = 'low';
  
  // High priority weather conditions (storms, etc.)
  if (weatherAnalysis && weatherAnalysis.shouldInfluenceCharging && weatherAnalysis.priority === 'high') {
    shouldCharge = true;
    primaryReason = weatherAnalysis.reason;
    priority = 'weather-emergency';
  }
  // Smart power conditions (high priority)
  else if (smartPowerCheck.allow && smartPowerCheck.priority === 'high') {
    if (priceCheck.allow) {
      shouldCharge = true;
      primaryReason = `Smart power rule + favorable prices: ${smartPowerCheck.reason} & ${priceCheck.reason}`;
      priority = 'smart-power-high';
    } else {
      // High priority power conditions can override price restrictions for emergency situations
      if (batterySoC < batterySettings.minimumSoC) {
        shouldCharge = true;
        primaryReason = `Emergency smart power rule (low battery): ${smartPowerCheck.reason}`;
        priority = 'smart-power-emergency';
      } else {
        shouldCharge = false;
        primaryReason = `Smart power conditions met but price unfavorable: ${priceCheck.reason}`;
        priority = 'price-blocked';
      }
    }
  }
  // Price-based charging when conditions are favorable
  else if (priceCheck.allow) {
    const favorableConditions = [];
    
    // Add time preference
    if (timeCheck.allow && timeCheck.priority === 'medium') {
      favorableConditions.push('preferred time');
    }
    
    // Add weather preference
    if (weatherAnalysis && weatherAnalysis.shouldInfluenceCharging && weatherAnalysis.priority === 'medium') {
      favorableConditions.push('weather forecast');
    }
    
    // Add medium priority smart power conditions
    if (smartPowerCheck.allow && smartPowerCheck.priority === 'medium') {
      favorableConditions.push('smart power conditions');
    }
    
    shouldCharge = true;
    primaryReason = `Favorable prices: ${priceCheck.reason}`;
    if (favorableConditions.length > 0) {
      primaryReason += ` (+ ${favorableConditions.join(', ')})`;
    }
    priority = 'price-based';
  }
  // Don't charge if price conditions are not met
  else {
    shouldCharge = false;
    primaryReason = priceCheck.reason;
    
    // Show additional context about failed conditions
    const blockedConditions = [];
    if (!smartPowerCheck.allow) blockedConditions.push('smart power');
    if (!timeCheck.allow && timeCheck.priority !== 'low') blockedConditions.push('time restrictions');
    if (weatherAnalysis && !weatherAnalysis.shouldInfluenceCharging) blockedConditions.push('weather neutral');
    
    if (blockedConditions.length > 0) {
      primaryReason += ` (also: ${blockedConditions.join(', ')})`;
    }
    
    priority = 'conditions-blocked';
  }
  
  console.log(`🔋 Enhanced Decision: ${shouldCharge ? 'CHARGE' : 'DON\'T CHARGE'} - ${primaryReason} (Priority: ${priority})`);
  
  return {
    shouldCharge,
    reason: primaryReason,
    details: { 
      batterySoC, 
      analysisResults,
      enhanced: true,
      tibberIntegration: !!config.tibberApiKey,
      smartPowerRules: config.smartPowerConditions.enabled
    },
    priority
  };
}

// Test weather API connection
async function testWeatherAPI(config) {
  try {
    const testResult = await getWeatherForecast(config);
    return testResult;
  } catch (error) {
    return {
      success: false,
      error: 'Weather API test failed: ' + error.message
    };
  }
}

// Grid charge command with cooldown management
async function sendGridChargeCommand(mqttClient, enable, config) {
  try {
    const dynamicPricingMqtt = require('./dynamicPricingMqtt');
    
    if (!dynamicPricingMqtt.isLearnerModeActive()) {
      console.log('🔄 Would send grid charge command but learner mode is not active');
      return false;
    }
    
    const success = dynamicPricingMqtt.sendGridChargeCommand(mqttClient, enable, config);
    
    if (success) {
      updateCooldownState('charging_command', true);
      
      const action = enable ? 'enabled' : 'disabled';
      console.log(`🔋 Grid charging ${action} successfully with enhanced conditions and cooldown tracking`);
      
      logAction(`Grid charging ${action} with enhanced conditions analysis`);
    } else {
      updateCooldownState('error');
    }
    
    return success;
  } catch (error) {
    console.error('Error in enhanced grid charge command:', error);
    updateCooldownState('error');
    return false;
  }
}

// Logging function
function logAction(action) {
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const timestamp = new Date().toISOString();
    
    const cooldownState = loadCooldownState();
    const cooldownInfo = `(cycles today: ${cooldownState.chargingCyclesToday})`;
    
    const logMessage = `${timestamp} - ${action} ${cooldownInfo}\n`;
    
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > 100000) { // 100KB
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').slice(-50);
        fs.writeFileSync(logFile, lines.join('\n') + '\n');
      }
    }
    
    fs.appendFileSync(logFile, logMessage);
  } catch (error) {
    console.error('Error logging action:', error);
  }
}

// Get status with enhanced information
function getStatus(config, currentSystemState) {
  const cooldownState = loadCooldownState();
  
  return {
    enabled: config.enabled,
    tibberIntegration: {
      enabled: !!config.tibberApiKey,
      country: config.country,
      city: config.city,
      useRealPrices: config.priceBasedCharging?.useRealTibberPrices
    },
    cooldown: {
      inCooldown: isInCooldown(config),
      chargingCyclesUsed: cooldownState.chargingCyclesToday,
      maxCyclesPerDay: config.cooldown.maxChargingCyclesPerDay,
      lastChargingCommand: cooldownState.lastChargingCommand,
      nextChargingAllowed: cooldownState.lastChargingCommand ? 
        moment(cooldownState.lastChargingCommand).add(config.cooldown.chargingCooldownMinutes, 'minutes').toISOString() : null
    },
    conditions: {
      price: config.priceBasedCharging,
      weather: config.weatherConditions,
      time: config.timeConditions,
      smartPower: config.smartPowerConditions
    },
    battery: {
      currentSoC: currentSystemState?.battery_soc || 0,
      settings: config.battery
    },
    currentPrice: config.currentPrice,
    lastDecision: null,
    enhanced: true
  };
}

// Add user rule management functions
function addUserSmartPowerRule(config, newRule) {
  if (!config.smartPowerConditions) {
    config.smartPowerConditions = { enabled: false, rules: [] };
  }
  
  // Generate unique ID
  const ruleId = 'user_rule_' + Date.now();
  newRule.id = ruleId;
  
  // Validate rule structure
  if (!newRule.name || !newRule.conditions) {
    throw new Error('Rule must have name and conditions');
  }
  
  // Set defaults
  newRule.enabled = newRule.enabled !== false;
  newRule.priority = newRule.priority || 'medium';
  newRule.description = newRule.description || 'User-defined rule';
  
  config.smartPowerConditions.rules.push(newRule);
  
  return ruleId;
}

function removeUserSmartPowerRule(config, ruleId) {
  if (!config.smartPowerConditions || !config.smartPowerConditions.rules) {
    return false;
  }
  
  const index = config.smartPowerConditions.rules.findIndex(rule => rule.id === ruleId);
  if (index !== -1) {
    config.smartPowerConditions.rules.splice(index, 1);
    return true;
  }
  
  return false;
}

function updateUserSmartPowerRule(config, ruleId, updates) {
  if (!config.smartPowerConditions || !config.smartPowerConditions.rules) {
    return false;
  }
  
  const rule = config.smartPowerConditions.rules.find(rule => rule.id === ruleId);
  if (rule) {
    Object.assign(rule, updates);
    return true;
  }
  
  return false;
}

module.exports = {
  loadConfig,
  saveConfig,
  ensureConfigExists,
  shouldChargeNow,
  sendGridChargeCommand,
  getStatus,
  isInCooldown,
  updateCooldownState,
  getWeatherForecast,
  testWeatherAPI,
  analyzeWeatherConditions,
  checkTimeConditions,
  checkSmartPowerConditions,
  checkPriceConditions,
  logAction,
  evaluateSmartPowerRule,
  evaluateEnhancedCondition,
  getCurrentSystemValue,
  getOperatorText,
  addUserSmartPowerRule,
  removeUserSmartPowerRule,
  updateUserSmartPowerRule
};