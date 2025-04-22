// notification-rules-checker.js - Checks notification rules against system state
const telegramService = require('./telegram-service');
const notificationRules = require('./notification-rules');

/**
 * Process notification rules based on current system state
 * @param {Object} systemState - Current system state (battery_soc, pv_power, etc.)
 */
async function processNotificationRules(systemState) {
  try {
    // Skip if no system state is available
    if (!systemState || Object.keys(systemState).every(key => 
      systemState[key] === null || systemState[key] === undefined)) {
      return;
    }
    
    // Get Telegram config to check if notifications are enabled
    const telegramConfig = telegramService.getTelegramConfig();
    
    // Skip if Telegram is not enabled
    if (!telegramConfig.enabled || !telegramConfig.botToken || !telegramConfig.chatId) {
      return;
    }
    
    // Check battery low notification (direct, not rule-based)
    if (telegramConfig.notifyOnBatteryLow && 
        systemState.battery_soc !== null && 
        systemState.battery_soc !== undefined && 
        systemState.battery_soc <= telegramConfig.batteryLowThreshold) {
      await telegramService.notifyBatteryLow(systemState.battery_soc);
    }
    
    // Load all notification rules
    const allRules = notificationRules.getNotificationRules();
    
    // Skip if no rules
    if (!allRules || allRules.length === 0) {
      return;
    }
    
    // Check each rule against the current system state
    for (const rule of allRules) {
      // Skip if rule is disabled
      if (!rule.enabled) {
        continue;
      }
      
      // Check cooldown period
      if (rule.lastTriggered && rule.cooldownMinutes) {
        const lastTriggeredTime = new Date(rule.lastTriggered).getTime();
        const cooldownMs = rule.cooldownMinutes * 60 * 1000;
        const currentTime = new Date().getTime();
        
        if (currentTime - lastTriggeredTime < cooldownMs) {
          // Still in cooldown period, skip this rule
          continue;
        }
      }
      
      // Evaluate all conditions (logical AND)
      let allConditionsMet = true;
      
      for (const condition of rule.conditions) {
        const { parameter, operator, value } = condition;
        const currentValue = systemState[parameter];
        
        // Skip if system state doesn't have this parameter
        if (currentValue === undefined || currentValue === null) {
          allConditionsMet = false;
          break;
        }
        
        // Evaluate the condition
        let conditionMet = false;
        
        switch (operator) {
          case 'gt': // greater than
            conditionMet = currentValue > value;
            break;
          case 'lt': // less than
            conditionMet = currentValue < value;
            break;
          case 'eq': // equal to
            conditionMet = currentValue === value;
            break;
          case 'gte': // greater than or equal to
            conditionMet = currentValue >= value;
            break;
          case 'lte': // less than or equal to
            conditionMet = currentValue <= value;
            break;
          case 'ne': // not equal to
            conditionMet = currentValue !== value;
            break;
          default:
            conditionMet = false;
        }
        
        if (!conditionMet) {
          allConditionsMet = false;
          break;
        }
      }
      
      // If all conditions are met, send notification
      if (allConditionsMet) {
        // Format message template with current values
        let message = rule.messageTemplate;
        
        // Replace placeholders like {battery_soc} with actual values
        for (const [key, value] of Object.entries(systemState)) {
          if (value !== null && value !== undefined) {
            const placeholder = `{${key}}`;
            message = message.replace(new RegExp(placeholder, 'g'), value);
          }
        }
        
        // Add rule information to the message
        const formattedMessage = `<b>${rule.priority === 'high' ? '🔴' : (rule.priority === 'medium' ? '🟠' : '🟢')} ${rule.name}</b>\n\n${message}`;
        
        // Send notification to Telegram
        await telegramService.sendTelegramNotification(formattedMessage, {
          formatAsHtml: false, // Already formatted with HTML
          includeTimestamp: true,
          silent: rule.silent || false
        });
        
        // Update last triggered time
        notificationRules.updateRuleLastTriggered(rule.id);
        
        console.log(`Notification rule '${rule.name}' triggered and notification sent`);
      }
    }
  } catch (error) {
    console.error('Error processing notification rules:', error);
  }
}

/**
 * Process system state changes for grid voltage monitoring
 * @param {number} newVoltage - New grid voltage
 * @param {number} previousVoltage - Previous grid voltage  
 */
async function checkGridVoltageChanges(newVoltage, previousVoltage) {
  try {
    const telegramConfig = telegramService.getTelegramConfig();
    
    // Skip if grid notifications are disabled
    if (!telegramConfig.enabled || !telegramConfig.notifyOnGridChange) {
      return;
    }
    
    // Only proceed if both values are available
    if (newVoltage === null || previousVoltage === null) {
      return;
    }
    
    // Detect grid outage (voltage dropped below 180V)
    if (previousVoltage >= 180 && newVoltage < 180) {
      await telegramService.notifyGridChange('OUTAGE DETECTED', newVoltage);
      return;
    }
    
    // Detect grid recovery (voltage returned above 180V)
    if (previousVoltage < 180 && newVoltage >= 180) {
      await telegramService.notifyGridChange('RECOVERED', newVoltage);
      return;
    }
    
    // Detect significant voltage drop (more than 20V)
    if (previousVoltage - newVoltage > 20) {
      await telegramService.notifyGridChange('SIGNIFICANT VOLTAGE DROP', newVoltage);
      return;
    }
    
    // Detect significant voltage rise (more than 20V)
    if (newVoltage - previousVoltage > 20) {
      await telegramService.notifyGridChange('SIGNIFICANT VOLTAGE RISE', newVoltage);
      return;
    }
  } catch (error) {
    console.error('Error checking grid voltage changes:', error);
  }
}

/**
 * Check for battery state changes that should trigger notifications
 * @param {number} newLevel - New battery level (percentage)
 * @param {number} previousLevel - Previous battery level
 */
async function checkBatteryStateChanges(newLevel, previousLevel) {
  try {
    const telegramConfig = telegramService.getTelegramConfig();
    
    // Skip if battery notifications are disabled
    if (!telegramConfig.enabled || !telegramConfig.notifyOnBatteryLow) {
      return;
    }
    
    // Only proceed if both values are available
    if (newLevel === null || previousLevel === null) {
      return;
    }
    
    const threshold = telegramConfig.batteryLowThreshold || 20;
    
    // Battery dropped below threshold
    if (previousLevel > threshold && newLevel <= threshold) {
      await telegramService.notifyBatteryLow(newLevel);
      return;
    }
    
    // Battery recovered above threshold
    if (previousLevel <= threshold && newLevel > threshold) {
      await telegramService.sendTelegramNotification(
        `<b>🔋 Battery Recovered</b>\n\nBattery level has recovered to ${newLevel}%, which is above your configured threshold of ${threshold}%.`,
        { includeTimestamp: true }
      );
      return;
    }
    
    // Critical battery level (below 10%)
    if (newLevel <= 10 && (previousLevel > 10 || Math.abs(newLevel - previousLevel) >= 2)) {
      await telegramService.sendTelegramNotification(
        `<b>⚠️ CRITICAL BATTERY LEVEL</b>\n\nBattery is at ${newLevel}%, which is critically low. System may shut down soon if not addressed.`,
        { includeTimestamp: true }
      );
      return;
    }
  } catch (error) {
    console.error('Error checking battery state changes:', error);
  }
}

/**
 * Send a daily summary if configured
 * @param {Object} systemState - Current system state
 */
async function sendDailySummaryIfConfigured(systemState) {
  try {
    const telegramConfig = telegramService.getTelegramConfig();
    
    // Skip if daily summary is disabled
    if (!telegramConfig.enabled || !telegramConfig.dailySummary) {
      return;
    }
    
    // Get current time
    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    // Only send at the configured time
    if (currentTime !== telegramConfig.dailySummaryTime) {
      return;
    }
    
    // Generate and send the summary
    const summaryMessage = telegramService.generateDailySummary(systemState);
    
    await telegramService.sendTelegramNotification(summaryMessage, {
      formatAsHtml: false, // Already formatted as HTML
      includeTimestamp: false,
      silent: true // Daily summaries should be silent
    });
    
    console.log('Daily summary sent');
  } catch (error) {
    console.error('Error sending daily summary:', error);
  }
}

module.exports = {
  processNotificationRules,
  checkGridVoltageChanges,
  checkBatteryStateChanges,
  sendDailySummaryIfConfigured
};