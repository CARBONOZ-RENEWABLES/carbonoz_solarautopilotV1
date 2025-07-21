// services/dynamicPricingMqtt.js - ENHANCED WITH INVERTER TYPE DETECTION

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// Load options to get MQTT configuration from Home Assistant add-on
function getMqttConfig() {
  try {
    const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    
    return {
      host: 'core-mosquitto',
      port: options.mqtt_port,
      username: options.mqtt_username,
      password: options.mqtt_password,
      mqttTopicPrefix: options.mqtt_topic_prefix,
      inverterNumber: options.inverter_number
    };
  } catch (error) {
    console.error('Error loading MQTT configuration from Home Assistant add-on:', error.message);
    return {
      host: 'core-mosquitto',
      port: 1883,
      username: '',
      password: '',
      mqttTopicPrefix: '',
      inverterNumber: 1
    };
  }
}

// Function to check if learner mode is active
function isLearnerModeActive() {
  try {
    return global.learnerModeActive || false;
  } catch (error) {
    console.error('Error checking learner mode status:', error);
    return false;
  }
}

// Get inverter type from global state (from main application)
function getInverterType(inverterId) {
  try {
    if (global.inverterTypes && global.inverterTypes[inverterId]) {
      return global.inverterTypes[inverterId].type || 'unknown';
    }
    return 'unknown';
  } catch (error) {
    console.error('Error getting inverter type:', error);
    return 'unknown';
  }
}

// Mapping functions (from main application)
function mapGridChargeToChargerSourcePriority(gridCharge) {
  switch (gridCharge) {
    case 'Enabled':
      return 'Solar and utility simultaneously';
    case 'Disabled':
      return 'Solar first';
    default:
      return 'Solar first';
  }
}

function mapChargerSourcePriorityToGridCharge(chargerPriority) {
  switch (chargerPriority) {
    case 'Utility first':
    case 'Solar and utility simultaneously':
      return 'Enabled';
    case 'Solar first':
    case 'Solar only':
      return 'Disabled';
    default:
      return 'Disabled';
  }
}

// Enhanced grid charge command with inverter type detection
function sendGridChargeCommand(mqttClient, enable, config) {
  // CRITICAL CHECK: Only send commands when learner mode is active
  if (!isLearnerModeActive()) {
    console.log('Dynamic pricing: Cannot send grid charge command - Learner mode is not active');
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send grid charge command');
    return false;
  }
  
  try {
    const mqttConfig = getMqttConfig();
    const mqttTopicPrefix = mqttConfig.mqttTopicPrefix;
    const inverterNumber = mqttConfig.inverterNumber;
    
    const commandValue = enable ? 'Enabled' : 'Disabled';
    let commandsSent = 0;
    let totalInverters = 0;
    
    console.log(`Dynamic pricing: Processing grid charging ${enable ? 'enable' : 'disable'} command for ${inverterNumber} inverter(s) with type auto-detection`);
    
    // Send command to each inverter with type-aware mapping
    for (let i = 1; i <= inverterNumber; i++) {
      const inverterId = `inverter_${i}`;
      const inverterType = getInverterType(inverterId);
      
      let topic, mqttValue;
      
      if (inverterType === 'new' || inverterType === 'hybrid') {
        // Use new charger_source_priority for new inverters
        const mappedValue = mapGridChargeToChargerSourcePriority(commandValue);
        topic = `${mqttTopicPrefix}/${inverterId}/charger_source_priority/set`;
        mqttValue = mappedValue;
        console.log(`Dynamic Pricing: Auto-mapped grid_charge "${commandValue}" to charger_source_priority "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
      } else {
        // Use legacy grid_charge for legacy inverters or unknown types
        topic = `${mqttTopicPrefix}/${inverterId}/grid_charge/set`;
        mqttValue = commandValue;
        console.log(`Dynamic Pricing: Using legacy grid_charge "${commandValue}" for ${inverterId} (type: ${inverterType})`);
      }
      
      mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          commandsSent++;
        }
      });
      
      totalInverters++;
    }
    
    const action = enable ? 'enabled' : 'disabled';
    console.log(`Dynamic pricing: Grid charging ${action} for ${totalInverters} inverter(s) with intelligent type detection (Learner mode: ACTIVE)`);
    
    // Enhanced logging with inverter type information
    logEnhancedAction(`Grid charging ${action} for ${totalInverters} inverter(s) with auto-detection`);
    
    return commandsSent > 0;
  } catch (error) {
    console.error('Error sending enhanced grid charge command:', error.message);
    return false;
  }
}

// Enhanced battery charging parameter with inverter type awareness
function setBatteryChargingParameter(mqttClient, parameter, value, config = {}) {
  if (!isLearnerModeActive()) {
    console.log(`Dynamic pricing: Cannot send battery parameter command (${parameter}) - Learner mode is not active`);
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send parameter command');
    return false;
  }
  
  try {
    const mqttConfig = getMqttConfig();
    const mqttTopicPrefix = mqttConfig.mqttTopicPrefix;
    const inverterNumber = mqttConfig.inverterNumber;
    
    const validParameters = [
      'max_grid_charge_current',
      'max_charge_current',
      'max_discharge_current',
      'battery_float_charge_voltage',
      'battery_absorption_charge_voltage',
      'battery_equalization_charge_voltage'
    ];
    
    if (!validParameters.includes(parameter)) {
      console.error(`Invalid battery parameter: ${parameter}`);
      return false;
    }
    
    console.log(`Dynamic pricing: Setting ${parameter} = ${value} for ${inverterNumber} inverter(s) (Learner mode: ACTIVE)`);
    
    let commandsSent = 0;
    
    // Send command to each inverter (these parameters work the same for all inverter types)
    for (let i = 1; i <= inverterNumber; i++) {
      const inverterId = `inverter_${i}`;
      const inverterType = getInverterType(inverterId);
      const topic = `${mqttTopicPrefix}/${inverterId}/${parameter}/set`;
      
      mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          commandsSent++;
        }
      });
      
      console.log(`Dynamic Pricing: Set ${parameter}=${value} for ${inverterId} (type: ${inverterType})`);
    }
    
    logEnhancedAction(`Set ${parameter} to ${value} for ${inverterNumber} inverter(s)`);
    
    return commandsSent > 0;
  } catch (error) {
    console.error('Error sending enhanced parameter command:', error.message);
    return false;
  }
}

// Enhanced charging current adjustment with inverter type support
function adjustChargingCurrent(mqttClient, priceInfo, config) {
  if (!isLearnerModeActive()) {
    console.log('Dynamic pricing: Cannot adjust charging current - Learner mode is not active');
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot adjust charging current');
    return false;
  }
  
  try {
    if (!priceInfo || typeof priceInfo.price !== 'number') {
      console.error('Cannot adjust charging current: invalid price information');
      return false;
    }
    
    const threshold = config.priceThreshold || 0.10;
    const percentageBelowThreshold = Math.min(Math.max(0, (threshold - priceInfo.price) / threshold), 0.5);
    
    let adjustedCurrent;
    if (percentageBelowThreshold <= 0) {
      adjustedCurrent = 16; // Normal current
    } else {
      adjustedCurrent = Math.round(16 + (percentageBelowThreshold * 32));
    }
    
    // Use Tibber level information if available
    let reason = `price ${priceInfo.price}`;
    if (priceInfo.level) {
      reason = `Tibber level ${priceInfo.level} (${priceInfo.price})`;
    }
    
    console.log(`Dynamic pricing: Adjusting charging current to ${adjustedCurrent}A based on ${reason} with inverter type detection`);
    
    return setBatteryChargingParameter(mqttClient, 'max_grid_charge_current', adjustedCurrent, config);
  } catch (error) {
    console.error('Error adjusting charging current:', error.message);
    return false;
  }
}

// Enhanced logging function with inverter type information
function logEnhancedAction(action) {
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const timestamp = new Date().toISOString();
    
    // Get inverter type summary for logging
    const inverterTypeSummary = getInverterTypeSummary();
    const logMessage = `${timestamp} - ${action} ${inverterTypeSummary}\n`;
    
    // Check file size and rotate if too large
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      const fileSizeInKB = stats.size / 1024;
      
      if (fileSizeInKB > 50) {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        const recentLines = lines.slice(-20);
        fs.writeFileSync(logFile, recentLines.join('\n') + '\n');
      }
    }
    
    fs.appendFileSync(logFile, logMessage);
  } catch (error) {
    console.error('Error logging enhanced action:', error);
  }
}

// Get summary of inverter types for logging
function getInverterTypeSummary() {
  try {
    if (!global.inverterTypes) {
      return '(inverter types: unknown)';
    }
    
    const types = {};
    Object.values(global.inverterTypes).forEach(inverter => {
      const type = inverter.type || 'unknown';
      types[type] = (types[type] || 0) + 1;
    });
    
    const summary = Object.entries(types)
      .map(([type, count]) => `${count}x${type}`)
      .join(', ');
    
    return `(inverter types: ${summary})`;
  } catch (error) {
    return '(inverter types: error)';
  }
}

// Enhanced work mode setting with inverter type detection
function setWorkMode(mqttClient, workMode, config = {}) {
  if (!isLearnerModeActive()) {
    console.log(`Dynamic pricing: Cannot set work mode (${workMode}) - Learner mode is not active`);
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot set work mode');
    return false;
  }
  
  try {
    const mqttConfig = getMqttConfig();
    const mqttTopicPrefix = mqttConfig.mqttTopicPrefix;
    const inverterNumber = mqttConfig.inverterNumber;
    
    const validWorkModes = ['Battery first', 'Load first', 'Grid first', 'Solar first'];
    
    if (!validWorkModes.includes(workMode)) {
      console.error(`Invalid work mode: ${workMode}`);
      return false;
    }
    
    console.log(`Dynamic pricing: Setting work mode to "${workMode}" for ${inverterNumber} inverter(s) with type detection`);
    
    let commandsSent = 0;
    
    // Send command to each inverter with type-aware mapping
    for (let i = 1; i <= inverterNumber; i++) {
      const inverterId = `inverter_${i}`;
      const inverterType = getInverterType(inverterId);
      
      // For work mode, we typically use energy_pattern/output_source_priority
      let topic, mqttValue;
      
      if (inverterType === 'new' || inverterType === 'hybrid') {
        // Map to new output_source_priority
        const mappedValue = mapEnergyPatternToOutputSourcePriority(workMode);
        topic = `${mqttTopicPrefix}/${inverterId}/output_source_priority/set`;
        mqttValue = mappedValue;
        console.log(`Dynamic Pricing: Auto-mapped work mode "${workMode}" to output_source_priority "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
      } else {
        // Use legacy energy_pattern
        topic = `${mqttTopicPrefix}/${inverterId}/energy_pattern/set`;
        mqttValue = workMode;
        console.log(`Dynamic Pricing: Using legacy energy_pattern "${workMode}" for ${inverterId} (type: ${inverterType})`);
      }
      
      mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          commandsSent++;
        }
      });
    }
    
    logEnhancedAction(`Set work mode to "${workMode}" for ${inverterNumber} inverter(s)`);
    
    return commandsSent > 0;
  } catch (error) {
    console.error('Error setting enhanced work mode:', error.message);
    return false;
  }
}

// Helper function to map energy pattern to output source priority (from main app)
function mapEnergyPatternToOutputSourcePriority(energyPattern) {
  switch (energyPattern) {
    case 'Battery first':
      return 'Solar/Battery/Utility';
    case 'Load first':
      return 'Solar first';
    case 'Grid first':
      return 'Utility first';
    case 'Solar first':
      return 'Solar first';
    default:
      return 'Solar/Battery/Utility';
  }
}

// Enhanced simulation function with inverter type info
function simulateGridChargeCommand(enable, config) {
  const action = enable ? 'enable grid charging' : 'disable grid charging';
  const reason = enable ? 'Low price period or scheduled time' : 'High price or target SoC reached';
  
  const inverterTypeSummary = getInverterTypeSummary();
  console.log(`Dynamic pricing: Would have ${action} (${reason}) ${inverterTypeSummary}, but learner mode is not active`);
  
  return false;
}

// Get current time in specified timezone
function getCurrentTimeInTimezone(timezone = 'Europe/Berlin') {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (error) {
    console.error('Error getting current time in timezone:', error);
    return new Date().toISOString();
  }
}

// Validate timezone string
function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (error) {
    return false;
  }
}

// Create MQTT client with Home Assistant add-on configuration
function createMqttClient() {
  try {
    const config = getMqttConfig();
    
    const clientOptions = {
      host: config.host,
      port: config.port,
      connectTimeout: 60 * 1000,
      reconnectPeriod: 1000,
    };
    
    if (config.username && config.password) {
      clientOptions.username = config.username;
      clientOptions.password = config.password;
    }
    
    const client = mqtt.connect(`mqtt://${config.host}:${config.port}`, clientOptions);
    
    client.on('connect', () => {
      console.log(`Connected to MQTT broker at ${config.host}:${config.port} with enhanced inverter type support`);
    });
    
    client.on('error', (error) => {
      console.error('MQTT connection error:', error);
    });
    
    return client;
  } catch (error) {
    console.error('Error creating enhanced MQTT client:', error);
    return null;
  }
}

// Get all options from Home Assistant
function getAllOptions() {
  try {
    const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    return options;
  } catch (error) {
    console.error('Error loading options from Home Assistant add-on:', error.message);
    return {};
  }
}

// Check if running in Home Assistant add-on environment
function isHomeAssistantAddon() {
  return fs.existsSync('/data/options.json');
}

// Get dynamic pricing configuration from Home Assistant options
function getDynamicPricingConfig() {
  try {
    const options = getAllOptions();
    
    return {
      enabled: options.dynamic_pricing_enabled || false,
      priceThreshold: options.price_threshold || 0.10,
      timezone: options.timezone || 'Europe/Berlin',
      targetSoc: options.target_soc || 80,
      minSoc: options.min_soc || 20,
      maxChargingCurrent: options.max_charging_current || 32,
      minChargingCurrent: options.min_charging_current || 16,
      priceSource: options.price_source || 'tibber',
      chargeSchedule: options.charge_schedule || [],
      learnerMode: options.learner_mode || false
    };
  } catch (error) {
    console.error('Error loading dynamic pricing configuration:', error);
    return {
      enabled: false,
      priceThreshold: 0.10,
      timezone: 'Europe/Berlin',
      targetSoc: 80,
      minSoc: 20,
      maxChargingCurrent: 32,
      minChargingCurrent: 16,
      priceSource: 'tibber',
      chargeSchedule: [],
      learnerMode: false
    };
  }
}

module.exports = {
  sendGridChargeCommand,
  setBatteryChargingParameter,
  adjustChargingCurrent,
  setWorkMode, // New function
  getMqttConfig,
  getAllOptions,
  isHomeAssistantAddon,
  isLearnerModeActive,
  simulateGridChargeCommand,
  getCurrentTimeInTimezone,
  isValidTimezone,
  createMqttClient,
  getDynamicPricingConfig,
  getInverterType, // Expose for other modules
  getInverterTypeSummary // Expose for logging
};