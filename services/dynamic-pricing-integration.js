// services/dynamic-pricing-integration.js

/**
 * Integration module for dynamic electricity pricing feature
 * This module connects the dynamic pricing UI with the backend services
 * and provides the necessary APIs for the Solar Autopilot application
 * FIXED: Timezone handling issues resolved
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'dynamic_pricing_config.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'dynamic_pricing.log');

// Global instance of the controller
let controllerInstance = null;

/**
 * Initialize dynamic pricing integration in the main server.js file
 * @param {Object} app - Express application instance
 * @param {Object} mqttClient - MQTT client instance
 * @param {Object} currentSystemState - Current system state object
 * @returns {Object} Controller instance for dynamic pricing
 */
async function initializeDynamicPricing(app, mqttClient, currentSystemState) {
  try {
    console.log('Initializing dynamic electricity pricing integration...');
    
    // Create required directories
    const logDir = path.dirname(LOG_FILE);
    const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Initialize the controller
    controllerInstance = await createDynamicPricingController(mqttClient, currentSystemState);
    
    // Set up periodic tasks
    setupPeriodicTasks(mqttClient, currentSystemState);
    
    console.log('✅ Dynamic pricing integration complete');
    
    // Return the controller instance for use in server.js
    return controllerInstance;
  } catch (error) {
    console.error('❌ Error initializing dynamic pricing integration:', error);
    return {
      enabled: false,
      isReady: () => false,
      shouldChargeNow: () => false,
      sendGridChargeCommand: () => false
    };
  }
}

/**
 * Create the dynamic pricing controller
 */
async function createDynamicPricingController(mqttClient, currentSystemState) {
  // Ensure config file exists
  ensureConfigExists();
  
  // Create controller instance
  const controller = {
    enabled: false,
    config: null,
    mqttClient: mqttClient,
    currentSystemState: currentSystemState,
    
    // Initialize the controller
    async init() {
      try {
        // Load the configuration
        this.config = loadConfig();
        
        // Check if the feature is enabled
        this.enabled = this.config && this.config.enabled;
        
        // Log initialization status
        if (this.enabled) {
          console.log('Dynamic pricing feature is ENABLED');
        } else {
          console.log('Dynamic pricing feature is DISABLED');
        }
        
        return this;
      } catch (error) {
        console.error('Error initializing dynamic pricing controller:', error.message);
        return this;
      }
    },
    
    // Check if the feature is ready to use
    isReady() {
      try {
        if (!this.config) {
          return false;
        }
        
        // Check if all required settings are present
        const hasCountry = !!this.config.country;
        const hasTimezone = !!this.config.timezone;
        const hasPricingData = this.config.pricingData && this.config.pricingData.length > 0;
        
        return hasCountry && hasTimezone && hasPricingData;
      } catch (error) {
        console.error('Error checking if dynamic pricing is ready:', error.message);
        return false;
      }
    },
    
    // Get current pricing data
    getPricingData() {
      try {
        if (!this.config) {
          return [];
        }
        
        return this.config.pricingData || [];
      } catch (error) {
        console.error('Error getting pricing data:', error.message);
        return [];
      }
    },
    
    // Send a grid charge command
    sendGridChargeCommand(enable) {
      try {
        // Only send if the feature is enabled
        if (!this.enabled) {
          console.log('Dynamic pricing is disabled, not sending grid charge command');
          return false;
        }
        
        const dynamicPricingMqtt = require('./dynamicPricingMqtt');
        
        // Check if learner mode is active
        if (!dynamicPricingMqtt.isLearnerModeActive()) {
          // Log what would have happened but don't send command
          return dynamicPricingMqtt.simulateGridChargeCommand(enable, this.config);
        }
        
        // Send the actual command since learner mode is active
        return dynamicPricingMqtt.sendGridChargeCommand(this.mqttClient, enable, this.config);
      } catch (error) {
        console.error('Error sending grid charge command:', error.message);
        return false;
      }
    },
    
    // Check if now is a good time to charge
    isGoodTimeToCharge() {
      try {
        if (!this.enabled || !this.config || !this.config.pricingData) {
          return false;
        }
        
        // Get current time in the configured timezone
        const timezone = this.config.timezone || 'Europe/Berlin';
        const now = new Date();
        
        // Find the current price using timezone-aware comparison
        const currentPrice = this.config.pricingData.find(p => {
          const priceTime = new Date(p.timestamp);
          
          // Compare hours using the same timezone
          const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: timezone}));
          const priceInTimezone = new Date(priceTime.toLocaleString("en-US", {timeZone: timezone}));
          
          return nowInTimezone.getHours() === priceInTimezone.getHours() && 
                 nowInTimezone.getDate() === priceInTimezone.getDate() &&
                 nowInTimezone.getMonth() === priceInTimezone.getMonth();
        });
        
        if (!currentPrice) {
          return false;
        }
        
        // Calculate threshold
        const threshold = this.config.priceThreshold > 0 
          ? this.config.priceThreshold 
          : this.calculateAveragePrice() * 0.75; // 25% below average
        
        // Check if current price is below threshold
        return currentPrice.price <= threshold;
      } catch (error) {
        console.error('Error checking if now is a good time to charge:', error.message);
        return false;
      }
    },
    
    // Check if we should charge based on all conditions
    shouldChargeNow() {
      try {
        if (!this.enabled || !this.config) {
          return false;
        }
        
        // Check if battery SoC is within range
        const batterySoC = this.currentSystemState?.battery_soc || 0;
        if (batterySoC >= this.config.targetSoC) {
          // Battery already at target level
          return false;
        }
        
        if (batterySoC < this.config.minimumSoC) {
          // Battery below minimum level - let other systems handle this
          return false;
        }
        
        // Check if we're in a scheduled charging time
        if (this.isInScheduledChargingTime()) {
          return true;
        }
        
        // Check if current price is good for charging
        return this.isGoodTimeToCharge();
      } catch (error) {
        console.error('Error checking if we should charge now:', error.message);
        return false;
      }
    },
    
    // Check if we're in a scheduled charging time
    isInScheduledChargingTime() {
      try {
        if (!this.config || !this.config.scheduledCharging || !this.config.chargingHours) {
          return false;
        }
        
        // Get current time in the configured timezone
        const timezone = this.config.timezone || 'Europe/Berlin';
        const now = new Date();
        const currentTimeStr = now.toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit',
          timeZone: timezone
        });
        
        // Check if current time is within any of the scheduled charging periods
        return this.config.chargingHours.some(period => {
          if (period.start > period.end) {
            // Overnight period
            return currentTimeStr >= period.start || currentTimeStr < period.end;
          } else {
            // Same-day period
            return currentTimeStr >= period.start && currentTimeStr < period.end;
          }
        });
      } catch (error) {
        console.error('Error checking scheduled charging time:', error.message);
        return false;
      }
    },
    
    // Calculate average price from available data
    calculateAveragePrice() {
      try {
        if (!this.config || !this.config.pricingData || this.config.pricingData.length === 0) {
          return 0;
        }
        
        const sum = this.config.pricingData.reduce((total, item) => total + item.price, 0);
        return sum / this.config.pricingData.length;
      } catch (error) {
        console.error('Error calculating average price:', error.message);
        return 0;
      }
    }
  };
  
  // Initialize and return the controller
  return await controller.init();
}

/**
 * Ensure config file exists with default values
 */
function ensureConfigExists() {
  const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(DYNAMIC_PRICING_CONFIG_FILE)) {
    const defaultConfig = {
      enabled: false,
      country: 'DE',
      market: 'DE',
      apiKey: '',
      priceThreshold: 0.10,
      minimumSoC: 20,
      targetSoC: 80,
      scheduledCharging: false,
      chargingHours: [],
      lastUpdate: null,
      pricingData: generateSamplePricingData(),
      timezone: 'Europe/Berlin'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default dynamic pricing configuration file with sample data');
  }
}

/**
 * Load configuration from file
 */
function loadConfig() {
  try {
    const configData = fs.readFileSync(DYNAMIC_PRICING_CONFIG_FILE, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('Error loading dynamic pricing config:', error.message);
    return null;
  }
}

/**
 * Generate sample pricing data for testing - FIXED timezone handling
 */
function generateSamplePricingData() {
  const prices = [];
  const timezone = 'Europe/Berlin'; // Use consistent timezone
  
  // Get current time in the target timezone
  const now = new Date();
  const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: timezone}));
  
  // Start from the beginning of current hour in target timezone
  const startHour = new Date(nowInTimezone);
  startHour.setMinutes(0, 0, 0);
  
  // Generate 48 hours of sample data
  for (let i = 0; i < 48; i++) {
    const timestamp = new Date(startHour);
    timestamp.setHours(timestamp.getHours() + i);
    
    // Create realistic price pattern
    const hour = timestamp.getHours();
    let basePrice = 0.10;
    
    if (hour >= 7 && hour <= 9) {
      basePrice = 0.18; // Morning peak
    } else if (hour >= 17 && hour <= 21) {
      basePrice = 0.20; // Evening peak
    } else if (hour >= 1 && hour <= 5) {
      basePrice = 0.06; // Night valley
    } else if (hour >= 11 && hour <= 14) {
      basePrice = 0.08; // Midday valley
    }
    
    // Add randomness
    const randomFactor = 0.85 + (Math.random() * 0.3);
    const price = basePrice * randomFactor;
    
    // Convert back to UTC for storage but maintain timezone context
    const utcTimestamp = new Date(timestamp.toLocaleString("en-US", {timeZone: "UTC"}));
    
    prices.push({
      timestamp: utcTimestamp.toISOString(),
      price: parseFloat(price.toFixed(4)),
      currency: 'EUR',
      unit: 'kWh',
      timezone: timezone, // Add timezone info for reference
      localHour: hour // Store the local hour for reference
    });
  }
  
  return prices;
}

/**
 * Set up periodic tasks for dynamic pricing
 */
function setupPeriodicTasks(mqttClient, currentSystemState) {
  // Check charging schedule every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    try {
      if (controllerInstance && controllerInstance.enabled) {
        const shouldCharge = controllerInstance.shouldChargeNow();
        
        if (shouldCharge !== null) {
          controllerInstance.sendGridChargeCommand(shouldCharge);
          
          // Log the action
          const action = shouldCharge ? 'Enabled' : 'Disabled';
          const reason = shouldCharge ? 'Low price or scheduled time' : 'High price or target SoC reached';
          logAction(`Automatic grid charging ${action.toLowerCase()} - ${reason}`);
        }
      }
    } catch (error) {
      console.error('Error in periodic charging check:', error);
    }
  });
  
  // Regenerate sample data every 6 hours (for testing)
  cron.schedule('0 */6 * * *', () => {
    try {
      console.log('Regenerating sample pricing data...');
      const config = loadConfig();
      if (config) {
        config.pricingData = generateSamplePricingData();
        config.lastUpdate = new Date().toISOString();
        fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('Sample pricing data regenerated with proper timezone handling');
      }
    } catch (error) {
      console.error('Error regenerating sample data:', error);
    }
  });
  
  console.log('✅ Dynamic pricing periodic tasks initialized');
}

/**
 * Log an action to the dynamic pricing log file
 * @param {String} action - Description of the action
 */
function logAction(action) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${action}\n`;
    
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (error) {
    console.error('Error logging action:', error);
  }
}

module.exports = {
  initializeDynamicPricing,
  logAction
};