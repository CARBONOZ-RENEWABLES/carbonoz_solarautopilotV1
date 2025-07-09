// services/telegramService.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration file path
const TELEGRAM_CONFIG_FILE = path.join(__dirname, '..', 'data', 'telegram_config.json');

// Default configuration structure - NO DEFAULT NOTIFICATION RULES
const defaultConfig = {
  enabled: false,
  botToken: '',
  chatIds: [],
  notificationRules: [] // Empty by default - user must add manually
};

// Ensure configuration file exists
function ensureConfigFile() {
  const configDir = path.dirname(TELEGRAM_CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) {
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
  }
}

// Read configuration
function getConfig() {
  ensureConfigFile();
  try {
    return JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf8'));
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

// Send message to a specific chat ID
async function sendMessageToChatId(chatId, message) {
  const config = getConfig();
  
  if (!config.enabled || !config.botToken) {
    console.log('Telegram notifications disabled or not configured');
    return false;
  }
  
  // Try up to 3 times with increasing delays
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML'
        },
        { timeout: 5000 } // 5 second timeout
      );
      
      if (response.data && response.data.ok) {
        return true;
      } else {
        console.error(`Telegram API returned error for chat ${chatId}:`, response.data);
      }
    } catch (error) {
      console.error(`Attempt ${attempt}/3 failed to send message to chat ${chatId}:`, 
        error.response?.data?.description || error.message);
      
      // If not the last attempt, wait before retrying
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000)); // Wait 1s, 2s, 3s
      }
    }
  }
  
  return false; // All attempts failed
}

// Send message to all configured chat IDs
async function broadcastMessage(message) {
  const config = getConfig();
  
  if (!config.enabled || !config.botToken || !config.chatIds.length) {
    console.log('Telegram notifications disabled or not configured properly');
    return false;
  }
  
  try {
    // Send to all configured chat IDs with fallback handling
    const results = await Promise.allSettled(
      config.chatIds.map(chatId => sendMessageToChatId(chatId, message))
    );
    
    // Count successful deliveries
    const successCount = results.filter(result => 
      result.status === 'fulfilled' && result.value === true
    ).length;
    
    // Log delivery results
    console.log(`Sent notification to ${successCount}/${config.chatIds.length} chats`);
    
    // If any delivery was successful, return true
    return successCount > 0;
  } catch (error) {
    console.error('Error broadcasting Telegram message:', error);
    return false;
  }
}

// Format message for a rule trigger
function formatRuleTriggerMessage(rule, systemState) {
  let message = `<b>🔔 SolarAutopilot Rule Triggered!</b>\n\n`;
  message += `<b>Rule:</b> ${rule.name}\n`;
  
  if (rule.description) {
    message += `<b>Description:</b> ${rule.description}\n`;
  }
  
  message += `\n<b>System State:</b>\n`;
  
  if (systemState.battery_soc !== null && systemState.battery_soc !== undefined) {
    message += `• Battery: ${systemState.battery_soc}%\n`;
  }
  
  if (systemState.pv_power !== null && systemState.pv_power !== undefined) {
    message += `• PV Power: ${systemState.pv_power}W\n`;
  }
  
  if (systemState.load !== null && systemState.load !== undefined) {
    message += `• Load: ${systemState.load}W\n`;
  }
  
  if (systemState.grid_power !== null && systemState.grid_power !== undefined) {
    message += `• Grid Power: ${systemState.grid_power}W\n`;
  }
  
  if (rule.actions && rule.actions.length > 0) {
    message += `\n<b>Actions Taken:</b>\n`;
    rule.actions.forEach((action, index) => {
      message += `• ${action.setting}: ${action.value} (${action.inverter})\n`;
    });
  }
  
  message += `\n<i>Triggered at: ${new Date().toLocaleString()}</i>`;
  
  return message;
}

// Format warning message - UPDATED TEXT
function formatWarningMessage(warning, systemState) {
  let message = `<b>⚠️ SolarAutopilot Add-on Warning!</b>\n\n`;
  message += `<b>Warning:</b> ${warning.title}\n`;
  
  if (warning.description) {
    message += `<b>Description:</b> ${warning.description}\n`;
  }
  
  message += `\n<b>System State:</b>\n`;
  Object.entries(systemState).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      message += `• ${key.replace(/_/g, ' ')}: ${value}\n`;
    }
  });
  
  message += `\n<i>Warning generated at: ${new Date().toLocaleString()}</i>`;
  
  return message;
}

// Should notification be sent for this rule? - STRICT USER CONTROL
function shouldNotifyForRule(ruleId) {
  const config = getConfig();
  
  if (!config.enabled) {
    console.log(`Telegram notifications disabled for rule ${ruleId}`);
    return false;
  }
  
  if (!config.botToken || !config.chatIds || config.chatIds.length === 0) {
    console.log(`Telegram not fully configured (missing token or chat IDs) for rule ${ruleId}`);
    return false;
  }
  
  // Check if we have a notification rule for this rule ID that is explicitly enabled
  const hasEnabledRule = config.notificationRules.some(rule => 
    rule.enabled === true && 
    rule.type === 'rule' && 
    rule.ruleId === ruleId
  );
  
  console.log(`Notification for rule ${ruleId} ${hasEnabledRule ? 'enabled' : 'disabled'} (user-configured)`);
  return hasEnabledRule;
}

// Should notification be sent for this warning type? - STRICT USER CONTROL
function shouldNotifyForWarning(warningType) {
  const config = getConfig();
  
  if (!config.enabled) {
    console.log(`Telegram notifications disabled for warning ${warningType}`);
    return false;
  }
  
  if (!config.botToken || !config.chatIds || config.chatIds.length === 0) {
    console.log(`Telegram not fully configured (missing token or chat IDs) for warning ${warningType}`);
    return false;
  }
  
  // Check if we have a notification rule for this warning type that is explicitly enabled
  const hasEnabledRule = config.notificationRules.some(rule => 
    rule.enabled === true && 
    rule.type === 'warning' && 
    rule.warningType === warningType
  );
  
  console.log(`Notification for warning ${warningType} ${hasEnabledRule ? 'enabled' : 'disabled'} (user-configured)`);
  return hasEnabledRule;
}

// Add chat ID to configuration
function addChatId(chatId) {
  const config = getConfig();
  if (!config.chatIds.includes(chatId)) {
    config.chatIds.push(chatId);
    return saveConfig(config);
  }
  return true;
}

// Remove chat ID from configuration
function removeChatId(chatId) {
  const config = getConfig();
  config.chatIds = config.chatIds.filter(id => id !== chatId);
  return saveConfig(config);
}

// Add a notification rule
function addNotificationRule(rule) {
  const config = getConfig();
  config.notificationRules.push(rule);
  return saveConfig(config);
}

// Update a notification rule
function updateNotificationRule(ruleId, updatedRule) {
  const config = getConfig();
  const index = config.notificationRules.findIndex(r => r.id === ruleId);
  
  if (index !== -1) {
    config.notificationRules[index] = { ...updatedRule, id: ruleId };
    return saveConfig(config);
  }
  
  return false;
}

// Delete a notification rule
function deleteNotificationRule(ruleId) {
  const config = getConfig();
  config.notificationRules = config.notificationRules.filter(rule => rule.id !== ruleId);
  return saveConfig(config);
}

// Update Telegram configuration
function updateConfig(newConfig) {
  const currentConfig = getConfig();
  const updatedConfig = { ...currentConfig, ...newConfig };
  return saveConfig(updatedConfig);
}

// Test the bot token
async function testBotToken(token) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    return {
      success: response.data.ok,
      botInfo: response.data.result
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.description || error.message
    };
  }
}

module.exports = {
  getConfig,
  saveConfig,
  updateConfig,
  sendMessageToChatId,
  broadcastMessage,
  formatRuleTriggerMessage,
  formatWarningMessage,
  shouldNotifyForRule,
  shouldNotifyForWarning,
  addChatId,
  removeChatId,
  addNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  testBotToken
};
