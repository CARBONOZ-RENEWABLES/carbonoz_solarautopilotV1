// dynamic-pricing-integration.js

/**
 * Integration module for dynamic electricity pricing feature
 * This module connects the dynamic pricing UI with the backend services
 * and provides the necessary APIs for the Solar Autopilot application
 */

const fs = require('fs');
const path = require('path');
const dynamicPricingService = require('./dynamicPricingService');
const dynamicPricingController = require('./dynamicPricingController');
const pricingApis = require('./pricingApis');

// Configuration file path
const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, 'data', 'dynamic_pricing_config.json');
const LOG_FILE = path.join(__dirname, 'logs', 'dynamic_pricing.log');

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
    controllerInstance = await dynamicPricingController.initialize(app, mqttClient, currentSystemState);
    
    // Set up additional API endpoints
    setupApiEndpoints(app, mqttClient, currentSystemState);
    
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
 * Set up additional API endpoints for the dynamic pricing feature
 * @param {Object} app - Express application instance
 * @param {Object} mqttClient - MQTT client instance
 * @param {Object} currentSystemState - Current system state object
 */
function setupApiEndpoints(app, mqttClient, currentSystemState) {
  // API endpoint to manually trigger grid charging
  app.post('/api/dynamic-pricing/manual-charge', async (req, res) => {
    try {
      const { enable } = req.body;
      
      if (enable === undefined) {
        return res.status(400).json({
          success: false, 
          error: 'Missing enable parameter'
        });
      }
      
      if (!controllerInstance || !controllerInstance.enabled) {
        return res.status(403).json({
          success: false,
          error: 'Dynamic pricing is not enabled'
        });
      }
      
      // Send the grid charge command
      const result = controllerInstance.sendGridChargeCommand(enable);
      
      // Log the action
      logAction(`Manual override: ${enable ? 'Enabled' : 'Disabled'} grid charging`);
      
      res.json({
        success: result,
        message: `Grid charging ${enable ? 'enabled' : 'disabled'} ${result ? 'successfully' : 'failed'}`
      });
    } catch (error) {
      console.error('Error processing manual charge request:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  });
  
  // API endpoint to get recent actions log
  app.get('/api/dynamic-pricing/actions-log', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const recentActions = getRecentActions(limit);
      
      res.json({
        success: true,
        actions: recentActions
      });
    } catch (error) {
      console.error('Error retrieving actions log:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve actions log'
      });
    }
  });
  
  // API endpoint to get system recommendation
  app.get('/api/dynamic-pricing/recommendation', (req, res) => {
    try {
      if (!controllerInstance) {
        return res.status(503).json({
          success: false,
          error: 'Dynamic pricing controller not initialized'
        });
      }
      
      // Get the current configuration
      const config = dynamicPricingService.loadConfig();
      
      if (!config || !config.enabled) {
        return res.json({
          success: true,
          recommendation: {
            shouldCharge: false,
            reason: 'Dynamic pricing is disabled',
            details: null
          }
        });
      }
      
      // Check if battery SoC is within range
      const batterySoC = currentSystemState?.battery_soc || 0;
      let shouldCharge = false;
      let reason = '';
      let details = null;
      
      if (batterySoC >= config.targetSoC) {
        // Battery already at target level
        shouldCharge = false;
        reason = 'Battery SoC has reached target level';
        details = {
          batterySoC: batterySoC,
          targetSoC: config.targetSoC
        };
      } else if (batterySoC < config.minimumSoC) {
        // Battery below minimum level - emergency charging
        shouldCharge = true;
        reason = 'Battery SoC below minimum level';
        details = {
          batterySoC: batterySoC,
          minimumSoC: config.minimumSoC
        };
      } else {
        // Check if current price is good for charging
        const isGoodTimeToCharge = controllerInstance.isGoodTimeToCharge();
        const isInScheduledTime = controllerInstance.isInScheduledChargingTime();
        
        if (isGoodTimeToCharge || isInScheduledTime) {
          shouldCharge = true;
          reason = isGoodTimeToCharge ? 'Current electricity price is low' : 'Within scheduled charging time';
          details = {
            batterySoC: batterySoC,
            targetSoC: config.targetSoC,
            isLowPrice: isGoodTimeToCharge,
            isScheduled: isInScheduledTime
          };
        } else {
          shouldCharge = false;
          reason = 'Current electricity price is not optimal';
          details = {
            batterySoC: batterySoC,
            targetSoC: config.targetSoC
          };
        }
      }
      
      res.json({
        success: true,
        recommendation: {
          shouldCharge,
          reason,
          details
        }
      });
    } catch (error) {
      console.error('Error generating recommendation:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate recommendation'
      });
    }
  });
  
  // API endpoint to get current pricing summary
  app.get('/api/dynamic-pricing/pricing-summary', (req, res) => {
    try {
      if (!controllerInstance) {
        return res.status(503).json({
          success: false,
          error: 'Dynamic pricing controller not initialized'
        });
      }
      
      // Get current pricing data
      const pricingData = controllerInstance.getPricingData();
      
      if (!pricingData || pricingData.length === 0) {
        return res.json({
          success: true,
          summary: {
            currentPrice: null,
            averagePrice: null,
            lowestPrice: null,
            highestPrice: null,
            pricesAvailable: false
          }
        });
      }
      
      // Get current hour price
      const now = new Date();
      const currentHour = now.getHours();
      
      const currentPrice = pricingData.find(p => {
        const date = new Date(p.timestamp);
        return date.getHours() === currentHour && 
               date.getDate() === now.getDate();
      });
      
      // Calculate statistics
      const prices = pricingData.map(p => p.price);
      const averagePrice = prices.reduce((acc, price) => acc + price, 0) / prices.length;
      const lowestPrice = Math.min(...prices);
      const highestPrice = Math.max(...prices);
      
      res.json({
        success: true,
        summary: {
          currentPrice: currentPrice ? currentPrice.price : null,
          averagePrice: averagePrice,
          lowestPrice: lowestPrice,
          highestPrice: highestPrice,
          pricesAvailable: true,
          timestamp: now.toISOString()
        }
      });
    } catch (error) {
      console.error('Error generating pricing summary:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate pricing summary'
      });
    }
  });
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

/**
 * Get recent actions from the log file
 * @param {Number} limit - Maximum number of actions to return
 * @returns {Array} Array of recent actions
 */
function getRecentActions(limit = 10) {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return [];
    }
    
    const logContent = fs.readFileSync(LOG_FILE, 'utf8');
    const logLines = logContent.split('\n').filter(line => line.trim() !== '');
    
    // Get the most recent entries
    const recentLines = logLines.slice(-limit).reverse();
    
    // Parse each line into a structured object
    return recentLines.map(line => {
      const parts = line.split(' - ');
      if (parts.length >= 2) {
        return {
          timestamp: parts[0],
          action: parts.slice(1).join(' - ')
        };
      }
      return {
        timestamp: new Date().toISOString(),
        action: line
      };
    });
  } catch (error) {
    console.error('Error reading actions log:', error);
    return [];
  }
}

/**
 * Trigger a manual price data update
 * This can be called from other parts of the application
 * @returns {Promise<Boolean>} Success status
 */
async function updatePricingData() {
  try {
    if (!controllerInstance) {
      console.error('Dynamic pricing controller not initialized');
      return false;
    }
    
    return await controllerInstance.updatePrices();
  } catch (error) {
    console.error('Error updating pricing data:', error);
    return false;
  }
}

/**
 * Get the current status of the dynamic pricing feature
 * @returns {Object} Current status object
 */
function getStatus() {
  try {
    if (!controllerInstance) {
      return {
        enabled: false,
        ready: false,
        lastUpdate: null
      };
    }
    
    const config = dynamicPricingService.loadConfig() || {};
    
    return {
      enabled: controllerInstance.enabled,
      ready: controllerInstance.isReady(),
      lastUpdate: config.lastUpdate || null,
      pricing: {
        dataAvailable: config.pricingData && config.pricingData.length > 0,
        count: config.pricingData ? config.pricingData.length : 0
      }
    };
  } catch (error) {
    console.error('Error getting dynamic pricing status:', error);
    return {
      enabled: false,
      ready: false,
      lastUpdate: null,
      error: error.message
    };
  }
}

module.exports = {
  initializeDynamicPricing,
  updatePricingData,
  getStatus,
  logAction
};