// Enhanced notificationRoutes.js implementation - USER CONTROLLED NOTIFICATIONS

const express = require('express');
const router = express.Router();
const telegramService = require('../services/telegramService');
const warningService = require('../services/warningService');

// Telegram Configuration Routes

// Get Telegram configuration
router.get('/telegram/config', (req, res) => {
  const config = telegramService.getConfig();
  
  // Hide the bot token for security
  const safeConfig = {
    ...config,
    botToken: config.botToken ? '••••••••••' + config.botToken.slice(-4) : '',
    hasToken: !!config.botToken
  };
  
  res.json(safeConfig);
});

// Update Telegram configuration
router.post('/telegram/config', async (req, res) => {
  try {
    const { enabled, botToken } = req.body;
    
    // Validate bot token if provided
    if (botToken && botToken !== '••••••••••' + telegramService.getConfig().botToken?.slice(-4)) {
      const testResult = await telegramService.testBotToken(botToken);
      
      if (!testResult.success) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid bot token',
          details: testResult.error
        });
      }
      
      // If token is valid, update configuration
      const success = telegramService.updateConfig({ 
        enabled: enabled !== undefined ? enabled : telegramService.getConfig().enabled,
        botToken
      });
      
      res.json({ 
        success,
        message: success ? 'Telegram configuration updated. Remember to configure individual notification rules.' : 'Failed to update configuration',
        botInfo: testResult.botInfo
      });
    } else {
      // Update only enabled status
      const success = telegramService.updateConfig({ 
        enabled: enabled !== undefined ? enabled : telegramService.getConfig().enabled 
      });
      
      res.json({ 
        success,
        message: success ? 'Telegram configuration updated. Remember to configure individual notification rules.' : 'Failed to update configuration'
      });
    }
  } catch (error) {
    console.error('Error updating Telegram config:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while updating Telegram configuration'
    });
  }
});

// Test Telegram notification
router.post('/telegram/test', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    
    const success = await telegramService.broadcastMessage(message);
    
    res.json({
      success,
      message: success 
        ? 'Test message sent successfully' 
        : 'Failed to send test message. Check your configuration.'
    });
  } catch (error) {
    console.error('Error sending test message:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while sending test message'
    });
  }
});

// Get Telegram chat IDs
router.get('/telegram/chat-ids', (req, res) => {
  try {
    const config = telegramService.getConfig();
    
    res.json({
      success: true,
      chatIds: config.chatIds || []
    });
  } catch (error) {
    console.error('Error getting chat IDs:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while getting chat IDs'
    });
  }
});

// Add a new chat ID
router.post('/telegram/chat-ids', (req, res) => {
  try {
    const { chatId } = req.body;
    
    if (!chatId) {
      return res.status(400).json({ success: false, error: 'Chat ID is required' });
    }
    
    // Validate chat ID format - should be a number or start with '-' for groups
    const chatIdStr = chatId.toString();
    if (!/^-?\d+$/.test(chatIdStr)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid chat ID format. Must be a valid Telegram chat ID (numeric)' 
      });
    }
    
    const success = telegramService.addChatId(chatId);
    
    res.json({
      success,
      message: success ? 'Chat ID added successfully' : 'Failed to add chat ID'
    });
  } catch (error) {
    console.error('Error adding chat ID:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while adding chat ID'
    });
  }
});

// Remove a chat ID
router.delete('/telegram/chat-ids/:chatId', (req, res) => {
  try {
    const { chatId } = req.params;
    
    const success = telegramService.removeChatId(chatId);
    
    res.json({
      success,
      message: success ? 'Chat ID removed successfully' : 'Failed to remove chat ID'
    });
  } catch (error) {
    console.error('Error removing chat ID:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while removing chat ID'
    });
  }
});

// Notification Rules Routes

// Get all notification rules
router.get('/rules', (req, res) => {
  try {
    const config = telegramService.getConfig();
    
    res.json({
      success: true,
      rules: config.notificationRules || [],
      note: 'Notification rules must be manually configured by the user'
    });
  } catch (error) {
    console.error('Error fetching notification rules:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching notification rules'
    });
  }
});

// Add a new notification rule
router.post('/rules', (req, res) => {
  try {
    const { type, ruleId, warningType, name, description, enabled } = req.body;
    
    if (!type || (type === 'rule' && !ruleId) || (type === 'warning' && !warningType)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    const rule = {
      id: `notification-${Date.now()}`,
      type,
      name: name || (type === 'rule' ? 'Rule Notification' : 'Warning Notification'),
      description: description || '',
      enabled: enabled !== undefined ? enabled : true,
      ruleId: type === 'rule' ? ruleId : undefined,
      warningType: type === 'warning' ? warningType : undefined,
      createdAt: new Date().toISOString()
    };
    
    const success = telegramService.addNotificationRule(rule);
    
    res.json({
      success,
      message: success ? 'Notification rule added successfully. Only user-configured notifications will be sent.' : 'Failed to add notification rule',
      rule: success ? rule : undefined
    });
  } catch (error) {
    console.error('Error adding notification rule:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while adding notification rule'
    });
  }
});

// Update a notification rule
router.put('/rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { type, ruleId, warningType, name, description, enabled } = req.body;
    
    if (!type || (type === 'rule' && !ruleId) || (type === 'warning' && !warningType)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }
    
    // First check if rule exists
    const config = telegramService.getConfig();
    const ruleExists = config.notificationRules.some(r => r.id === id);
    
    if (!ruleExists) {
      return res.status(404).json({
        success: false,
        error: 'Notification rule not found'
      });
    }
    
    const rule = {
      id,
      type,
      name: name || (type === 'rule' ? 'Rule Notification' : 'Warning Notification'),
      description: description || '',
      enabled: enabled !== undefined ? enabled : true,
      ruleId: type === 'rule' ? ruleId : undefined,
      warningType: type === 'warning' ? warningType : undefined,
      updatedAt: new Date().toISOString()
    };
    
    const success = telegramService.updateNotificationRule(id, rule);
    
    res.json({
      success,
      message: success ? 'Notification rule updated successfully' : 'Failed to update notification rule',
      rule: success ? rule : undefined
    });
  } catch (error) {
    console.error('Error updating notification rule:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while updating notification rule'
    });
  }
});

// Batch update notification rules
router.post('/rules/batch', (req, res) => {
  try {
    const { rules } = req.body;
    
    if (!Array.isArray(rules)) {
      return res.status(400).json({
        success: false,
        error: 'Rules must be an array'
      });
    }
    
    let successCount = 0;
    const results = [];
    
    // Process each rule update
    for (const rule of rules) {
      // Validate rule structure
      if (!rule.id || !rule.type) {
        results.push({
          id: rule.id || 'unknown',
          success: false,
          message: 'Missing required fields'
        });
        continue;
      }
      
      // Set timestamps
      rule.updatedAt = new Date().toISOString();
      
      // Update the rule
      const success = telegramService.updateNotificationRule(rule.id, rule);
      
      if (success) {
        successCount++;
      }
      
      results.push({
        id: rule.id,
        success,
        message: success ? 'Updated' : 'Failed to update'
      });
    }
    
    res.json({
      success: successCount > 0,
      message: `Updated ${successCount}/${rules.length} notification rules`,
      results
    });
  } catch (error) {
    console.error('Error batch updating notification rules:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while batch updating notification rules'
    });
  }
});

// Delete a notification rule
router.delete('/rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const success = telegramService.deleteNotificationRule(id);
    
    res.json({
      success,
      message: success ? 'Notification rule deleted successfully' : 'Failed to delete notification rule'
    });
  } catch (error) {
    console.error('Error deleting notification rule:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while deleting notification rule'
    });
  }
});

// Warning Types Routes

// Get all warning types
router.get('/warnings/types', (req, res) => {
  try {
    const warningTypes = warningService.getWarningTypes();
    
    res.json({
      success: true,
      warningTypes,
      note: 'Warning types are disabled by default. Users must manually enable them.'
    });
  } catch (error) {
    console.error('Error fetching warning types:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching warning types'
    });
  }
});

// Get a specific warning type
router.get('/warnings/types/:id', (req, res) => {
  try {
    const { id } = req.params;
    const warningType = warningService.getWarningTypeById(id);
    
    if (!warningType) {
      return res.status(404).json({ success: false, error: 'Warning type not found' });
    }
    
    res.json({
      success: true,
      warningType
    });
  } catch (error) {
    console.error('Error fetching warning type:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching warning type'
    });
  }
});

// Add a new warning type
router.post('/warnings/types', (req, res) => {
  try {
    const { name, description, parameter, condition, threshold, enabled, priority, cooldownMinutes, timeCondition } = req.body;
    
    if (!name || !parameter || !condition || threshold === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const warningType = {
      id: `warning-${Date.now()}`,
      name,
      description: description || '',
      parameter,
      condition,
      threshold,
      enabled: enabled !== undefined ? enabled : false, // DISABLED BY DEFAULT
      priority: priority || 'medium',
      cooldownMinutes: cooldownMinutes || 30,
      timeCondition
    };
    
    const result = warningService.addWarningType(warningType);
    
    res.json({
      success: !!result,
      message: result ? 'Warning type added successfully (disabled by default)' : 'Failed to add warning type',
      warningType: result
    });
  } catch (error) {
    console.error('Error adding warning type:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while adding warning type'
    });
  }
});

// Update a warning type
router.put('/warnings/types/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, parameter, condition, threshold, enabled, priority, cooldownMinutes, timeCondition } = req.body;
    
    if (!name || !parameter || !condition || threshold === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    // Check if warning type exists
    const existingType = warningService.getWarningTypeById(id);
    if (!existingType) {
      return res.status(404).json({
        success: false,
        error: 'Warning type not found'
      });
    }
    
    const warningType = {
      name,
      description: description || '',
      parameter,
      condition,
      threshold,
      enabled: enabled !== undefined ? enabled : false, // Respect user's choice
      priority: priority || 'medium',
      cooldownMinutes: cooldownMinutes || 30,
      timeCondition
    };
    
    const success = warningService.updateWarningType(id, warningType);
    
    res.json({
      success,
      message: success ? 'Warning type updated successfully' : 'Failed to update warning type'
    });
  } catch (error) {
    console.error('Error updating warning type:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while updating warning type'
    });
  }
});

// Delete a warning type
router.delete('/warnings/types/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const success = warningService.deleteWarningType(id);
    
    res.json({
      success,
      message: success ? 'Warning type deleted successfully' : 'Failed to delete warning type'
    });
  } catch (error) {
    console.error('Error deleting warning type:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while deleting warning type'
    });
  }
});

// Warning History Routes

// Get warning history
router.get('/warnings/history', (req, res) => {
  try {
    const { warningTypeId, priority, startDate, endDate, limit, skip } = req.query;
    
    const options = {
      warningTypeId,
      priority,
      startDate,
      endDate,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined
    };
    
    const history = warningService.getWarningHistory(options);
    
    res.json({
      success: true,
      ...history
    });
  } catch (error) {
    console.error('Error fetching warning history:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching warning history'
    });
  }
});

// Clear warning history
router.delete('/warnings/history', (req, res) => {
  try {
    const success = warningService.clearWarningHistory();
    
    res.json({
      success,
      message: success ? 'Warning history cleared successfully' : 'Failed to clear warning history'
    });
  } catch (error) {
    console.error('Error clearing warning history:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while clearing warning history'
    });
  }
});

// Trigger a warning test notification
router.post('/warnings/test', async (req, res) => {
  try {
    const { warningType } = req.body;
    
    if (!warningType) {
      return res.status(400).json({
        success: false,
        error: 'Warning type is required'
      });
    }
    
    // Get the warning type
    const warningTypeObj = warningService.getWarningTypeById(warningType);
    if (!warningTypeObj) {
      return res.status(404).json({
        success: false,
        error: 'Warning type not found'
      });
    }
    
    // Get current system state from global variable
    const currentSystemState = global.currentSystemState || {};
    
    // Create a test warning instance
    const warningInstance = {
      id: `test-${Date.now()}`,
      warningTypeId: warningType,
      timestamp: new Date().toISOString(),
      systemState: { ...currentSystemState },
      title: `TEST: ${warningTypeObj.name}`,
      description: warningTypeObj.description,
      priority: warningTypeObj.priority,
      triggered: {
        parameter: warningTypeObj.parameter,
        value: currentSystemState[warningTypeObj.parameter] || 0,
        threshold: warningTypeObj.threshold,
        condition: warningTypeObj.condition
      }
    };
    
    // Send notification
    const message = telegramService.formatWarningMessage(warningInstance, currentSystemState);
    const success = await telegramService.broadcastMessage(message);
    
    res.json({
      success,
      message: success ? 'Test warning notification sent' : 'Failed to send test warning notification'
    });
  } catch (error) {
    console.error('Error sending test warning notification:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while sending test warning notification'
    });
  }
});

// AI Charging Notification Routes

// Get AI charging notification configuration
router.get('/ai-charging/config', (req, res) => {
  try {
    const config = telegramService.getConfig();
    
    res.json({
      success: true,
      settings: config.aiChargingNotifications || {
        chargingStarted: false,
        chargingStopped: false,
        optimalPrice: false,
        negativePrice: false
      }
    });
  } catch (error) {
    console.error('Error getting AI charging config:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while getting AI charging configuration'
    });
  }
});

// Update AI charging notification configuration
router.post('/ai-charging/config', (req, res) => {
  try {
    const { settings } = req.body;
    
    if (!settings) {
      return res.status(400).json({ success: false, error: 'Settings are required' });
    }
    
    const success = telegramService.updateAIChargingNotifications(settings);
    
    res.json({
      success,
      message: success ? 'AI charging notification settings updated successfully' : 'Failed to update AI charging settings'
    });
  } catch (error) {
    console.error('Error updating AI charging config:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while updating AI charging configuration'
    });
  }
});

// Trigger a rule test notification
router.post('/rules/test', async (req, res) => {
  try {
    const { ruleId } = req.body;
    
    if (!ruleId) {
      return res.status(400).json({
        success: false,
        error: 'Rule ID is required'
      });
    }
    
    // Get the rule - need to use the global function
    const getRuleById = global.getRuleById;
    const USER_ID = global.USER_ID;
    
    if (!getRuleById || !USER_ID) {
      return res.status(500).json({
        success: false,
        error: 'Rule retrieval function not available'
      });
    }
    
    const rule = await getRuleById(ruleId, USER_ID);
    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Rule not found'
      });
    }
    
    // Get current system state from global variable
    const currentSystemState = global.currentSystemState || {};
    
    // Format test message
    const message = telegramService.formatRuleTriggerMessage({
      ...rule,
      name: `TEST: ${rule.name}`
    }, currentSystemState);
    
    // Send notification
    const success = await telegramService.broadcastMessage(message);
    
    res.json({
      success,
      message: success ? 'Test rule notification sent' : 'Failed to send test rule notification'
    });
  } catch (error) {
    console.error('Error sending test rule notification:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while sending test rule notification'
    });
  }
});

module.exports = router;
