// services/dynamic-pricing-integration.js - REAL DATA SUPPORT WITH MINIMAL LOGGING

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'dynamic_pricing_config.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'dynamic_pricing.log');

// Global instance of the controller
let controllerInstance = null;

/**
 * Initialize dynamic pricing integration with real data support
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
    
    // Set up periodic tasks with reduced frequency
    setupPeriodicTasks(mqttClient, currentSystemState);
    
    console.log('✅ Dynamic pricing integration complete');
    
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
 * Create the dynamic pricing controller with real data support
 */
async function createDynamicPricingController(mqttClient, currentSystemState) {
  // Ensure config file exists
  ensureConfigExists();
  
  const controller = {
    enabled: false,
    config: null,
    mqttClient: mqttClient,
    currentSystemState: currentSystemState,
    
    // Initialize the controller
    async init() {
      try {
        this.config = loadConfig();
        this.enabled = this.config && this.config.enabled;
        
        if (this.enabled) {
          console.log('Dynamic pricing feature is ENABLED');
          
          // Try to fetch real data if API key is available
          if (this.config.apiKey && this.config.apiKey.trim() !== '') {
            console.log('API key found, will attempt to fetch real data');
          } else {
            console.log('No API key found, will use sample data');
          }
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
        if (!this.enabled) {
          console.log('Dynamic pricing is disabled, not sending grid charge command');
          return false;
        }
        
        const dynamicPricingMqtt = require('./dynamicPricingMqtt');
        
        // Check if learner mode is active
        if (!dynamicPricingMqtt.isLearnerModeActive()) {
          return dynamicPricingMqtt.simulateGridChargeCommand(enable, this.config);
        }
        
        // Send the actual command since learner mode is active
        return dynamicPricingMqtt.sendGridChargeCommand(this.mqttClient, enable, this.config);
      } catch (error) {
        console.error('Error sending grid charge command:', error.message);
        return false;
      }
    },
    
    // Check if now is a good time to charge with real/sample data awareness
    isGoodTimeToCharge() {
      try {
        if (!this.enabled || !this.config || !this.config.pricingData) {
          return false;
        }
        
        const timezone = this.config.timezone || 'Europe/Berlin';
        const now = new Date();
        
        // Find the current price using timezone-aware comparison
        const currentPrice = this.config.pricingData.find(p => {
          const priceTime = new Date(p.timestamp);
          
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
          : this.calculateAveragePrice() * 0.75;
        
        // Check if current price is below threshold
        const isLowPrice = currentPrice.price <= threshold;
        
        // Log data source for debugging (minimal logging)
        if (currentPrice.source === 'real') {
          console.log(`Dynamic pricing: Using REAL data - Current price: ${currentPrice.price}, Threshold: ${threshold.toFixed(4)}`);
        }
        
        return isLowPrice;
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
        
        const batterySoC = this.currentSystemState?.battery_soc || 0;
        if (batterySoC >= this.config.targetSoC) {
          return false;
        }
        
        if (batterySoC < this.config.minimumSoC) {
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
        
        const timezone = this.config.timezone || 'Europe/Berlin';
        const now = new Date();
        const currentTimeStr = now.toLocaleTimeString([], { 
          hour: '2-digit', 
          minute: '2-digit',
          timeZone: timezone
        });
        
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
    },
    
    // Check if current data is real or sample
    isUsingRealData() {
      try {
        if (!this.config || !this.config.pricingData || this.config.pricingData.length === 0) {
          return false;
        }
        
        return this.config.pricingData[0].source === 'real';
      } catch (error) {
        return false;
      }
    },
    
    // Get data source information
    getDataSourceInfo() {
      try {
        const isReal = this.isUsingRealData();
        const hasApiKey = !!(this.config?.apiKey && this.config.apiKey.trim() !== '');
        
        return {
          dataSource: isReal ? 'real' : 'sample',
          hasApiKey: hasApiKey,
          dataPoints: this.config?.pricingData?.length || 0,
          lastUpdate: this.config?.lastUpdate || null
        };
      } catch (error) {
        return {
          dataSource: 'unknown',
          hasApiKey: false,
          dataPoints: 0,
          lastUpdate: null
        };
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
      pricingData: [], // Start with empty data
      timezone: 'Europe/Berlin'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default dynamic pricing configuration');
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
 * Set up periodic tasks for dynamic pricing - REDUCED FREQUENCY
 */
function setupPeriodicTasks(mqttClient, currentSystemState) {
  // Check charging schedule every 30 minutes (reduced from 15)
  cron.schedule('*/30 * * * *', () => {
    try {
      if (controllerInstance && controllerInstance.enabled) {
        const shouldCharge = controllerInstance.shouldChargeNow();
        
        if (shouldCharge !== null) {
          const commandSent = controllerInstance.sendGridChargeCommand(shouldCharge);
          
          if (commandSent) {
            const action = shouldCharge ? 'Enabled' : 'Disabled';
            const reason = shouldCharge ? 'Low price or scheduled time' : 'High price or target SoC reached';
            
            // MINIMAL logging - only for successful commands
            logMinimalAction(`Automatic grid charging ${action.toLowerCase()} - ${reason}`);
          }
        }
      }
    } catch (error) {
      console.error('Error in periodic charging check:', error);
    }
  });
  
  // Fetch fresh pricing data every 6 hours (instead of every hour)
  cron.schedule('0 */6 * * *', async () => {
    try {
      console.log('Scheduled pricing data refresh...');
      const config = loadConfig();
      if (config && config.enabled) {
        
        // Try to fetch real data if API key is available
        if (config.apiKey && config.apiKey.trim() !== '') {
          try {
            const pricingApis = require('./pricingApis');
            const realData = await pricingApis.fetchElectricityPrices(config);
            
            if (realData && realData.length > 0) {
              // Mark as real data and save
              config.pricingData = realData.map(p => ({ ...p, source: 'real' }));
              config.lastUpdate = new Date().toISOString();
              
              fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
              console.log(`✅ Scheduled refresh: Retrieved ${realData.length} real price points for ${config.country}`);
              
              // Update controller instance
              if (controllerInstance) {
                controllerInstance.config = config;
              }
            } else {
              console.log('❌ Scheduled refresh: No real data returned, keeping existing data');
            }
          } catch (realDataError) {
            console.log(`❌ Scheduled refresh failed: ${realDataError.message}, keeping existing data`);
          }
        } else {
          console.log('No API key configured, skipping scheduled refresh');
        }
      }
    } catch (error) {
      console.error('Error in scheduled pricing refresh:', error);
    }
  });
  
  console.log('✅ Dynamic pricing periodic tasks initialized with reduced frequency');
}

/**
 * Log an action to the dynamic pricing log file - MINIMAL LOGGING WITH ROTATION
 */
function logMinimalAction(action) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${action}\n`;
    
    // Check if log file exists and manage size
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      const fileSizeInKB = stats.size / 1024;
      
      // If file is larger than 50KB, rotate it
      if (fileSizeInKB > 50) {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        // Keep only last 25 lines
        const recentLines = lines.slice(-25);
        fs.writeFileSync(LOG_FILE, recentLines.join('\n') + '\n');
      }
    }
    
    // Append new log entry
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (error) {
    // Silently fail to prevent crashes
    console.error('Error logging action:', error);
  }
}

module.exports = {
  initializeDynamicPricing,
  logAction: logMinimalAction
};
