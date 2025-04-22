// notification-integration.js - Integrates Telegram notifications with the existing system
const telegramService = require('./telegram-service');
const notificationRules = require('./notification-rules');

/**
 * Processes system state for notifications
 * @param {Object} systemState - Current system state
 */
async function processNotifications(systemState) {
  try {
    // Check if battery low notification should be sent
    if (systemState.battery_soc !== null && systemState.battery_soc !== undefined) {
      await telegramService.notifyBatteryLow(systemState.battery_soc);
    }

    // Process custom notification rules
    const triggeredRules = notificationRules.checkNotificationRules(systemState);
    
    for (const rule of triggeredRules) {
      await telegramService.sendTelegramNotification(rule.formattedMessage, {
        formatAsHtml: true,
        includeTimestamp: true,
        silent: rule.silent || false
      });
    }
  } catch (error) {
    console.error('Error processing notifications:', error);
  }
}

/**
 * Handles rule trigger events and sends notifications if configured
 * @param {Object} rule - The rule that was triggered
 * @param {Object} systemState - Current system state
 */
async function handleRuleTrigger(rule, systemState) {
  try {
    // Get Telegram config to check notification preferences
    const telegramConfig = require('./telegram-service').getTelegramConfig();
    
    // Skip if Telegram is disabled or rule notifications are disabled
    if (!telegramConfig.enabled || !telegramConfig.notifyOnRuleTrigger) {
      return false;
    }
    
    // Process any notification rules created from this automation rule
    const notificationScheduler = require('./notification-scheduler');
    await notificationScheduler.handleRuleTriggerNotifications(rule, systemState);
    
    // Format the message with HTML for Telegram for the basic notification
    const message = `<b>⚡ Rule Triggered</b>\n\n` +
                   `<b>Rule:</b> ${rule.name}\n` +
                   `<b>Description:</b> ${rule.description || 'No description'}\n` +
                   `<b>Actions:</b> ${formatRuleActions(rule.actions)}\n\n` +
                   `<b>Current System State:</b>\n` +
                   `- Battery: ${systemState.battery_soc}%\n` +
                   `- Solar: ${systemState.pv_power} W\n` +
                   `- Load: ${systemState.load} W\n` +
                   `- Grid: ${systemState.grid_power} W`;
    
    // Send the basic notification using the Telegram service
    return await require('./telegram-service').sendTelegramNotification(message, {
      formatAsHtml: false, // Already formatted as HTML
      includeTimestamp: true,
      silent: false // Important alerts should make a sound
    });
  } catch (error) {
    console.error('Error handling rule trigger notification:', error);
    return false;
  }
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
 * Monitors grid voltage changes for potential outage alerts
 * @param {number} newVoltage - New grid voltage
 * @param {number} previousVoltage - Previous grid voltage
 */
async function monitorGridVoltage(newVoltage, previousVoltage) {
  try {
    // Detect significant voltage drops (potential outage)
    if (previousVoltage > 180 && newVoltage < 180) {
      await telegramService.notifyGridChange('Possible Outage', newVoltage);
    }
    // Detect grid recovery
    else if (previousVoltage < 180 && newVoltage >= 180) {
      await telegramService.notifyGridChange('Recovered', newVoltage);
    }
    // Detect significant voltage fluctuations (>20V)
    else if (Math.abs(newVoltage - previousVoltage) > 20) {
      await telegramService.notifyGridChange('Unstable', newVoltage);
    }
  } catch (error) {
    console.error('Error monitoring grid voltage:', error);
  }
}

/**
 * Sends a daily system summary
 * @param {Object} systemState - Current system state
 */
async function sendDailySummary(systemState) {
  try {
    const config = telegramService.getTelegramConfig();
    
    // Skip if daily summary is disabled
    if (!config.enabled || !config.dailySummary) {
      return;
    }
    
    const summaryMessage = telegramService.generateDailySummary(systemState);
    
    await telegramService.sendTelegramNotification(summaryMessage, {
      formatAsHtml: false,
      includeTimestamp: false,
      silent: true
    });
  } catch (error) {
    console.error('Error sending daily summary:', error);
  }
}

/**
 * Handles system warnings and sends notifications
 * @param {string} warningMessage - Warning message to send
 * @param {Object} systemState - Current system state
 */
async function handleSystemWarning(warningMessage, systemState = {}) {
  try {
    await telegramService.sendWarningNotification(warningMessage, systemState);
  } catch (error) {
    console.error('Error handling system warning notification:', error);
  }
}

module.exports = {
  processNotifications,
  handleRuleTrigger,
  monitorGridVoltage,
  sendDailySummary,
  handleSystemWarning,
  formatRuleActions
};