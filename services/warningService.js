// services/warningService.js

const fs = require('fs');
const path = require('path');

// Configuration file path
const WARNINGS_CONFIG_FILE = path.join(__dirname, '..', 'data', 'warnings_config.json');

// No default warning types - users create their own
const availableWarningTypes = [];

// Default configuration structure - empty, user creates their own
const defaultConfig = {
  enabled: true,
  warningTypes: [], // Empty - users create their own
  warningHistory: [],
  maxHistoryItems: 100
};

// Ensure configuration file exists
function ensureConfigFile() {
  const configDir = path.dirname(WARNINGS_CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(WARNINGS_CONFIG_FILE)) {
    fs.writeFileSync(WARNINGS_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
  }
}

// Read configuration
function getConfig() {
  ensureConfigFile();
  try {
    const config = JSON.parse(fs.readFileSync(WARNINGS_CONFIG_FILE, 'utf8'));
    
    // No default warning types to add
    
    return config;
  } catch (error) {
    console.error('Error reading Warnings config:', error);
    return { ...defaultConfig };
  }
}

// Save configuration
function saveConfig(config) {
  ensureConfigFile();
  try {
    fs.writeFileSync(WARNINGS_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving Warnings config:', error);
    return false;
  }
}

// Get all warning types
function getWarningTypes() {
  const config = getConfig();
  return config.warningTypes;
}

// Get a specific warning type by ID
function getWarningTypeById(id) {
  const config = getConfig();
  return config.warningTypes.find(warning => warning.id === id);
}

// Add a new warning type
function addWarningType(warningType) {
  const config = getConfig();
  
  // Generate an ID if not provided
  if (!warningType.id) {
    warningType.id = `warning-${Date.now()}`;
  }
  
  // New warning types are disabled by default
  warningType.enabled = warningType.enabled || false;
  
  config.warningTypes.push(warningType);
  return saveConfig(config) ? warningType : null;
}

// Update an existing warning type
function updateWarningType(id, updatedWarning) {
  const config = getConfig();
  const index = config.warningTypes.findIndex(warning => warning.id === id);
  
  if (index !== -1) {
    config.warningTypes[index] = { ...updatedWarning, id };
    return saveConfig(config);
  }
  
  return false;
}

// Delete a warning type
function deleteWarningType(id) {
  const config = getConfig();
  config.warningTypes = config.warningTypes.filter(warning => warning.id !== id);
  return saveConfig(config);
}

// Check if it's daytime (used for time-conditional warnings)
function isDaytime() {
  const hour = new Date().getHours();
  return hour >= 8 && hour <= 18; // 8 AM to 6 PM
}

// Check if a warning is on cooldown
function isWarningOnCooldown(warningTypeId) {
  const config = getConfig();
  const warningType = getWarningTypeById(warningTypeId);
  
  if (!warningType) return true; // If warning type doesn't exist, treat as on cooldown
  
  // Find the most recent occurrence of this warning
  const recentWarning = config.warningHistory
    .filter(w => w.warningTypeId === warningTypeId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  
  if (!recentWarning) return false; // No recent warning, not on cooldown
  
  // Calculate time elapsed since the warning
  const warningTime = new Date(recentWarning.timestamp);
  const currentTime = new Date();
  const elapsedMinutes = (currentTime - warningTime) / (1000 * 60);
  
  // Check if still in cooldown period
  return elapsedMinutes < warningType.cooldownMinutes;
}

// Evaluate a condition
function evaluateCondition(condition, currentValue, thresholdValue) {
  switch (condition) {
    case 'lt': // less than
      return currentValue < thresholdValue;
    case 'gt': // greater than
      return currentValue > thresholdValue;
    case 'eq': // equal to
      return currentValue === thresholdValue;
    case 'lte': // less than or equal to
      return currentValue <= thresholdValue;
    case 'gte': // greater than or equal to
      return currentValue >= thresholdValue;
    default:
      return false;
  }
}

// Check system state against all warning types - ONLY ENABLED WARNINGS
function checkWarnings(systemState) {
  const config = getConfig();
  const triggeredWarnings = [];
  
  if (!config.enabled) return triggeredWarnings;
  
  // Only check warnings that are explicitly enabled by the user
  const enabledWarnings = config.warningTypes.filter(w => w.enabled === true);
  
  if (enabledWarnings.length === 0) {
    console.log('No warning types enabled by user');
    return triggeredWarnings;
  }
  
  enabledWarnings.forEach(warningType => {
    // Skip if on cooldown
    if (isWarningOnCooldown(warningType.id)) return;
    
    // Skip time-conditional warnings if not in the right time period
    if (warningType.timeCondition === 'daytime' && !isDaytime()) return;
    
    // Get current value for the parameter
    const currentValue = systemState[warningType.parameter];
    
    // Skip if parameter not available
    if (currentValue === null || currentValue === undefined) return;
    
    // Evaluate the condition
    if (evaluateCondition(warningType.condition, currentValue, warningType.threshold)) {
      // Warning condition met
      const warningInstance = {
        id: `instance-${Date.now()}`,
        warningTypeId: warningType.id,
        timestamp: new Date().toISOString(),
        systemState: { ...systemState },
        title: warningType.name,
        description: warningType.description,
        priority: warningType.priority,
        triggered: {
          parameter: warningType.parameter,
          value: currentValue,
          threshold: warningType.threshold,
          condition: warningType.condition
        }
      };
      
      // Add to triggered warnings
      triggeredWarnings.push(warningInstance);
      
      // Add to history
      addWarningToHistory(warningInstance);
    }
  });
  
  return triggeredWarnings;
}

// Add a warning to history
function addWarningToHistory(warningInstance) {
  const config = getConfig();
  
  // Add the new warning
  config.warningHistory.unshift(warningInstance);
  
  // Trim history if needed
  if (config.warningHistory.length > config.maxHistoryItems) {
    config.warningHistory = config.warningHistory.slice(0, config.maxHistoryItems);
  }
  
  saveConfig(config);
}

// Get warning history
function getWarningHistory(options = {}) {
  const config = getConfig();
  let history = [...config.warningHistory];
  
  // Apply filters if provided
  if (options.warningTypeId) {
    history = history.filter(warning => warning.warningTypeId === options.warningTypeId);
  }
  
  if (options.priority) {
    history = history.filter(warning => warning.priority === options.priority);
  }
  
  if (options.startDate) {
    const startDate = new Date(options.startDate);
    history = history.filter(warning => new Date(warning.timestamp) >= startDate);
  }
  
  if (options.endDate) {
    const endDate = new Date(options.endDate);
    history = history.filter(warning => new Date(warning.timestamp) <= endDate);
  }
  
  // Apply pagination
  const total = history.length;
  
  if (options.limit) {
    const skip = options.skip || 0;
    history = history.slice(skip, skip + options.limit);
  }
  
  return {
    warnings: history,
    total,
    filtered: options.warningTypeId || options.priority || options.startDate || options.endDate
  };
}

// Clear warning history
function clearWarningHistory() {
  const config = getConfig();
  config.warningHistory = [];
  return saveConfig(config);
}

// Enable/disable warning system globally
function setWarningSystemEnabled(enabled) {
  const config = getConfig();
  config.enabled = enabled;
  return saveConfig(config);
}

// Get count of enabled warnings
function getEnabledWarningsCount() {
  const config = getConfig();
  return config.warningTypes.filter(w => w.enabled === true).length;
}

module.exports = {
  getConfig,
  saveConfig,
  getWarningTypes,
  getWarningTypeById,
  addWarningType,
  updateWarningType,
  deleteWarningType,
  checkWarnings,
  getWarningHistory,
  clearWarningHistory,
  setWarningSystemEnabled,
  getEnabledWarningsCount
};
