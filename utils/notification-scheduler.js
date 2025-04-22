// notification-scheduler.js - Schedules notification tasks
const cron = require('node-cron');
const telegramService = require('./telegram-service');
const notificationIntegration = require('./notification-integration');

/**
 * Initialize scheduled notification tasks
 * @param {Object} currentSystemState - Reference to the current system state object
 */
function initNotificationScheduler(currentSystemState) {
  // Check Telegram configuration
  const config = telegramService.getTelegramConfig();

  // Schedule daily summary task (check every minute for the configured time)
  cron.schedule('* * * * *', () => {
    try {
      const currentConfig = telegramService.getTelegramConfig();
      
      // Skip if daily summary is disabled
      if (!currentConfig.enabled || !currentConfig.dailySummary) {
        return;
      }
      
      const now = new Date();
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      
      // If current time matches the configured time
      if (currentTime === currentConfig.dailySummaryTime) {
        console.log('Sending daily system summary...');
        notificationIntegration.sendDailySummary(currentSystemState);
      }
    } catch (error) {
      console.error('Error in daily summary scheduler:', error);
    }
  });

  // Hourly maintenance task (clean up notification counters, etc.)
  cron.schedule('0 * * * *', () => {
    try {
      const currentConfig = telegramService.getTelegramConfig();
      
      // Reset notification count if it's been more than an hour since last reset
      const now = new Date();
      if (currentConfig.notificationResetTime) {
        const resetTime = new Date(currentConfig.notificationResetTime);
        const hoursSinceReset = (now - resetTime) / (1000 * 60 * 60);
        
        if (hoursSinceReset >= 1) {
          console.log('Resetting notification counters...');
          telegramService.updateTelegramConfig({
            notificationCount: 0,
            notificationResetTime: now.toISOString()
          });
        }
      } else {
        // Initialize reset time if not set
        telegramService.updateTelegramConfig({
          notificationResetTime: now.toISOString()
        });
      }
    } catch (error) {
      console.error('Error in hourly maintenance scheduler:', error);
    }
  });

  // Regular system monitoring (every 5 minutes)
  cron.schedule('*/5 * * * *', () => {
    try {
      // Process notifications based on current system state
      notificationIntegration.processNotifications(currentSystemState);
    } catch (error) {
      console.error('Error in system monitoring scheduler:', error);
    }
  });

  console.log('Notification scheduler initialized');
}


/**
 * Process rule triggers for notifications
 * @param {Object} rule - Triggered automation rule 
 * @param {Object} currentSystemState - Current system state
 */
async function handleRuleTriggerNotifications(rule, currentSystemState) {
  try {
    // Get notification rules from notification-rules.js
    const notificationRules = require('./notification-rules').getNotificationRules();
    
    // Find notification rules that were created from this automation rule
    // We can identify these by checking if the rule.id is mentioned in the notification rule ID
    const matchingNotificationRules = notificationRules.filter(notifRule => 
      notifRule.id && notifRule.id.includes(`notification-${rule.id}`)
    );
    
    // If we have matching notification rules, send notifications
    if (matchingNotificationRules.length > 0) {
      for (const notifRule of matchingNotificationRules) {
        // Skip if rule is disabled
        if (!notifRule.enabled) continue;
        
        // Check cooldown period
        if (notifRule.lastTriggered && notifRule.cooldownMinutes) {
          const lastTriggeredTime = new Date(notifRule.lastTriggered).getTime();
          const cooldownMs = notifRule.cooldownMinutes * 60 * 1000;
          const currentTime = new Date().getTime();
          
          if (currentTime - lastTriggeredTime < cooldownMs) {
            // Still in cooldown period, skip this notification
            continue;
          }
        }
        
        // Format the message template with system state and rule info
        let messageText = notifRule.messageTemplate;
        
        // Replace {rule_name} with the actual rule name
        messageText = messageText.replace(/{rule_name}/g, rule.name);
        
        // Replace other placeholders with system state values
        for (const [key, value] of Object.entries(currentSystemState)) {
          if (value !== null && value !== undefined) {
            const placeholder = `{${key}}`;
            messageText = messageText.replace(new RegExp(placeholder, 'g'), value);
          }
        }
        
        // Send the notification
        await require('./telegram-service').sendTelegramNotification(messageText, {
          formatAsHtml: false, // It's already formatted in the template
          includeTimestamp: true,
          silent: notifRule.silent || false
        });
        
        // Update the last triggered time
        require('./notification-rules').updateRuleLastTriggered(notifRule.id);
      }
    }
  } catch (error) {
    console.error('Error processing notification for rule trigger:', error);
  }
}


module.exports = {
  initNotificationScheduler,
  handleRuleTriggerNotifications
};