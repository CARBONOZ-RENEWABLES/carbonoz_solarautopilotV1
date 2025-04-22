// telegram-routes.js - Complete API routes for Telegram notifications
const express = require('express');
const router = express.Router();
const telegramService = require('../utils/telegram-service');
const notificationRules = require('../utils/notification-rules');

// Initialize Telegram configuration on module load
telegramService.initTelegramConfig();
notificationRules.initNotificationRules();

/**
 * Get Telegram configuration
 */
router.get('/config', (req, res) => {
  try {
    const config = telegramService.getTelegramConfig();
    res.json(config);
  } catch (error) {
    console.error('Error getting Telegram config:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get Telegram configuration',
      message: error.message
    });
  }
});

/**
 * Update Telegram configuration
 */
router.post('/config', (req, res) => {
  try {
    const newConfig = req.body;
    const success = telegramService.updateTelegramConfig(newConfig);
    
    if (success) {
      res.json({
        success: true,
        message: 'Telegram configuration updated successfully'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Failed to update Telegram configuration'
      });
    }
  } catch (error) {
    console.error('Error updating Telegram config:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to update Telegram configuration',
      message: error.message
    });
  }
});

/**
 * Test Telegram connection
 */
router.post('/test', async (req, res) => {
  try {
    const { botToken, chatId } = req.body;
    
    if (!botToken || !chatId) {
      return res.status(400).json({
        success: false,
        message: 'Bot token and chat ID are required'
      });
    }
    
    const result = await telegramService.testTelegramConnection(botToken, chatId);
    res.json(result);
  } catch (error) {
    console.error('Error testing Telegram connection:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Connection test failed',
      error: error.message
    });
  }
});

/**
 * Send a manual notification
 */
router.post('/send', async (req, res) => {
  try {
    const { message, options } = req.body;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Message content is required'
      });
    }
    
    const result = await telegramService.sendTelegramNotification(message, options);
    
    if (result) {
      res.json({
        success: true,
        message: 'Notification sent successfully'
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to send notification, check Telegram settings'
      });
    }
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send notification',
      message: error.message
    });
  }
});

/**
 * Get all notification rules
 */
router.get('/notification-rules', (req, res) => {
  try {
    const rules = notificationRules.getNotificationRules();
    res.json(rules);
  } catch (error) {
    console.error('Error getting notification rules:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get notification rules',
      message: error.message
    });
  }
});

/**
 * Get a notification rule by ID
 */
router.get('/notification-rules/:id', (req, res) => {
  try {
    const ruleId = req.params.id;
    const rule = notificationRules.getNotificationRuleById(ruleId);
    
    if (rule) {
      res.json(rule);
    } else {
      res.status(404).json({
        success: false,
        message: 'Notification rule not found'
      });
    }
  } catch (error) {
    console.error('Error getting notification rule:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get notification rule',
      message: error.message
    });
  }
});

/**
 * Add or update a notification rule
 */
router.post('/notification-rules', (req, res) => {
  try {
    const ruleData = req.body;
    
    if (!ruleData.name || !ruleData.messageTemplate) {
      return res.status(400).json({
        success: false,
        message: 'Rule name and message template are required'
      });
    }
    
    // Ensure at least one condition
    if (!ruleData.conditions || ruleData.conditions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one condition is required'
      });
    }
    
    const success = notificationRules.saveNotificationRule(ruleData);
    
    if (success) {
      res.json({
        success: true,
        message: `Notification rule ${ruleData.id ? 'updated' : 'created'} successfully`
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Failed to save notification rule'
      });
    }
  } catch (error) {
    console.error('Error saving notification rule:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to save notification rule',
      message: error.message
    });
  }
});

/**
 * Delete a notification rule
 */
router.delete('/notification-rules/:id', (req, res) => {
  try {
    const ruleId = req.params.id;
    const success = notificationRules.deleteNotificationRule(ruleId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Notification rule deleted successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        message: 'Notification rule not found or could not be deleted'
      });
    }
  } catch (error) {
    console.error('Error deleting notification rule:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete notification rule',
      message: error.message
    });
  }
});

/**
 * Toggle a notification rule enabled/disabled
 */
router.post('/notification-rules/:id/toggle', (req, res) => {
  try {
    const ruleId = req.params.id;
    const { enabled } = req.body;
    
    if (enabled === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Enabled status is required'
      });
    }
    
    const rule = notificationRules.getNotificationRuleById(ruleId);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'Notification rule not found'
      });
    }
    
    rule.enabled = !!enabled;
    const success = notificationRules.saveNotificationRule(rule);
    
    if (success) {
      res.json({
        success: true,
        message: `Notification rule ${enabled ? 'enabled' : 'disabled'} successfully`
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Failed to update notification rule'
      });
    }
  } catch (error) {
    console.error('Error toggling notification rule:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to toggle notification rule',
      message: error.message
    });
  }
});

/**
 * Manually trigger a rule for testing
 */
router.post('/notification-rules/:id/test', async (req, res) => {
  try {
    const ruleId = req.params.id;
    const rule = notificationRules.getNotificationRuleById(ruleId);
    
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: 'Notification rule not found'
      });
    }
    
    // Use current system state if provided, otherwise use sample values
    const systemState = req.body.systemState || {
      battery_soc: 50,
      pv_power: 2000,
      load: 1500,
      grid_voltage: 230,
      grid_power: 800,
      inverter_state: 'Online'
    };
    
    // Format the message with system state values
    const message = notificationRules.formatMessage(rule.messageTemplate, systemState);
    
    // Add priority icon to message
    const formattedMessage = `<b>${rule.priority === 'high' ? '🔴' : (rule.priority === 'medium' ? '🟠' : '🟢')} ${rule.name} (TEST)</b>\n\n${message}`;
    
    // Send the notification
    const result = await telegramService.sendTelegramNotification(formattedMessage, {
      formatAsHtml: false, // Already formatted with HTML
      includeTimestamp: true,
      silent: rule.silent || false
    });
    
    if (result) {
      res.json({
        success: true,
        message: 'Test notification sent successfully',
        formattedMessage: formattedMessage
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to send test notification, check Telegram settings',
        formattedMessage: formattedMessage
      });
    }
  } catch (error) {
    console.error('Error testing notification rule:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to test notification rule',
      message: error.message
    });
  }
});

/**
 * Get notification statistics
 */
router.get('/stats', (req, res) => {
  try {
    // Get Telegram config which contains notification counts
    const config = telegramService.getTelegramConfig();
    
    // Get all rules to count active rules, etc.
    const rules = notificationRules.getNotificationRules();
    
    // Calculate statistics
    const stats = {
      enabled: config.enabled,
      totalRules: rules.length,
      activeRules: rules.filter(rule => rule.enabled).length,
      notificationsSent: config.notificationCount || 0,
      lastNotification: config.lastNotificationTime,
      hourlyLimit: config.maxNotificationsPerHour || 10,
      resetTime: config.notificationResetTime
    };
    
    res.json(stats);
  } catch (error) {
    console.error('Error getting notification stats:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get notification statistics',
      message: error.message
    });
  }
});

module.exports = router;