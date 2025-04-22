// telegram-service.js - Complete Telegram Bot Integration Service
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// File to store Telegram configuration
const TELEGRAM_CONFIG_FILE = path.join(__dirname, 'data', 'telegram_config.json');

/**
 * Initialize Telegram configuration file if it doesn't exist
 */
function initTelegramConfig() {
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  }
  
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) {
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify({
      enabled: false,
      botToken: '',
      chatId: '',
      notifyOnRuleTrigger: true,
      notifyOnWarning: true,
      notifyOnGridChange: false,
      notifyOnBatteryLow: false,
      batteryLowThreshold: 20,
      dailySummary: false,
      dailySummaryTime: '20:00',
      lastNotificationTime: null,
      maxNotificationsPerHour: 10,
      notificationCount: 0,
      notificationResetTime: null
    }));
    console.log('Telegram configuration file created');
  }
}

/**
 * Get current Telegram configuration
 * @returns {Object} The current Telegram configuration
 */
function getTelegramConfig() {
  try {
    initTelegramConfig();
    return JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf8'));
  } catch (error) {
    console.error('Error reading Telegram config:', error.message);
    return {
      enabled: false,
      botToken: '',
      chatId: '',
      notifyOnRuleTrigger: true,
      notifyOnWarning: true,
      notifyOnGridChange: false,
      notifyOnBatteryLow: false,
      batteryLowThreshold: 20,
      maxNotificationsPerHour: 10
    };
  }
}

/**
 * Update Telegram configuration
 * @param {Object} newConfig - New configuration settings
 * @returns {Boolean} Success status
 */
function updateTelegramConfig(newConfig) {
  try {
    initTelegramConfig();
    const currentConfig = getTelegramConfig();
    
    // Merge current and new config
    const updatedConfig = { ...currentConfig, ...newConfig };
    
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));
    return true;
  } catch (error) {
    console.error('Error updating Telegram config:', error.message);
    return false;
  }
}

/**
 * Test Telegram bot connection
 * @param {string} botToken - Telegram bot token to test
 * @param {string} chatId - Telegram chat ID to test
 * @returns {Promise<Object>} Test result
 */
async function testTelegramConnection(botToken, chatId) {
  try {
    const message = 'This is a test message from CARBONOZ SolarAutopilot Addon. If you see this, your Telegram notifications are working correctly!';
    
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      }
    );
    
    if (response.status === 200 && response.data.ok) {
      return { success: true, message: 'Telegram connection successful!' };
    } else {
      return { success: false, message: 'Telegram API responded, but with an error.' };
    }
  } catch (error) {
    console.error('Telegram connection test failed:', error.message);
    return { 
      success: false, 
      message: `Telegram connection failed: ${error.response?.data?.description || error.message}` 
    };
  }
}

/**
 * Send notification to Telegram
 * @param {string} message - Message to send
 * @param {Object} options - Additional options
 * @returns {Promise<boolean>} Success status
 */
async function sendTelegramNotification(message, options = {}) {
  try {
    const config = getTelegramConfig();
    
    // Check if notifications are enabled
    if (!config.enabled || !config.botToken || !config.chatId) {
      return false;
    }
    
    // Rate limiting
    const now = new Date();
    
    // Reset counter if it's been more than an hour since last reset
    if (!config.notificationResetTime || 
        (now - new Date(config.notificationResetTime)) > 3600000) {
      config.notificationCount = 0;
      config.notificationResetTime = now.toISOString();
      updateTelegramConfig({
        notificationCount: 0,
        notificationResetTime: now.toISOString()
      });
    }
    
    // Check if exceeded hourly limit
    if (config.notificationCount >= config.maxNotificationsPerHour) {
      console.log('Hourly notification limit reached, skipping notification');
      return false;
    }
    
    // Format message with HTML if not already formatted
    let formattedMessage = message;
    if (options.formatAsHtml && !message.includes('<b>')) {
      formattedMessage = `<b>🔔 Energy Monitor Alert</b>\n\n${message}`;
    }
    
    // Add timestamp if requested
    if (options.includeTimestamp) {
      const timestamp = now.toLocaleString();
      formattedMessage += `\n\n<i>Sent at: ${timestamp}</i>`;
    }
    
    const response = await axios.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        chat_id: config.chatId,
        text: formattedMessage,
        parse_mode: 'HTML',
        disable_notification: options.silent || false
      }
    );
    
    if (response.status === 200 && response.data.ok) {
      // Update notification count and last notification time
      updateTelegramConfig({
        notificationCount: config.notificationCount + 1,
        lastNotificationTime: now.toISOString()
      });
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
    return false;
  }
}

/**
 * Generate a daily summary message
 * @param {Object} systemState - Current system state
 * @returns {string} Formatted summary message
 */
function generateDailySummary(systemState) {
  const timestamp = new Date().toLocaleString();
  
  let summary = `<b>🔋 Daily Energy Summary</b>\n\n`;
  
  if (systemState.battery_soc !== null) {
    summary += `<b>Battery:</b> ${systemState.battery_soc}%\n`;
  }
  
  if (systemState.pv_power !== null) {
    summary += `<b>Solar Power:</b> ${systemState.pv_power} W\n`;
  }
  
  if (systemState.load !== null) {
    summary += `<b>Load:</b> ${systemState.load} W\n`;
  }
  
  if (systemState.grid_power !== null) {
    summary += `<b>Grid Power:</b> ${systemState.grid_power} W\n`;
  }
  
  if (systemState.grid_voltage !== null) {
    summary += `<b>Grid Voltage:</b> ${systemState.grid_voltage} V\n`;
  }
  
  if (systemState.inverter_state !== null) {
    summary += `<b>Inverter State:</b> ${systemState.inverter_state}\n`;
  }
  
  summary += `\n<i>Generated at: ${timestamp}</i>`;
  
  return summary;
}

/**
 * Send notification about rule trigger
 * @param {Object} rule - The rule that was triggered
 * @param {Object} systemState - Current system state
 * @returns {Promise<boolean>} Success status
 */
async function notifyRuleTrigger(rule, systemState) {
  const config = getTelegramConfig();
  
  // Skip if rule notifications are disabled
  if (!config.enabled || !config.notifyOnRuleTrigger) {
    return false;
  }
  
  const message = `<b>⚡ Rule Triggered</b>\n\n` +
                 `<b>Rule:</b> ${rule.name}\n` +
                 `<b>Description:</b> ${rule.description || 'No description'}\n` +
                 `<b>Actions:</b> ${formatRuleActions(rule.actions)}\n\n` +
                 `<b>Current System State:</b>\n` +
                 `- Battery: ${systemState.battery_soc}%\n` +
                 `- Solar: ${systemState.pv_power} W\n` +
                 `- Load: ${systemState.load} W\n` +
                 `- Grid: ${systemState.grid_power} W`;
  
  return await sendTelegramNotification(message, {
    formatAsHtml: false,
    includeTimestamp: true,
    silent: false
  });
}

/**
 * Format rule actions for display in notification
 * @param {Array} actions - List of rule actions
 * @returns {string} Formatted actions text
 */
function formatRuleActions(actions) {
  if (!actions || actions.length === 0) {
    return 'No actions';
  }
  
  return actions.map(action => 
    `Set ${action.setting} to ${action.value} on ${action.inverter}`
  ).join(', ');
}

/**
 * Send battery low warning notification
 * @param {number} batteryLevel - Current battery level
 * @returns {Promise<boolean>} Success status
 */
async function notifyBatteryLow(batteryLevel) {
  const config = getTelegramConfig();
  
  // Skip if battery notifications are disabled
  if (!config.enabled || !config.notifyOnBatteryLow || batteryLevel > config.batteryLowThreshold) {
    return false;
  }
  
  const message = `<b>🔋 Low Battery Warning</b>\n\n` +
                 `Battery level is critically low at <b>${batteryLevel}%</b>\n` +
                 `This is below your configured threshold of ${config.batteryLowThreshold}%.\n\n` +
                 `Consider taking action to prevent system shutdown.`;
  
  return await sendTelegramNotification(message, {
    formatAsHtml: false,
    includeTimestamp: true,
    silent: false
  });
}

/**
 * Send grid status change notification
 * @param {string} status - New grid status
 * @param {number} voltage - Current grid voltage
 * @returns {Promise<boolean>} Success status
 */
async function notifyGridChange(status, voltage) {
  const config = getTelegramConfig();
  
  // Skip if grid notifications are disabled
  if (!config.enabled || !config.notifyOnGridChange) {
    return false;
  }
  
  const message = `<b>🔌 Grid Status Change</b>\n\n` +
                 `Grid is now: <b>${status}</b>\n` +
                 `Current voltage: ${voltage} V`;
  
  return await sendTelegramNotification(message, {
    formatAsHtml: false,
    includeTimestamp: true,
    silent: false
  });
}

/**
 * Send custom warning notification
 * @param {string} warningMessage - Warning message to send
 * @param {Object} systemState - Current system state
 * @returns {Promise<boolean>} Success status
 */
async function sendWarningNotification(warningMessage, systemState = {}) {
  const config = getTelegramConfig();
  
  // Skip if warning notifications are disabled
  if (!config.enabled || !config.notifyOnWarning) {
    return false;
  }
  
  let message = `<b>⚠️ Warning</b>\n\n${warningMessage}`;
  
  // Add system state if available
  if (Object.keys(systemState).length > 0) {
    message += `\n\n<b>Current System State:</b>\n`;
    
    if (systemState.battery_soc !== null && systemState.battery_soc !== undefined) {
      message += `- Battery: ${systemState.battery_soc}%\n`;
    }
    
    if (systemState.pv_power !== null && systemState.pv_power !== undefined) {
      message += `- Solar: ${systemState.pv_power} W\n`;
    }
    
    if (systemState.load !== null && systemState.load !== undefined) {
      message += `- Load: ${systemState.load} W\n`;
    }
    
    if (systemState.grid_power !== null && systemState.grid_power !== undefined) {
      message += `- Grid: ${systemState.grid_power} W\n`;
    }
  }
  
  return await sendTelegramNotification(message, {
    formatAsHtml: false,
    includeTimestamp: true,
    silent: false
  });
}

module.exports = {
  initTelegramConfig,
  getTelegramConfig,
  updateTelegramConfig,
  testTelegramConnection,
  sendTelegramNotification,
  notifyRuleTrigger,
  notifyBatteryLow,
  notifyGridChange,
  sendWarningNotification,
  generateDailySummary
};