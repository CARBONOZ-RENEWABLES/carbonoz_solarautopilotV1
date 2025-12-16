// services/telegramService.js - Complete Implementation

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Configuration file path
const TELEGRAM_CONFIG_FILE = path.join(__dirname, '..', 'data', 'telegram_config.json');

// Default configuration - NO AUTOMATIC NOTIFICATIONS
const defaultConfig = {
  enabled: false,
  botToken: '',
  chatIds: [],
  notificationRules: [], // User must manually configure these
  enhancedFeatures: true,
  inverterTypeSupport: true,
  autoNotifications: false, // Explicitly disabled
  aiChargingNotifications: {
    chargingStarted: false,
    chargingStopped: false,
    optimalPrice: false,
    negativePrice: false
  }
};

// Ensure configuration file exists
function ensureConfigFile() {
  const configDir = path.dirname(TELEGRAM_CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) {
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created Telegram configuration file (no automatic notifications)');
  }
}

// Get configuration
function getConfig() {
  ensureConfigFile();
  try {
    const config = JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf8'));
    
    // Merge with defaults to ensure all properties exist
    return { ...defaultConfig, ...config };
  } catch (error) {
    console.error('Error reading Telegram config:', error);
    return { ...defaultConfig };
  }
}

// Save configuration
function saveConfig(config) {
  ensureConfigFile();
  try {
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving Telegram config:', error);
    return false;
  }
}

// Update configuration
function updateConfig(updates) {
  const currentConfig = getConfig();
  const newConfig = { ...currentConfig, ...updates };
  return saveConfig(newConfig);
}

// Test bot token
async function testBotToken(botToken) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`, {
      timeout: 10000
    });
    
    if (response.data && response.data.ok) {
      return {
        success: true,
        botInfo: response.data.result
      };
    } else {
      return {
        success: false,
        error: 'Invalid bot token response'
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.description || error.message
    };
  }
}

// Add chat ID
function addChatId(chatId) {
  const config = getConfig();
  
  if (!config.chatIds.includes(chatId.toString())) {
    config.chatIds.push(chatId.toString());
    return saveConfig(config);
  }
  
  return true; // Already exists
}

// Remove chat ID
function removeChatId(chatId) {
  const config = getConfig();
  const index = config.chatIds.indexOf(chatId.toString());
  
  if (index !== -1) {
    config.chatIds.splice(index, 1);
    return saveConfig(config);
  }
  
  return false;
}

// Add notification rule
function addNotificationRule(rule) {
  const config = getConfig();
  config.notificationRules.push(rule);
  return saveConfig(config);
}

// Update notification rule
function updateNotificationRule(ruleId, updates) {
  const config = getConfig();
  const index = config.notificationRules.findIndex(rule => rule.id === ruleId);
  
  if (index !== -1) {
    config.notificationRules[index] = { ...config.notificationRules[index], ...updates };
    return saveConfig(config);
  }
  
  return false;
}

// Delete notification rule
function deleteNotificationRule(ruleId) {
  const config = getConfig();
  config.notificationRules = config.notificationRules.filter(rule => rule.id !== ruleId);
  return saveConfig(config);
}

// Check if we should notify for a specific warning type
function shouldNotifyForWarning(warningTypeId) {
  const config = getConfig();
  
  if (!config.enabled) return false;
  
  // Check if there's a user-configured rule for this warning type
  return config.notificationRules.some(rule => 
    rule.enabled && 
    rule.type === 'warning' && 
    rule.warningType === warningTypeId
  );
}

// Check if we should notify for a specific rule trigger
function shouldNotifyForRule(ruleId) {
  const config = getConfig();
  
  if (!config.enabled) return false;
  
  // Check if there's a user-configured rule for this rule ID
  return config.notificationRules.some(rule => 
    rule.enabled && 
    rule.type === 'rule' && 
    rule.ruleId === ruleId
  );
}

// Format warning message
function formatWarningMessage(warning, systemState) {
  const timestamp = new Date(warning.timestamp).toLocaleString();
  
  let message = `🚨 *${warning.title}*\n\n`;
  message += `📝 ${warning.description}\n\n`;
  message += `⚡ *Current Values:*\n`;
  
  if (systemState.battery_soc !== null && systemState.battery_soc !== undefined) {
    message += `🔋 Battery SoC: ${systemState.battery_soc}%\n`;
  }
  
  if (systemState.pv_power !== null && systemState.pv_power !== undefined) {
    message += `☀️ PV Power: ${systemState.pv_power}W\n`;
  }
  
  if (systemState.load !== null && systemState.load !== undefined) {
    message += `⚡ Load: ${systemState.load}W\n`;
  }
  
  if (systemState.grid_power !== null && systemState.grid_power !== undefined) {
    message += `🏠 Grid Power: ${systemState.grid_power}W\n`;
  }
  
  if (systemState.grid_voltage !== null && systemState.grid_voltage !== undefined) {
    message += `🔌 Grid Voltage: ${systemState.grid_voltage}V\n`;
  }
  
  message += `\n📅 Time: ${timestamp}`;
  message += `\n🎯 Priority: ${warning.priority.toUpperCase()}`;
  
  if (warning.triggered) {
    message += `\n\n📊 *Trigger Details:*\n`;
    message += `Parameter: ${warning.triggered.parameter}\n`;
    message += `Value: ${warning.triggered.value}\n`;
    message += `Threshold: ${warning.triggered.value} ${warning.triggered.condition} ${warning.triggered.threshold}`;
  }
  
  return message;
}

// Format rule trigger message
function formatRuleTriggerMessage(rule, systemState) {
  const timestamp = new Date().toLocaleString();
  
  let message = `🤖 *Rule Triggered: ${rule.name}*\n\n`;
  
  if (rule.description) {
    message += `📝 ${rule.description}\n\n`;
  }
  
  message += `⚡ *Current System State:*\n`;
  
  if (systemState.battery_soc !== null && systemState.battery_soc !== undefined) {
    message += `🔋 Battery SoC: ${systemState.battery_soc}%\n`;
  }
  
  if (systemState.pv_power !== null && systemState.pv_power !== undefined) {
    message += `☀️ PV Power: ${systemState.pv_power}W\n`;
  }
  
  if (systemState.load !== null && systemState.load !== undefined) {
    message += `⚡ Load: ${systemState.load}W\n`;
  }
  
  if (systemState.grid_power !== null && systemState.grid_power !== undefined) {
    message += `🏠 Grid Power: ${systemState.grid_power}W\n`;
  }
  
  message += `\n📅 Time: ${timestamp}`;
  
  if (rule.actions && rule.actions.length > 0) {
    message += `\n\n🔧 *Actions Taken:*\n`;
    rule.actions.forEach((action, index) => {
      message += `${index + 1}. Set ${action.setting} to ${action.value} on ${action.inverter}\n`;
    });
  }
  
  if (rule.triggerCount) {
    message += `\n📊 Total triggers: ${rule.triggerCount}`;
  }
  
  return message;
}

// Update AI charging notification settings
function updateAIChargingNotifications(settings) {
  const config = getConfig();
  config.aiChargingNotifications = { ...config.aiChargingNotifications, ...settings };
  return saveConfig(config);
}

// Check if AI charging notifications are enabled
function shouldNotifyForAICharging(eventType) {
  const config = getConfig();
  
  if (!config.enabled || !config.botToken || config.chatIds.length === 0) {
    return false;
  }
  
  return config.aiChargingNotifications[eventType] || false;
}

// Format AI charging message
function formatAIChargingMessage(eventType, data) {
  const timestamp = new Date().toLocaleString();
  let message = '';
  
  switch (eventType) {
    case 'chargingStarted':
      message = `🔋 *AI Charging Started*\n\n`;
      message += `🤖 The AI charging engine has started charging your battery\n\n`;
      if (data.reason) message += `📝 Reason: ${data.reason}\n`;
      if (data.price) message += `💰 Current Price: ${data.price}¢/kWh\n`;
      break;
      
    case 'chargingStopped':
      message = `⏹️ *AI Charging Stopped*\n\n`;
      message += `🤖 The AI charging engine has stopped charging your battery\n\n`;
      if (data.reason) message += `📝 Reason: ${data.reason}\n`;
      if (data.batterySOC) message += `🔋 Battery SOC: ${data.batterySOC}%\n`;
      break;
      
    case 'optimalPrice':
      message = `💰 *Optimal Price Alert*\n\n`;
      message += `⚡ Electricity price has reached optimal charging levels!\n\n`;
      message += `💲 Current Price: ${data.price}¢/kWh (≤8¢/kWh)\n`;
      message += `🎯 This is a great time to charge your battery\n`;
      break;
      
    case 'negativePrice':
      message = `🎉 *Negative Price Alert*\n\n`;
      message += `💸 You're getting PAID to use electricity!\n\n`;
      message += `💲 Current Price: ${data.price}¢/kWh\n`;
      message += `⚡ Maximum charging recommended\n`;
      break;
  }
  
  if (data.systemState) {
    message += `\n⚡ *Current System:*\n`;
    if (data.systemState.battery_soc !== null) message += `🔋 Battery: ${data.systemState.battery_soc}%\n`;
    if (data.systemState.pv_power !== null) message += `☀️ Solar: ${data.systemState.pv_power}W\n`;
    if (data.systemState.load !== null) message += `🏠 Load: ${data.systemState.load}W\n`;
  }
  
  message += `\n📅 ${timestamp}`;
  
  return message;
}

// Send AI charging notification
async function sendAIChargingNotification(eventType, data) {
  if (!shouldNotifyForAICharging(eventType)) {
    return false;
  }
  
  const message = formatAIChargingMessage(eventType, data);
  return await broadcastMessage(message);
}

// Send message to all configured chat IDs
async function broadcastMessage(message) {
  const config = getConfig();
  
  if (!config.enabled || !config.botToken || config.chatIds.length === 0) {
    console.log('Telegram notifications not properly configured (user-controlled)');
    return false;
  }
  
  let successCount = 0;
  
  for (const chatId of config.chatIds) {
    try {
      const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
      
      await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown'
      }, {
        timeout: 10000
      });
      
      successCount++;
    } catch (error) {
      console.error(`Failed to send Telegram message to ${chatId}:`, error.response?.data || error.message);
    }
  }
  
  console.log(`Sent user-configured Telegram notification to ${successCount}/${config.chatIds.length} chat(s)`);
  return successCount > 0;
}

module.exports = {
  getConfig,
  saveConfig,
  updateConfig,
  testBotToken,
  addChatId,
  removeChatId,
  addNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  shouldNotifyForWarning,
  shouldNotifyForRule,
  formatWarningMessage,
  formatRuleTriggerMessage,
  broadcastMessage,
  updateAIChargingNotifications,
  shouldNotifyForAICharging,
  sendAIChargingNotification
};
