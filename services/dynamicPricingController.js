// dynamicPricingController.js

/**
 * Controller for dynamic pricing feature integration
 * This module ensures that the dynamic pricing feature only 
 * activates when explicitly enabled by the user
 */

const fs = require('fs');
const path = require('path');
const dynamicPricingService = require('./dynamicPricingService');
const dynamicPricingMqtt = require('./dynamicPricingMqtt');
const pricingApis = require('./pricingApis');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, 'data', 'dynamic_pricing_config.json');

/**
 * Initialize the dynamic pricing controller
 * @param {Object} app - Express application instance
 * @param {Object} mqttClient - MQTT client instance
 * @param {Object} currentSystemState - Current system state
 * @returns {Object} Controller instance
 */
function initialize(app, mqttClient, currentSystemState) {
  console.log('Initializing dynamic pricing controller...');
  
  // Create an instance of the controller
  const controller = {
    enabled: false,
    config: null,
    mqttClient: mqttClient,
    currentSystemState: currentSystemState,
    
    // Initialize the controller
    async init() {
      try {
        // Ensure the config file exists
        dynamicPricingService.ensureConfigExists();
        
        // Load the configuration
        this.config = dynamicPricingService.loadConfig();
        
        // Check if the feature is enabled
        this.enabled = this.config && this.config.enabled;
        
        // Log initialization status
        if (this.enabled) {
          console.log('Dynamic pricing feature is ENABLED');
          
          // Initialize the service
          await dynamicPricingService.initializeDynamicPricing(mqttClient, currentSystemState);
        } else {
          console.log('Dynamic pricing feature is DISABLED');
        }
        
        return this;
      } catch (error) {
        console.error('Error initializing dynamic pricing controller:', error.message);
        return this;
      }
    },
    
    // Enable the dynamic pricing feature
    async enable() {
      try {
        // Load the current config
        const config = dynamicPricingService.loadConfig();
        
        // Set enabled flag
        config.enabled = true;
        
        // Save the updated config
        const saved = dynamicPricingService.saveConfig(config);
        
        if (saved) {
          this.enabled = true;
          this.config = config;
          
          // Initialize the service
          await dynamicPricingService.initializeDynamicPricing(mqttClient, currentSystemState);
          
          console.log('Dynamic pricing feature has been ENABLED');
          return true;
        } else {
          console.error('Failed to save configuration when enabling dynamic pricing');
          return false;
        }
      } catch (error) {
        console.error('Error enabling dynamic pricing:', error.message);
        return false;
      }
    },
    
    // Disable the dynamic pricing feature
    disable() {
      try {
        // Load the current config
        const config = dynamicPricingService.loadConfig();
        
        // Set enabled flag
        config.enabled = false;
        
        // Save the updated config
        const saved = dynamicPricingService.saveConfig(config);
        
        if (saved) {
          this.enabled = false;
          this.config = config;
          
          console.log('Dynamic pricing feature has been DISABLED');
          return true;
        } else {
          console.error('Failed to save configuration when disabling dynamic pricing');
          return false;
        }
      } catch (error) {
        console.error('Error disabling dynamic pricing:', error.message);
        return false;
      }
    },
    
    // Update pricing data manually
    async updatePrices() {
      try {
        // Only update if the feature is enabled
        if (!this.enabled) {
          console.log('Dynamic pricing is disabled, skipping price update');
          return false;
        }
        
        // Update pricing data
        return await dynamicPricingService.updatePricingData(this.mqttClient, this.currentSystemState);
      } catch (error) {
        console.error('Error updating pricing data:', error.message);
        return false;
      }
    },
    
    // Check if the feature is ready to use (has all required settings)
    isReady() {
      try {
        if (!this.config) {
          return false;
        }
        
        // Check if all required settings are present
        const hasCountry = !!this.config.country;
        const hasMarket = !!this.config.market;
        const hasTimezone = !!this.config.timezone;
        
        // API key is only required for ENTSO-E markets
        const needsApiKey = !['DE', 'AT'].includes(this.config.country);
        const hasApiKey = needsApiKey ? !!this.config.apiKey : true;
        
        return hasCountry && hasMarket && hasTimezone && hasApiKey;
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
    
    // Send a grid charge command manually
    sendGridChargeCommand(enable) {
      try {
        // Only send if the feature is enabled
        if (!this.enabled) {
          console.log('Dynamic pricing is disabled, not sending grid charge command');
          return false;
        }
        
        return dynamicPricingMqtt.sendGridChargeCommand(this.mqttClient, enable, this.config);
      } catch (error) {
        console.error('Error sending grid charge command:', error.message);
        return false;
      }
    },
    
    // Check if now is a good time to charge (low price period)
    isGoodTimeToCharge() {
      try {
        if (!this.enabled || !this.config || !this.config.pricingData) {
          return false;
        }
        
        // Get current time in the configured timezone
        const now = new Date();
        
        // Find the current price
        const currentPrice = this.config.pricingData.find(p => {
          const priceTime = new Date(p.timestamp);
          return priceTime.getHours() === now.getHours() && 
                 priceTime.getDate() === now.getDate();
        });
        
        if (!currentPrice) {
          return false;
        }
        
        // Calculate threshold
        const threshold = this.config.priceThreshold > 0 
          ? this.config.priceThreshold 
          : this.calculateAveragePrice() * 0.75; // 25% below average if no threshold set
        
        // Check if current price is below threshold
        return currentPrice.price <= threshold;
      } catch (error) {
        console.error('Error checking if now is a good time to charge:', error.message);
        return false;
      }
    },
    
    // Check if we should charge based on battery state, price, and time
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
          // Battery below minimum level - don't use dynamic pricing
          // Let other protection mechanisms handle this
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
        const now = new Date();
        const currentTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
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
    },
    
    // Find the best charging times in the next 24 hours
    findBestChargingTimes(hours = 4) {
      try {
        if (!this.config || !this.config.pricingData || this.config.pricingData.length === 0) {
          return [];
        }
        
        // Sort prices ascending
        const sortedPrices = [...this.config.pricingData].sort((a, b) => a.price - b.price);
        
        // Get the lowest 'hours' number of prices
        return sortedPrices.slice(0, hours).map(p => ({
          time: new Date(p.timestamp).toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
          }),
          price: p.price,
          date: new Date(p.timestamp).toLocaleDateString()
        }));
      } catch (error) {
        console.error('Error finding best charging times:', error.message);
        return [];
      }
    }
  };
  
  // Return the initialized controller
  return controller.init();
}

module.exports = {
  initialize
};