// notification-rules.js - Complete module for managing notification rules for Telegram
const fs = require('fs');
const path = require('path');

// File to store notification rules
const NOTIFICATION_RULES_FILE = path.join(__dirname, 'data', 'notification_rules.json');

/**
 * Initialize notification rules file if it doesn't exist
 */
function initNotificationRules() {
  if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  }
  
  if (!fs.existsSync(NOTIFICATION_RULES_FILE)) {
    // Create default notification rules
    const defaultRules = [
      {
        id: 'battery-low',
        name: 'Battery Low Warning',
        description: 'Send notification when battery is below threshold',
        enabled: true,
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lt',
            value: 20
          }
        ],
        messageTemplate: 'Battery level is critically low at {battery_soc}%',
        cooldownMinutes: 60, // Don't repeat notification for 60 minutes
        lastTriggered: null,
        silent: false,
        priority: 'high'
      },
      {
        id: 'grid-outage',
        name: 'Grid Outage Alert',
        description: 'Send notification when grid voltage is below threshold',
        enabled: true,
        conditions: [
          {
            parameter: 'grid_voltage',
            operator: 'lt',
            value: 180
          }
        ],
        messageTemplate: 'Grid voltage is critically low at {grid_voltage}V, possible outage detected',
        cooldownMinutes: 30,
        lastTriggered: null,
        silent: false,
        priority: 'high'
      },
      {
        id: 'high-load',
        name: 'High Load Warning',
        description: 'Send notification when load is above threshold',
        enabled: false,
        conditions: [
          {
            parameter: 'load',
            operator: 'gt',
            value: 5000
          }
        ],
        messageTemplate: 'High load detected at {load}W',
        cooldownMinutes: 120,
        lastTriggered: null,
        silent: true,
        priority: 'medium'
      }
    ];
    
    fs.writeFileSync(NOTIFICATION_RULES_FILE, JSON.stringify(defaultRules, null, 2));
    console.log('Notification rules file created with default rules');
  }
}

/**
 * Get all notification rules
 * @returns {Array} List of notification rules
 */
function getNotificationRules() {
  try {
    initNotificationRules();
    return JSON.parse(fs.readFileSync(NOTIFICATION_RULES_FILE, 'utf8'));
  } catch (error) {
    console.error('Error reading notification rules:', error.message);
    return [];
  }
}

/**
 * Get a notification rule by ID
 * @param {string} ruleId - Rule ID to find
 * @returns {Object|null} The notification rule or null if not found
 */
function getNotificationRuleById(ruleId) {
  try {
    const rules = getNotificationRules();
    return rules.find(rule => rule.id === ruleId) || null;
  } catch (error) {
    console.error('Error getting notification rule by ID:', error.message);
    return null;
  }
}

/**
 * Add or update a notification rule
 * @param {Object} ruleData - Rule data to save
 * @returns {Boolean} Success status
 */
function saveNotificationRule(ruleData) {
  try {
    const rules = getNotificationRules();
    
    // Check if rule already exists (update) or is new (add)
    const existingRuleIndex = rules.findIndex(rule => rule.id === ruleData.id);
    
    if (existingRuleIndex >= 0) {
      // Update existing rule
      rules[existingRuleIndex] = { ...rules[existingRuleIndex], ...ruleData };
    } else {
      // Add new rule with generated ID if not provided
      if (!ruleData.id) {
        ruleData.id = `rule-${Date.now()}`;
      }
      rules.push(ruleData);
    }
    
    // Save rules to file
    fs.writeFileSync(NOTIFICATION_RULES_FILE, JSON.stringify(rules, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving notification rule:', error.message);
    return false;
  }
}

/**
 * Delete a notification rule
 * @param {string} ruleId - ID of rule to delete
 * @returns {Boolean} Success status
 */
function deleteNotificationRule(ruleId) {
  try {
    let rules = getNotificationRules();
    const initialCount = rules.length;
    
    // Filter out the rule to delete
    rules = rules.filter(rule => rule.id !== ruleId);
    
    // Check if a rule was actually removed
    if (rules.length === initialCount) {
      return false; // No rule was deleted
    }
    
    // Save updated rules to file
    fs.writeFileSync(NOTIFICATION_RULES_FILE, JSON.stringify(rules, null, 2));
    return true;
  } catch (error) {
    console.error('Error deleting notification rule:', error.message);
    return false;
  }
}

/**
 * Update the lastTriggered timestamp for a rule
 * @param {string} ruleId - ID of the rule
 * @returns {Boolean} Success status
 */
function updateRuleLastTriggered(ruleId) {
  try {
    const rules = getNotificationRules();
    const ruleIndex = rules.findIndex(rule => rule.id === ruleId);
    
    if (ruleIndex === -1) {
      return false;
    }
    
    rules[ruleIndex].lastTriggered = new Date().toISOString();
    fs.writeFileSync(NOTIFICATION_RULES_FILE, JSON.stringify(rules, null, 2));
    return true;
  } catch (error) {
    console.error('Error updating rule last triggered time:', error.message);
    return false;
  }
}

/**
 * Evaluate a notification rule against system state
 * @param {Object} rule - Notification rule to evaluate
 * @param {Object} systemState - Current system state
 * @returns {Boolean} True if rule conditions are met
 */
function evaluateRule(rule, systemState) {
  // Rule must be enabled
  if (!rule.enabled) {
    return false;
  }
  
  // Check cooldown period
  if (rule.lastTriggered && rule.cooldownMinutes) {
    const lastTriggeredTime = new Date(rule.lastTriggered).getTime();
    const cooldownMs = rule.cooldownMinutes * 60 * 1000;
    const currentTime = new Date().getTime();
    
    if (currentTime - lastTriggeredTime < cooldownMs) {
      return false; // Still in cooldown period
    }
  }
  
  // If no conditions, rule doesn't trigger
  if (!rule.conditions || rule.conditions.length === 0) {
    return false;
  }
  
  // Check all conditions (logical AND)
  return rule.conditions.every(condition => {
    const { parameter, operator, value } = condition;
    const currentValue = systemState[parameter];
    
    // Skip if system state doesn't have this parameter
    if (currentValue === undefined || currentValue === null) {
      return false;
    }
    
    // Evaluate the condition
    switch (operator) {
      case 'gt': // greater than
        return currentValue > value;
      case 'lt': // less than
        return currentValue < value;
      case 'eq': // equal to
        return currentValue === value;
      case 'gte': // greater than or equal to
        return currentValue >= value;
      case 'lte': // less than or equal to
        return currentValue <= value;
      case 'ne': // not equal to
        return currentValue !== value;
      default:
        return false;
    }
  });
}

/**
 * Format a message template with system state values
 * @param {string} template - Message template with placeholders
 * @param {Object} systemState - Current system state
 * @returns {string} Formatted message
 */
function formatMessage(template, systemState) {
  let message = template;
  
  // Replace placeholders like {battery_soc} with actual values
  for (const [key, value] of Object.entries(systemState)) {
    if (value !== null && value !== undefined) {
      const placeholder = `{${key}}`;
      message = message.replace(new RegExp(placeholder, 'g'), value);
    }
  }
  
  return message;
}

/**
 * Check all notification rules and return triggered ones
 * @param {Object} systemState - Current system state
 * @returns {Array} List of triggered rules
 */
function checkNotificationRules(systemState) {
  try {
    const rules = getNotificationRules();
    const triggeredRules = [];
    
    for (const rule of rules) {
      if (evaluateRule(rule, systemState)) {
        // Format the message with actual values
        const message = formatMessage(rule.messageTemplate, systemState);
        
        // Add to triggered rules
        triggeredRules.push({
          ...rule,
          formattedMessage: message
        });
        
        // Update last triggered time
        updateRuleLastTriggered(rule.id);
      }
    }
    
    return triggeredRules;
  } catch (error) {
    console.error('Error checking notification rules:', error.message);
    return [];
  }
}

module.exports = {
  initNotificationRules,
  getNotificationRules,
  getNotificationRuleById,
  saveNotificationRule,
  deleteNotificationRule,
  checkNotificationRules,
  evaluateRule,
  formatMessage,
  updateRuleLastTriggered
};