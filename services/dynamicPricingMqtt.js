// services/dynamicPricingMqtt.js

/**
 * Specialized MQTT functions for dynamic pricing integration
 * This module extends the core dynamicPricingService with specific MQTT functionality
 * IMPORTANT: Commands will only be sent when Learner Mode is active
 * FIXED: Timezone handling issues resolved
 */

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// Load options to get MQTT configuration
function getMqttConfig() {
  try {
    // Try to read from options.json in the root directory
    let optionsPath = path.join(__dirname, '..', 'options.json');
    
    // If not found, try different paths
    if (!fs.existsSync(optionsPath)) {
      optionsPath = path.join(process.cwd(), 'options.json');
    }
    
    if (!fs.existsSync(optionsPath)) {
      console.warn('Options file not found, using default MQTT configuration');
      return {
        host: 'localhost',
        port: 1883,
        username: '',
        password: '',
        mqttTopicPrefix: 'energy',
        inverterNumber: 1
      };
    }
    
    const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    
    return {
      host: options.mqtt_host || 'localhost',
      port: options.mqtt_port || 1883,
      username: options.mqtt_username || '',
      password: options.mqtt_password || '',
      mqttTopicPrefix: options.mqtt_topic_prefix || 'energy',
      inverterNumber: options.inverter_number || 1
    };
  } catch (error) {
    console.error('Error loading MQTT configuration:', error.message);
    return {
      host: 'localhost',
      port: 1883,
      username: '',
      password: '',
      mqttTopicPrefix: 'energy',
      inverterNumber: 1
    };
  }
}

/**
 * Check if learner mode is active by accessing the global variable
 * @returns {Boolean} True if learner mode is active
 */
function isLearnerModeActive() {
  try {
    // Access the global learnerModeActive variable from server.js
    return global.learnerModeActive || false;
  } catch (error) {
    console.error('Error checking learner mode status:', error);
    return false;
  }
}

/**
 * Send a grid charge command via MQTT
 * @param {Object} mqttClient - Connected MQTT client
 * @param {Boolean} enable - Whether to enable (true) or disable (false) grid charging
 * @param {Object} config - Dynamic pricing configuration
 * @returns {Boolean} Success status
 */
function sendGridChargeCommand(mqttClient, enable, config) {
  // CRITICAL CHECK: Only send commands when learner mode is active
  if (!isLearnerModeActive()) {
    console.log('Dynamic pricing: Cannot send grid charge command - Learner mode is not active');
    logPreventedAction(`Grid charging ${enable ? 'enable' : 'disable'} command blocked - Learner mode inactive`);
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send grid charge command');
    return false;
  }
  
  try {
    // Get MQTT configuration
    const mqttConfig = getMqttConfig();
    const mqttTopicPrefix = mqttConfig.mqttTopicPrefix;
    const inverterNumber = mqttConfig.inverterNumber;
    
    // Get timezone for logging
    const timezone = config?.timezone || 'Europe/Berlin';
    const currentTime = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    // Log the command
    console.log(`Dynamic pricing sending command: grid_charge = ${enable ? 'Enabled' : 'Disabled'} (Learner mode: ACTIVE) at ${currentTime} ${timezone}`);
    
    // Track successful publishes
    let successCount = 0;
    const totalInverters = inverterNumber;
    
    // Send command to each inverter
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/grid_charge/set`;
      const value = enable ? 'Enabled' : 'Disabled';
      
      mqttClient.publish(topic, value, { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          successCount++;
          console.log(`Dynamic pricing grid charge command sent to inverter ${i}: ${topic} = ${value}`);
        }
      });
    }
    
    // Log the action with timezone information
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const reason = enable ? 'Low price period or scheduled time' : 'High price or target SoC reached';
    const logMessage = `${new Date().toISOString()} - Dynamic pricing ${enable ? 'enabled' : 'disabled'} grid charging for ${inverterNumber} inverter(s). Reason: ${reason} [Learner Mode: ACTIVE] [Timezone: ${timezone}] [Local Time: ${currentTime}]\n`;
    
    // Append to log file asynchronously
    fs.appendFile(logFile, logMessage, (err) => {
      if (err) {
        console.error('Error writing to dynamic pricing log:', err);
      }
    });
    
    // Return true if we successfully queued commands
    return true;
  } catch (error) {
    console.error('Error sending grid charge command:', error.message);
    return false;
  }
}

/**
 * Set a specific battery charging parameter
 * @param {Object} mqttClient - Connected MQTT client
 * @param {String} parameter - Parameter name (e.g. 'max_grid_charge_current')
 * @param {String|Number} value - Parameter value
 * @param {Object} config - Dynamic pricing configuration (optional)
 * @returns {Boolean} Success status
 */
function setBatteryChargingParameter(mqttClient, parameter, value, config = {}) {
  // CRITICAL CHECK: Only send commands when learner mode is active
  if (!isLearnerModeActive()) {
    console.log(`Dynamic pricing: Cannot send battery parameter command (${parameter}) - Learner mode is not active`);
    logPreventedAction(`Battery parameter ${parameter} = ${value} command blocked - Learner mode inactive`);
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send parameter command');
    return false;
  }
  
  try {
    // Get MQTT configuration
    const mqttConfig = getMqttConfig();
    const mqttTopicPrefix = mqttConfig.mqttTopicPrefix;
    const inverterNumber = mqttConfig.inverterNumber;
    
    // Validate parameter
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
    
    // Get timezone for logging
    const timezone = config?.timezone || 'Europe/Berlin';
    const currentTime = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    console.log(`Dynamic pricing sending parameter command: ${parameter} = ${value} (Learner mode: ACTIVE) at ${currentTime} ${timezone}`);
    
    // Track successful publishes
    let successCount = 0;
    
    // Send command to each inverter
    for (let i = 1; i <= inverterNumber; i++) {
      const topic = `${mqttTopicPrefix}/inverter_${i}/${parameter}/set`;
      
      mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          successCount++;
          console.log(`Dynamic pricing parameter command sent to inverter ${i}: ${topic} = ${value}`);
        }
      });
    }
    
    // Log the action with timezone information
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const logMessage = `${new Date().toISOString()} - Dynamic pricing set ${parameter} to ${value} for ${inverterNumber} inverter(s) [Learner Mode: ACTIVE] [Timezone: ${timezone}] [Local Time: ${currentTime}]\n`;
    
    // Append to log file asynchronously
    fs.appendFile(logFile, logMessage, (err) => {
      if (err) {
        console.error('Error writing to dynamic pricing log:', err);
      }
    });
    
    return true;
  } catch (error) {
    console.error('Error sending parameter command:', error.message);
    return false;
  }
}

/**
 * Set charge current based on price conditions
 * @param {Object} mqttClient - Connected MQTT client
 * @param {Object} priceInfo - Current price information
 * @param {Object} config - Dynamic pricing configuration
 * @returns {Boolean} Success status
 */
function adjustChargingCurrent(mqttClient, priceInfo, config) {
  // CRITICAL CHECK: Only send commands when learner mode is active
  if (!isLearnerModeActive()) {
    console.log('Dynamic pricing: Cannot adjust charging current - Learner mode is not active');
    logPreventedAction(`Charging current adjustment blocked - Learner mode inactive`);
    return false;
  }

  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot adjust charging current');
    return false;
  }
  
  try {
    // Only proceed if we have valid price info
    if (!priceInfo || typeof priceInfo.price !== 'number') {
      console.error('Cannot adjust charging current: invalid price information');
      return false;
    }
    
    // Get the threshold
    const threshold = config.priceThreshold || 0.10; // Default to 0.10 EUR/kWh
    
    // Calculate percentage below threshold
    const percentageBelowThreshold = Math.min(Math.max(0, (threshold - priceInfo.price) / threshold), 0.5);
    
    // Adjust max grid charge current based on how far below threshold we are
    let adjustedCurrent;
    
    if (percentageBelowThreshold <= 0) {
      // At or above threshold, use normal current
      adjustedCurrent = 16;
    } else {
      // Below threshold, scale up to 32A based on how far below we are
      adjustedCurrent = Math.round(16 + (percentageBelowThreshold * 32));
    }
    
    // Get timezone for logging
    const timezone = config?.timezone || 'Europe/Berlin';
    const currentTime = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    console.log(`Dynamic pricing adjusting charging current to ${adjustedCurrent}A based on price ${priceInfo.price} vs threshold ${threshold} (Learner mode: ACTIVE) at ${currentTime} ${timezone}`);
    
    // Set the adjusted current
    return setBatteryChargingParameter(mqttClient, 'max_grid_charge_current', adjustedCurrent, config);
  } catch (error) {
    console.error('Error adjusting charging current:', error.message);
    return false;
  }
}

/**
 * Log an action when learner mode prevents command execution
 * @param {String} action - The action that was prevented
 */
function logPreventedAction(action) {
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - Dynamic pricing PREVENTED: ${action} [Learner Mode: INACTIVE]\n`;
    
    // Append to log file asynchronously
    fs.appendFile(logFile, logMessage, (err) => {
      if (err) {
        console.error('Error writing to dynamic pricing log:', err);
      }
    });
  } catch (error) {
    console.error('Error logging prevented action:', error);
  }
}

/**
 * Alternative function for when learner mode is inactive
 * This will log what would have happened but not send commands
 * @param {Boolean} enable - What the command would have been
 * @param {Object} config - Dynamic pricing configuration
 */
function simulateGridChargeCommand(enable, config) {
  const action = enable ? 'enable grid charging' : 'disable grid charging';
  const reason = enable ? 'Low price period or scheduled time' : 'High price or target SoC reached';
  
  // Get timezone for logging
  const timezone = config?.timezone || 'Europe/Berlin';
  const currentTime = new Date().toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  
  console.log(`Dynamic pricing: Would have ${action} (${reason}), but learner mode is not active at ${currentTime} ${timezone}`);
  logPreventedAction(`Would have ${action} - ${reason} at ${currentTime} ${timezone}`);
  
  return false; // Always return false since no actual command was sent
}

/**
 * Get current time in specified timezone for consistent logging
 * @param {String} timezone - Target timezone (e.g., 'Europe/Berlin')
 * @returns {String} Formatted time string
 */
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

/**
 * Validate timezone string
 * @param {String} timezone - Timezone to validate
 * @returns {Boolean} True if timezone is valid
 */
function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  sendGridChargeCommand,
  setBatteryChargingParameter,
  adjustChargingCurrent,
  getMqttConfig,
  isLearnerModeActive,
  logPreventedAction,
  simulateGridChargeCommand,
  getCurrentTimeInTimezone,
  isValidTimezone
};