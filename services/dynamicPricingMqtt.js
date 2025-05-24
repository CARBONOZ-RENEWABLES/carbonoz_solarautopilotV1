// dynamicPricingMqtt.js

/**
 * Specialized MQTT functions for dynamic pricing integration
 * This module extends the core dynamicPricingService with specific MQTT functionality
 */

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

// Load options to get MQTT configuration
function getMqttConfig() {
  try {
    // Read configuration from Home Assistant add-on options
    const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
    
    return {
      host: options.mqtt_host,
      port: options.mqtt_port,
      username: options.mqtt_username,
      password: options.mqtt_password,
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
 * Send a grid charge command via MQTT
 * @param {Object} mqttClient - Connected MQTT client
 * @param {Boolean} enable - Whether to enable (true) or disable (false) grid charging
 * @param {Object} config - Dynamic pricing configuration
 * @returns {Boolean} Success status
 */
function sendGridChargeCommand(mqttClient, enable, config) {
  if (!mqttClient || !mqttClient.connected) {
    console.error('MQTT client is not connected, cannot send grid charge command');
    return false;
  }
  
  try {
    // Get MQTT configuration
    const mqttConfig = getMqttConfig();
    const mqttTopicPrefix = mqttConfig.mqttTopicPrefix;
    const inverterNumber = mqttConfig.inverterNumber;
    
    // Log the command
    console.log(`Dynamic pricing sending command: grid_charge = ${enable ? 'Enabled' : 'Disabled'}`);
    
    // Track successful publishes
    let successCount = 0;
    
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
    
    // Log the action
    const logDir = '/data/logs';
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, 'dynamic_pricing.log');
    const logMessage = `${new Date().toISOString()} - Dynamic pricing ${enable ? 'enabled' : 'disabled'} grid charging for ${inverterNumber} inverter(s). Reason: ${enable ? 'Low price period' : 'High price or target SoC reached'}\n`;
    
    // Append to log file asynchronously
    fs.appendFile(logFile, logMessage, (err) => {
      if (err) {
        console.error('Error writing to dynamic pricing log:', err);
      }
    });
    
    return successCount > 0;
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
 * @returns {Boolean} Success status
 */
function setBatteryChargingParameter(mqttClient, parameter, value) {
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
    
    return successCount > 0;
  } catch (error) {
    console.error('Error sending parameter command:', error.message);
    return false;
  }
}

/**
 * Set charge current based on price conditions
 * Provides more granular control - if prices are very low, can set higher charge current
 * @param {Object} mqttClient - Connected MQTT client
 * @param {Object} priceInfo - Current price information
 * @param {Object} config - Dynamic pricing configuration
 * @returns {Boolean} Success status
 */
function adjustChargingCurrent(mqttClient, priceInfo, config) {
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
    // For example, if threshold is 0.10 and price is 0.05, we're 50% below threshold
    const percentageBelowThreshold = Math.min(Math.max(0, (threshold - priceInfo.price) / threshold), 0.5);
    
    // Adjust max grid charge current based on how far below threshold we are
    // Default max current is 16A, but can increase up to 32A when prices are very low
    let adjustedCurrent;
    
    if (percentageBelowThreshold <= 0) {
      // At or above threshold, use normal current
      adjustedCurrent = 16;
    } else {
      // Below threshold, scale up to 32A based on how far below we are
      // For example, at 25% below threshold, we'd set 24A
      adjustedCurrent = Math.round(16 + (percentageBelowThreshold * 32));
    }
    
    // Set the adjusted current
    return setBatteryChargingParameter(mqttClient, 'max_grid_charge_current', adjustedCurrent);
  } catch (error) {
    console.error('Error adjusting charging current:', error.message);
    return false;
  }
}

module.exports = {
  sendGridChargeCommand,
  setBatteryChargingParameter,
  adjustChargingCurrent,
  getMqttConfig
};
