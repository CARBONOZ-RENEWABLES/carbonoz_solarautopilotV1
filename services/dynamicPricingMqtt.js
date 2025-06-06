// services/dynamicPricingMqtt.js - MINIMAL LOGGING VERSION

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// Load options to get MQTT configuration from Home Assistant add-on
function getMqttConfig() {
  try {
    const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    
    return {
      host: 'core-mosquitto',
      port: options.mqtt_port ,
      username: options.mqtt_username ,
      password: options.mqtt_password ,
      mqttTopicPrefix: options.mqtt_topic_prefix ,
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

// Send a grid charge command via MQTT - MINIMAL LOGGING
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
    
    // Get timezone for minimal logging
    const timezone = config?.timezone || 'Europe/Berlin';
    
    // MINIMAL logging - only essential info
    console.log(`Dynamic pricing: Grid charging ${enable ? 'enabled' : 'disabled'} (Learner mode: ACTIVE)`);
    
    // Send command to each inverter
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/grid_charge/set`;
      const value = enable ? 'Enabled' : 'Disabled';
      
      mqttClient.publish(topic, value, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        }
      });
    }
    
    // MINIMAL logging to file - only critical actions
    logMinimalAction(`Grid charging ${enable ? 'enabled' : 'disabled'} via dynamic pricing`);
    
    return true;
  } catch (error) {
    console.error('Error sending grid charge command:', error.message);
    return false;
  }
}

// Set a specific battery charging parameter - MINIMAL LOGGING
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
    
    console.log(`Dynamic pricing: Setting ${parameter} = ${value} (Learner mode: ACTIVE)`);
    
    // Send command to each inverter
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/${parameter}/set`;
      
      mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        }
      });
    }
    
    // MINIMAL logging
    logMinimalAction(`Set ${parameter} to ${value}`);
    
    return true;
  } catch (error) {
    console.error('Error sending parameter command:', error.message);
    return false;
  }
}

// Adjust charging current based on price - MINIMAL LOGGING
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
    
    console.log(`Dynamic pricing: Adjusting charging current to ${adjustedCurrent}A based on price ${priceInfo.price}`);
    
    return setBatteryChargingParameter(mqttClient, 'max_grid_charge_current', adjustedCurrent, config);
  } catch (error) {
    console.error('Error adjusting charging current:', error.message);
    return false;
  }
}

// MINIMAL logging function - only log critical actions and rotate file
function logMinimalAction(action) {
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${action}\n`;
    
    // Check file size and rotate if too large (prevent HA crashes)
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      const fileSizeInKB = stats.size / 1024;
      
      // If file is larger than 50KB, keep only last 20 lines
      if (fileSizeInKB > 50) {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        const recentLines = lines.slice(-20); // Keep only last 20 lines
        fs.writeFileSync(logFile, recentLines.join('\n') + '\n');
      }
    }
    
    // Append new log entry
    fs.appendFileSync(logFile, logMessage);
  } catch (error) {
    // Silently fail to prevent crashes
    console.error('Error logging action:', error);
  }
}

// Simulate grid charge command when learner mode is inactive
function simulateGridChargeCommand(enable, config) {
  const action = enable ? 'enable grid charging' : 'disable grid charging';
  const reason = enable ? 'Low price period or scheduled time' : 'High price or target SoC reached';
  
  console.log(`Dynamic pricing: Would have ${action} (${reason}), but learner mode is not active`);
  
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
      console.log(`Connected to MQTT broker at ${config.host}:${config.port}`);
    });
    
    client.on('error', (error) => {
      console.error('MQTT connection error:', error);
    });
    
    return client;
  } catch (error) {
    console.error('Error creating MQTT client:', error);
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
      priceSource: options.price_source || 'awattar',
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
      priceSource: 'awattar',
      chargeSchedule: [],
      learnerMode: false
    };
  }
}

module.exports = {
  sendGridChargeCommand,
  setBatteryChargingParameter,
  adjustChargingCurrent,
  getMqttConfig,
  getAllOptions,
  isHomeAssistantAddon,
  isLearnerModeActive,
  simulateGridChargeCommand,
  getCurrentTimeInTimezone,
  isValidTimezone,
  createMqttClient,
  getDynamicPricingConfig
};
