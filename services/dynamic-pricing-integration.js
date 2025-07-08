// services/dynamic-pricing-integration.js - TIBBER INTEGRATION

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, '..', 'data', 'dynamic_pricing_config.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'dynamic_pricing.log');

// Global instance of the Tibber controller
let tibberControllerInstance = null;

/**
 * Initialize Tibber dynamic pricing integration
 */
async function initializeDynamicPricing(app, mqttClient, currentSystemState) {
  try {
    console.log('🔋 Initializing Tibber electricity pricing integration...');
    
    // Create required directories
    const logDir = path.dirname(LOG_FILE);
    const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Initialize the Tibber controller
    tibberControllerInstance = await createTibberController(mqttClient, currentSystemState);
    
    // Set up Tibber-specific periodic tasks
    setupTibberPeriodicTasks(mqttClient, currentSystemState);
    
    console.log('✅ Tibber dynamic pricing integration complete');
    
    return tibberControllerInstance;
  } catch (error) {
    console.error('❌ Error initializing Tibber dynamic pricing integration:', error);
    return createFallbackController();
  }
}

/**
 * Create the Tibber dynamic pricing controller
 */
async function createTibberController(mqttClient, currentSystemState) {
  // Ensure config file exists
  ensureTibberConfigExists();
  
  const controller = {
    enabled: false,
    config: null,
    mqttClient: mqttClient,
    currentSystemState: currentSystemState,
    provider: 'Tibber',
    
    // Initialize the controller
    async init() {
      try {
        this.config = loadConfig();
        this.enabled = this.config && this.config.enabled;
        
        if (this.enabled) {
          console.log('🔋 Tibber dynamic pricing feature is ENABLED');
          
          if (this.config.apiKey && this.config.apiKey.trim() !== '') {
            console.log('✅ Tibber API token found, will fetch real pricing data');
          } else {
            console.log('⚠️ No Tibber API token found, will use sample data');
          }
          
          // Log configuration details
          console.log(`📍 Country: ${this.config.country}, Timezone: ${this.config.timezone}`);
          console.log(`🎯 Target SoC: ${this.config.targetSoC}%, Minimum SoC: ${this.config.minimumSoC}%`);
          console.log(`💡 Using Tibber price levels: ${this.config.useTibberLevels ? 'Yes' : 'No'}`);
          
          if (this.config.useTibberLevels) {
            console.log(`📊 Low price levels: ${(this.config.lowPriceLevels || ['VERY_CHEAP', 'CHEAP']).join(', ')}`);
          }
        } else {
          console.log('🔋 Tibber dynamic pricing feature is DISABLED');
        }
        
        return this;
      } catch (error) {
        console.error('Error initializing Tibber controller:', error.message);
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
        console.error('Error checking if Tibber pricing is ready:', error.message);
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
        console.error('Error getting Tibber pricing data:', error.message);
        return [];
      }
    },
    
    // Send a grid charge command
    sendGridChargeCommand(enable) {
      try {
        if (!this.enabled) {
          console.log('Tibber dynamic pricing is disabled, not sending grid charge command');
          return false;
        }
        
        const dynamicPricingMqtt = require('./dynamicPricingMqtt');
        
        // Check if learner mode is active
        if (!dynamicPricingMqtt.isLearnerModeActive()) {
          return dynamicPricingMqtt.simulateGridChargeCommand(enable, this.config);
        }
        
        // Send the actual command since learner mode is active
        const success = dynamicPricingMqtt.sendGridChargeCommand(this.mqttClient, enable, this.config);
        
        if (success) {
          const action = enable ? 'enabled' : 'disabled';
          logTibberAction(`Grid charging ${action} via Tibber price intelligence`);
        }
        
        return success;
      } catch (error) {
        console.error('Error sending Tibber grid charge command:', error.message);
        return false;
      }
    },
    
    // Check if now is a good time to charge using Tibber intelligence
    isGoodTimeToCharge() {
      try {
        if (!this.enabled || !this.config || !this.config.pricingData) {
          return false;
        }
        
        const timezone = this.config.timezone || 'Europe/Berlin';
        const now = new Date();
        
        // Find the current price
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
        
        // Use Tibber's intelligent price levels if available
        if (currentPrice.level && this.config.useTibberLevels) {
          const lowPriceLevels = this.config.lowPriceLevels || ['VERY_CHEAP', 'CHEAP'];
          const isLowPrice = lowPriceLevels.includes(currentPrice.level);
          
          if (isLowPrice) {
            console.log(`🔋 Tibber: Good time to charge - Price level: ${currentPrice.level}, Price: ${currentPrice.price} ${currentPrice.currency}/kWh`);
          }
          
          return isLowPrice;
        }
        
        // Fallback to threshold-based calculation
        const threshold = this.config.priceThreshold > 0 
          ? this.config.priceThreshold 
          : this.calculateAutoThreshold();
        
        const isLowPrice = currentPrice.price <= threshold;
        
        if (isLowPrice) {
          console.log(`🔋 Tibber: Good time to charge - Price: ${currentPrice.price} ${currentPrice.currency}/kWh (threshold: ${threshold})`);
        }
        
        return isLowPrice;
      } catch (error) {
        console.error('Error checking if now is good time to charge with Tibber:', error.message);
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
        
        // Battery already at target level
        if (batterySoC >= this.config.targetSoC) {
          return false; // Don't charge, battery is full
        }
        
        // Battery below minimum level - emergency charging
        if (batterySoC < this.config.minimumSoC) {
          console.log(`🔋 Tibber: Emergency charging needed - Battery SoC: ${batterySoC}% < ${this.config.minimumSoC}%`);
          return true;
        }
        
        // Check if we're in a scheduled charging time
        if (this.isInScheduledChargingTime()) {
          console.log('🔋 Tibber: Charging due to scheduled time period');
          return true;
        }
        
        // Use Tibber's price intelligence to decide
        return this.isGoodTimeToCharge();
      } catch (error) {
        console.error('Error checking if we should charge now with Tibber:', error.message);
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
    
    // Calculate automatic threshold from price data
    calculateAutoThreshold() {
      try {
        if (!this.config || !this.config.pricingData || this.config.pricingData.length === 0) {
          return 0.1; // Default threshold
        }
        
        const prices = this.config.pricingData.map(p => p.price).sort((a, b) => a - b);
        const index = Math.floor(prices.length * 0.25); // 25% lowest prices
        return prices[index] || 0.1;
      } catch (error) {
        console.error('Error calculating auto threshold:', error.message);
        return 0.1;
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
          provider: 'Tibber',
          dataSource: isReal ? 'real' : 'sample',
          hasApiKey: hasApiKey,
          dataPoints: this.config?.pricingData?.length || 0,
          lastUpdate: this.config?.lastUpdate || null,
          hasLevels: this.config?.pricingData?.some(p => p.level) || false,
          currency: this.config?.currency || 'EUR'
        };
      } catch (error) {
        return {
          provider: 'Tibber',
          dataSource: 'unknown',
          hasApiKey: false,
          dataPoints: 0,
          lastUpdate: null,
          hasLevels: false,
          currency: 'EUR'
        };
      }
    },
    
    // Get next best charging times using Tibber data
    getNextBestChargingTimes(hours = 4) {
      try {
        if (!this.config || !this.config.pricingData || this.config.pricingData.length === 0) {
          return [];
        }
        
        const timezone = this.config.timezone || 'Europe/Berlin';
        const now = new Date();
        
        // Get future prices only
        const futurePrices = this.config.pricingData.filter(p => {
          const priceTime = new Date(p.timestamp);
          return priceTime > now;
        });
        
        if (futurePrices.length === 0) {
          return [];
        }
        
        // If we have Tibber levels, prioritize by level
        if (futurePrices.some(p => p.level) && this.config.useTibberLevels) {
          const levelPriority = {
            'VERY_CHEAP': 1,
            'CHEAP': 2,
            'NORMAL': 3,
            'EXPENSIVE': 4,
            'VERY_EXPENSIVE': 5
          };
          
          const sortedByLevel = futurePrices.sort((a, b) => {
            const priorityA = levelPriority[a.level] || 3;
            const priorityB = levelPriority[b.level] || 3;
            
            if (priorityA !== priorityB) {
              return priorityA - priorityB;
            }
            
            // If same level, sort by price
            return a.price - b.price;
          });
          
          return sortedByLevel.slice(0, hours).map(p => {
            const priceTime = new Date(p.timestamp);
            return {
              time: priceTime.toLocaleTimeString([], { 
                hour: '2-digit', 
                minute: '2-digit',
                timeZone: timezone
              }),
              date: priceTime.toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
                timeZone: timezone
              }),
              price: p.price,
              currency: p.currency || this.config.currency,
              level: p.level
            };
          });
        }
        
        // Fallback to price-based sorting
        const sortedByPrice = futurePrices.sort((a, b) => a.price - b.price);
        
        return sortedByPrice.slice(0, hours).map(p => {
          const priceTime = new Date(p.timestamp);
          return {
            time: priceTime.toLocaleTimeString([], { 
              hour: '2-digit', 
              minute: '2-digit',
              timeZone: timezone
            }),
            date: priceTime.toLocaleDateString([], {
              month: 'short',
              day: 'numeric',
              timeZone: timezone
            }),
            price: p.price,
            currency: p.currency || this.config.currency,
            level: p.level || 'UNKNOWN'
          };
        });
      } catch (error) {
        console.error('Error getting next best charging times:', error);
        return [];
      }
    }
  };
  
  // Initialize and return the controller
  return await controller.init();
}

/**
 * Create a fallback controller when initialization fails
 */
function createFallbackController() {
  return {
    enabled: false,
    provider: 'Tibber',
    isReady: () => false,
    shouldChargeNow: () => false,
    sendGridChargeCommand: () => false,
    getPricingData: () => [],
    getDataSourceInfo: () => ({
      provider: 'Tibber',
      dataSource: 'none',
      hasApiKey: false,
      dataPoints: 0,
      lastUpdate: null
    })
  };
}

/**
 * Ensure Tibber config file exists with default values
 */
function ensureTibberConfigExists() {
  const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(DYNAMIC_PRICING_CONFIG_FILE)) {
    const defaultConfig = {
      enabled: false,
      country: 'DE',
      apiKey: '', // Tibber API token
      priceThreshold: 0, // Use automatic threshold
      minimumSoC: 20,
      targetSoC: 80,
      scheduledCharging: false,
      chargingHours: [],
      lastUpdate: null,
      pricingData: [],
      timezone: 'Europe/Berlin',
      useTibberLevels: true, // Use Tibber's price level intelligence
      lowPriceLevels: ['VERY_CHEAP', 'CHEAP'],
      currency: 'EUR'
    };
    
    fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default Tibber dynamic pricing configuration');
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
    console.error('Error loading Tibber dynamic pricing config:', error.message);
    return null;
  }
}

/**
 * Set up Tibber-specific periodic tasks
 */
function setupTibberPeriodicTasks(mqttClient, currentSystemState) {
  // Check charging schedule every 30 minutes (Tibber-optimized frequency)
  cron.schedule('*/30 * * * *', () => {
    try {
      if (tibberControllerInstance && tibberControllerInstance.enabled) {
        const shouldCharge = tibberControllerInstance.shouldChargeNow();
        
        if (shouldCharge !== null) {
          const commandSent = tibberControllerInstance.sendGridChargeCommand(shouldCharge);
          
          if (commandSent) {
            const action = shouldCharge ? 'Enabled' : 'Disabled';
            const reason = shouldCharge 
              ? 'Tibber indicates favorable price or emergency charging needed' 
              : 'Tibber indicates unfavorable price or target SoC reached';
            
            console.log(`🔋 Tibber: Automatic grid charging ${action.toLowerCase()} - ${reason}`);
            logTibberAction(`Automatic grid charging ${action.toLowerCase()} - ${reason}`);
          }
        }
      }
    } catch (error) {
      console.error('Error in Tibber periodic charging check:', error);
    }
  });
  
  // Fetch fresh Tibber pricing data every 4 hours
  cron.schedule('0 */4 * * *', async () => {
    try {
      console.log('🔋 Scheduled Tibber pricing data refresh...');
      const config = loadConfig();
      if (config && config.enabled) {
        
        if (config.apiKey && config.apiKey.trim() !== '') {
          try {
            const pricingApis = require('./pricingApis');
            const realData = await pricingApis.fetchElectricityPrices(config);
            
            if (realData && realData.length > 0) {
              config.pricingData = realData;
              config.lastUpdate = new Date().toISOString();
              
              // Update currency and timezone from real data
              if (realData[0].currency) config.currency = realData[0].currency;
              if (realData[0].timezone) config.timezone = realData[0].timezone;
              
              fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
              console.log(`✅ Scheduled Tibber refresh: Retrieved ${realData.length} real price points for ${config.country}`);
              
              // Update controller instance
              if (tibberControllerInstance) {
                tibberControllerInstance.config = config;
              }
              
              logTibberAction(`Scheduled data refresh completed - ${realData.length} price points from Tibber API`);
            } else {
              console.log('❌ Scheduled Tibber refresh: No real data returned, keeping existing data');
            }
          } catch (realDataError) {
            console.log(`❌ Scheduled Tibber refresh failed: ${realDataError.message}, keeping existing data`);
          }
        } else {
          console.log('No Tibber API token configured, skipping scheduled refresh');
        }
      }
    } catch (error) {
      console.error('Error in scheduled Tibber pricing refresh:', error);
    }
  });
  
  // Special refresh at 13:30 when Tibber typically publishes next day prices
  cron.schedule('30 13 * * *', async () => {
    try {
      console.log('🔋 Tibber daily price publication time - fetching latest prices');
      const config = loadConfig();
      if (config && config.enabled && config.apiKey) {
        const pricingApis = require('./pricingApis');
        try {
          const realData = await pricingApis.fetchElectricityPrices(config);
          if (realData && realData.length > 0) {
            config.pricingData = realData;
            config.lastUpdate = new Date().toISOString();
            fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
            
            console.log(`✅ Tibber daily refresh: Retrieved ${realData.length} price points including tomorrow's prices`);
            logTibberAction(`Daily price refresh completed - tomorrow's prices now available`);
            
            if (tibberControllerInstance) {
              tibberControllerInstance.config = config;
            }
          }
        } catch (error) {
          console.log(`❌ Tibber daily refresh failed: ${error.message}`);
        }
      }
    } catch (error) {
      console.error('Error in Tibber daily refresh:', error);
    }
  });
  
  console.log('✅ Tibber periodic tasks initialized with optimized scheduling');
}

/**
 * Log a Tibber action with rotation
 */
function logTibberAction(action) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - Tibber: ${action}\n`;
    
    // Check if log file exists and manage size
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      const fileSizeInKB = stats.size / 1024;
      
      // If file is larger than 100KB, rotate it
      if (fileSizeInKB > 100) {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        // Keep only last 50 lines
        const recentLines = lines.slice(-50);
        fs.writeFileSync(LOG_FILE, recentLines.join('\n') + '\n');
      }
    }
    
    // Append new log entry
    fs.appendFileSync(LOG_FILE, logEntry);
  } catch (error) {
    console.error('Error logging Tibber action:', error);
  }
}

module.exports = {
  initializeDynamicPricing,
  logAction: logTibberAction
};