// routes/notificationRoutes.js

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
      message: success ? 'Telegram configuration updated' : 'Failed to update configuration',
      botInfo: testResult.botInfo
    });
  } else {
    // Update only enabled status
    const success = telegramService.updateConfig({ 
      enabled: enabled !== undefined ? enabled : telegramService.getConfig().enabled 
    });
    
    res.json({ 
      success,
      message: success ? 'Telegram configuration updated' : 'Failed to update configuration'
    });
  }
});

// Test Telegram notification
router.post('/telegram/test', async (req, res) => {
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
});

// Get Telegram chat IDs
router.get('/telegram/chat-ids', (req, res) => {
  const config = telegramService.getConfig();
  
  res.json({
    success: true,
    chatIds: config.chatIds
  });
});

// Add a new chat ID
router.post('/telegram/chat-ids', (req, res) => {
  const { chatId } = req.body;
  
  if (!chatId) {
    return res.status(400).json({ success: false, error: 'Chat ID is required' });
  }
  
  const success = telegramService.addChatId(chatId);
  
  res.json({
    success,
    message: success ? 'Chat ID added successfully' : 'Failed to add chat ID'
  });
});

// Remove a chat ID
router.delete('/telegram/chat-ids/:chatId', (req, res) => {
  const { chatId } = req.params;
  
  const success = telegramService.removeChatId(chatId);
  
  res.json({
    success,
    message: success ? 'Chat ID removed successfully' : 'Failed to remove chat ID'
  });
});

// Notification Rules Routes

// Get all notification rules
router.get('/rules', (req, res) => {
  const config = telegramService.getConfig();
  
  res.json({
    success: true,
    rules: config.notificationRules
  });
});

// Add a new notification rule
router.post('/rules', (req, res) => {
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
    message: success ? 'Notification rule added successfully' : 'Failed to add notification rule',
    rule: success ? rule : undefined
  });
});

// Update a notification rule
router.put('/rules/:id', (req, res) => {
  const { id } = req.params;
  const { type, ruleId, warningType, name, description, enabled } = req.body;
  
  if (!type || (type === 'rule' && !ruleId) || (type === 'warning' && !warningType)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields' 
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
});

// Delete a notification rule
router.delete('/rules/:id', (req, res) => {
  const { id } = req.params;
  
  const success = telegramService.deleteNotificationRule(id);
  
  res.json({
    success,
    message: success ? 'Notification rule deleted successfully' : 'Failed to delete notification rule'
  });
});

// Warning Types Routes

// Get all warning types
router.get('/warnings/types', (req, res) => {
  const warningTypes = warningService.getWarningTypes();
  
  res.json({
    success: true,
    warningTypes
  });
});

// Get a specific warning type
router.get('/warnings/types/:id', (req, res) => {
  const { id } = req.params;
  const warningType = warningService.getWarningTypeById(id);
  
  if (!warningType) {
    return res.status(404).json({ success: false, error: 'Warning type not found' });
  }
  
  res.json({
    success: true,
    warningType
  });
});

// Add a new warning type
router.post('/warnings/types', (req, res) => {
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
    enabled: enabled !== undefined ? enabled : true,
    priority: priority || 'medium',
    cooldownMinutes: cooldownMinutes || 30,
    timeCondition
  };
  
  const result = warningService.addWarningType(warningType);
  
  res.json({
    success: !!result,
    message: result ? 'Warning type added successfully' : 'Failed to add warning type',
    warningType: result
  });
});

// Update a warning type
router.put('/warnings/types/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, parameter, condition, threshold, enabled, priority, cooldownMinutes, timeCondition } = req.body;
  
  if (!name || !parameter || !condition || threshold === undefined) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  const warningType = {
    name,
    description: description || '',
    parameter,
    condition,
    threshold,
    enabled: enabled !== undefined ? enabled : true,
    priority: priority || 'medium',
    cooldownMinutes: cooldownMinutes || 30,
    timeCondition
  };
  
  const success = warningService.updateWarningType(id, warningType);
  
  res.json({
    success,
    message: success ? 'Warning type updated successfully' : 'Failed to update warning type'
  });
});

// Delete a warning type
router.delete('/warnings/types/:id', (req, res) => {
  const { id } = req.params;
  
  const success = warningService.deleteWarningType(id);
  
  res.json({
    success,
    message: success ? 'Warning type deleted successfully' : 'Failed to delete warning type'
  });
});

// Warning History Routes

// Get warning history
router.get('/warnings/history', (req, res) => {
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
});

// Clear warning history
router.delete('/warnings/history', (req, res) => {
  const success = warningService.clearWarningHistory();
  
  res.json({
    success,
    message: success ? 'Warning history cleared successfully' : 'Failed to clear warning history'
  });
});

module.exports = router;