// services/dynamic-pricing-integration.js - MAIN INTEGRATION WITH CONDITIONS

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const dynamicPricingService = require('./dynamicPricingService');
const dynamicPricingMqtt = require('./dynamicPricingMqtt');

// Global instance of the controller
let controllerInstance = null;
let cronJobs = [];

/**
 * Initialize dynamic pricing integration with advanced conditions
 */
async function initializeDynamicPricing(app, mqttClient, currentSystemState) {
  try {
    console.log('🔋 Initializing Dynamic Pricing with Advanced Conditions...');
    
    // Create required directories
    const logDir = path.join(__dirname, '..', 'logs');
    const dataDir = path.join(__dirname, '..', 'data');
    
    [logDir, dataDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
    
    // Ensure config exists
    dynamicPricingService.ensureConfigExists();
    
    // Initialize the controller
    controllerInstance = await createController(mqttClient, currentSystemState);
    
    // Set up periodic tasks
    setupPeriodicTasks(mqttClient, currentSystemState);
    
    // Add routes to the app
    const dynamicPricingRoutes = require('../routes/dynamicPricingRoutes');
    app.use('/api/dynamic-pricing', dynamicPricingRoutes);
    
    // Make instance globally available
    global.dynamicPricingInstance = controllerInstance;
    
    console.log('✅ Dynamic Pricing Integration Complete with Advanced Conditions:');
    console.log('   🎯 User-configurable price thresholds');
    console.log('   🌤️ Weather forecast integration');
    console.log('   ⚡ Power-based conditions (Load, PV, Battery)');
    console.log('   ⏰ Time-based conditions & peak avoidance');
    console.log('   🔄 Intelligent cooldown management');
    console.log('   🎛️ Manual override & force charging');
    console.log('   🔧 Inverter type auto-detection');
    
    return controllerInstance;
  } catch (error) {
    console.error('❌ Error initializing Dynamic Pricing:', error);
    return createFallbackController();
  }
}

/**
 * Create the dynamic pricing controller
 */
async function createController(mqttClient, currentSystemState) {
  const controller = {
    enabled: false,
    config: null,
    mqttClient: mqttClient,
    currentSystemState: currentSystemState,
    provider: 'Dynamic Pricing with Advanced Conditions',
    supportsInverterTypes: true,
    lastDecision: null,
    lastDecisionTime: null,
    
    // Initialize the controller
    async init() {
      try {
        this.config = dynamicPricingService.loadConfig();
        this.enabled = this.config && this.config.enabled;
        
        if (this.enabled) {
          console.log('🔋 Dynamic Pricing is ENABLED with Advanced Conditions');
          this.logCapabilities();
        } else {
          console.log('🔋 Dynamic Pricing is DISABLED');
        }
        
        return this;
      } catch (error) {
        console.error('Error initializing controller:', error.message);
        return this;
      }
    },
    
    // Log capabilities
    logCapabilities() {
      try {
        console.log('🎛️ Features Status:');
        
        // Price-based charging
        if (this.config.priceBasedCharging?.enabled) {
          const threshold = this.config.priceBasedCharging.maxPriceThreshold;
          console.log(`   💰 Price Threshold: ≤ ${threshold} ${this.config.currency}/kWh`);
        }
        
        // Weather integration
        if (this.config.conditions.weather?.enabled) {
          console.log(`   🌤️ Weather Integration: ENABLED`);
          if (this.config.conditions.weather.weatherApiKey) {
            console.log(`   📍 Location: ${this.config.conditions.weather.location.lat}, ${this.config.conditions.weather.location.lon}`);
          }
        }
        
        // Time conditions
        if (this.config.conditions.time?.enabled) {
          console.log(`   ⏰ Time Conditions: ENABLED`);
          if (this.config.conditions.time.avoidPeakHours) {
            console.log(`   🚫 Peak Hours Avoided: ${this.config.conditions.time.peakStart}-${this.config.conditions.time.peakEnd}`);
          }
        }
        
        // Power conditions
        const powerConditions = this.config.conditions.power;
        let powerEnabled = false;
        if (powerConditions.load?.enabled) {
          console.log(`   ⚡ Load Conditions: ${powerConditions.load.minLoadForCharging}-${powerConditions.load.maxLoadForCharging}W`);
          powerEnabled = true;
        }
        if (powerConditions.pv?.enabled) {
          console.log(`   ☀️ PV Conditions: ${powerConditions.pv.minPvForCharging}-${powerConditions.pv.maxPvForCharging}W`);
          powerEnabled = true;
        }
        if (powerConditions.battery?.enabled) {
          console.log(`   🔋 Battery Power Limit: ≤ ${powerConditions.battery.maxBatteryPowerForCharging}W`);
          powerEnabled = true;
        }
        
        if (!powerEnabled) {
          console.log(`   ⚡ Power Conditions: DISABLED`);
        }
        
        // Cooldown settings
        if (this.config.cooldown?.enabled) {
          console.log(`   ⏱️ Cooldown: ${this.config.cooldown.chargingCooldownMinutes}min, Max ${this.config.cooldown.maxChargingCyclesPerDay} cycles/day`);
        }
        
        // Battery settings
        console.log(`   🔋 Battery: Emergency ${this.config.battery.emergencySoC}%, Target ${this.config.battery.targetSoC}%, Max ${this.config.battery.maxSoC}%`);
        
        // Log current inverter types if available
        this.logInverterTypeStatus();
      } catch (error) {
        console.error('Error logging capabilities:', error);
      }
    },
    
    // Log current inverter type status
    logInverterTypeStatus() {
      try {
        if (global.inverterTypes && Object.keys(global.inverterTypes).length > 0) {
          const typesSummary = {};
          Object.entries(global.inverterTypes).forEach(([inverterId, data]) => {
            const type = data.type || 'unknown';
            typesSummary[type] = (typesSummary[type] || 0) + 1;
          });
          
          const summary = Object.entries(typesSummary)
            .map(([type, count]) => `${count}x ${type}`)
            .join(', ');
          
          console.log(`🔧 Detected Inverter Types: ${summary}`);
        } else {
          console.log('🔧 Inverter Type Detection: Waiting for MQTT messages...');
        }
      } catch (error) {
        console.error('Error logging inverter type status:', error);
      }
    },
    
    // Readiness check
    isReady() {
      try {
        if (!this.config) return false;
        
        const hasBasicConfig = !!(this.config.country && this.config.timezone);
        const hasPricingData = this.config.pricingData && this.config.pricingData.length > 0;
        
        // Readiness includes condition configurations
        let conditionsReady = true;
        
        // Weather readiness check
        if (this.config.conditions.weather?.enabled) {
          conditionsReady = conditionsReady && !!(this.config.conditions.weather.weatherApiKey);
        }
        
        const ready = hasBasicConfig && conditionsReady;
        
        if (ready && this.enabled) {
          console.log('🔋 Dynamic Pricing is READY with all advanced conditions');
        }
        
        return ready;
      } catch (error) {
        console.error('Error checking readiness:', error.message);
        return false;
      }
    },
    
    // Charging decision with all conditions
    async shouldChargeNow() {
      try {
        if (!this.enabled || !this.config) {
          return null;
        }
        
        const decision = await dynamicPricingService.shouldChargeNow(
          this.config, 
          this.currentSystemState
        );
        
        // Store the decision for status reporting
        this.lastDecision = decision;
        this.lastDecisionTime = new Date();
        
        return decision.shouldCharge;
      } catch (error) {
        console.error('Error in charging decision:', error.message);
        return null;
      }
    },
    
    // Grid charge command with all safety checks
    sendGridChargeCommand(enable) {
      try {
        if (!this.enabled) {
          console.log('Dynamic pricing is disabled, not sending grid charge command');
          return false;
        }
        
        return dynamicPricingService.sendGridChargeCommand(
          this.mqttClient, 
          enable, 
          this.config
        );
      } catch (error) {
        console.error('Error sending grid charge command:', error.message);
        return false;
      }
    },
    
    // Get status with all condition details
    getStatus() {
      try {
        const baseStatus = dynamicPricingService.getStatus(
          this.config, 
          this.currentSystemState
        );
        
        return {
          ...baseStatus,
          lastDecision: this.lastDecision,
          lastDecisionTime: this.lastDecisionTime,
          provider: this.provider,
          ready: this.isReady(),
          features: {
            priceThreshold: true,
            weatherForecast: true,
            powerConditions: true,
            timeConditions: true,
            cooldownManagement: true,
            inverterTypeSupport: true,
            manualOverride: true
          }
        };
      } catch (error) {
        console.error('Error getting status:', error.message);
        return {
          enabled: false,
          ready: false,
          provider: this.provider,
          error: error.message
        };
      }
    },
    
    // Manual charging with condition checking
    async manualCharge(enable, force = false) {
      try {
        if (!this.enabled) {
          return { success: false, reason: 'Dynamic pricing is disabled' };
        }
        
        // Check conditions unless forced
        if (!force && enable) {
          const decision = await dynamicPricingService.shouldChargeNow(
            this.config, 
            this.currentSystemState
          );
          
          if (!decision.shouldCharge) {
            return { 
              success: false, 
              reason: `Conditions not met: ${decision.reason}`,
              canForce: true,
              decision: decision
            };
          }
        }
        
        const success = this.sendGridChargeCommand(enable);
        
        if (success) {
          const action = enable ? 'enabled' : 'disabled';
          const method = force ? 'forced' : 'condition-based';
          dynamicPricingService.logAction(
            `Manual charging ${action} (${method}) with conditions`
          );
        }
        
        return { 
          success: success, 
          reason: success ? 'Command sent successfully' : 'Command failed' 
        };
      } catch (error) {
        console.error('Error in manual charging:', error);
        return { success: false, reason: error.message };
      }
    },
    
    // Get current pricing data
    getPricingData() {
      try {
        return this.config?.pricingData || [];
      } catch (error) {
        console.error('Error getting pricing data:', error.message);
        return [];
      }
    },
    
    // Test specific conditions
    async testConditions(testType) {
      try {
        switch (testType) {
          case 'weather':
            if (!this.config.conditions.weather?.enabled) {
              return { success: false, reason: 'Weather conditions are disabled' };
            }
            const weatherData = await dynamicPricingService.getWeatherForecast(this.config);
            const weatherAnalysis = dynamicPricingService.analyzeWeatherConditions(this.config, weatherData);
            return { success: true, result: { weatherData, weatherAnalysis } };
            
          case 'price':
            const priceCheck = await dynamicPricingService.checkPriceConditions(this.config);
            return { success: true, result: priceCheck };
            
          case 'time':
            const timeCheck = dynamicPricingService.checkTimeConditions(this.config);
            return { success: true, result: timeCheck };
            
          case 'power':
            const powerCheck = dynamicPricingService.checkPowerConditions(this.config, this.currentSystemState);
            return { success: true, result: powerCheck };
            
          case 'cooldown':
            const cooldownStatus = dynamicPricingService.getStatus(this.config, this.currentSystemState).cooldown;
            return { success: true, result: cooldownStatus };
            
          default:
            return { success: false, reason: 'Invalid test type' };
        }
      } catch (error) {
        console.error('Error testing conditions:', error);
        return { success: false, reason: error.message };
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
    provider: 'Dynamic Pricing (Fallback)',
    supportsInverterTypes: true,
    isReady: () => false,
    shouldChargeNow: () => null,
    sendGridChargeCommand: () => false,
    getPricingData: () => [],
    getStatus: () => ({
      enabled: false,
      ready: false,
      provider: 'Dynamic Pricing (Fallback)',
      features: {
        priceThreshold: true,
        weatherForecast: true,
        powerConditions: true,
        timeConditions: true,
        cooldownManagement: true,
        inverterTypeSupport: true
      }
    }),
    manualCharge: () => ({ success: false, reason: 'Dynamic pricing not available' }),
    testConditions: () => ({ success: false, reason: 'Dynamic pricing not available' })
  };
}

/**
 * Set up periodic tasks with intelligent scheduling
 */
function setupPeriodicTasks(mqttClient, currentSystemState) {
  console.log('⏰ Setting up Dynamic Pricing Cron Jobs...');
  
  // Main charging evaluation - every 10 minutes with condition checking
  const mainEvaluationJob = cron.schedule('*/10 * * * *', async () => {
    try {
      if (controllerInstance && controllerInstance.enabled) {
        console.log('🔋 Running scheduled charging evaluation with advanced conditions...');
        
        // Check if we're in cooldown
        if (dynamicPricingService.isInCooldown(controllerInstance.config)) {
          console.log('🔄 Skipping evaluation - system in cooldown');
          return;
        }
        
        const decision = await dynamicPricingService.shouldChargeNow(
          controllerInstance.config, 
          currentSystemState
        );
        
        if (decision.shouldCharge !== null) {
          const success = controllerInstance.sendGridChargeCommand(decision.shouldCharge);
          
          if (success) {
            const action = decision.shouldCharge ? 'enabled' : 'disabled';
            console.log(`🔋 Automatic charging ${action} - ${decision.reason} (Priority: ${decision.priority})`);
            
            dynamicPricingService.logAction(
              `Automatic charging ${action} - ${decision.reason} (Priority: ${decision.priority})`
            );
          }
        } else {
          console.log('🔋 No charging decision made - conditions evaluation inconclusive');
        }
      }
    } catch (error) {
      console.error('Error in periodic charging evaluation:', error);
      dynamicPricingService.updateCooldownState('error');
    }
  });
  
  // Pricing data refresh - every 4 hours with error handling
  const pricingRefreshJob = cron.schedule('0 */4 * * *', async () => {
    try {
      console.log('📊 Scheduled pricing data refresh with advanced analysis...');
      
      if (controllerInstance && controllerInstance.enabled) {
        const config = dynamicPricingService.loadConfig();
        
        if (config && config.apiKey && config.apiKey.trim() !== '') {
          try {
            const pricingApis = require('./pricingApis');
            const realData = await pricingApis.fetchElectricityPrices(config);
            
            if (realData && realData.length > 0) {
              config.pricingData = realData;
              config.lastUpdate = new Date().toISOString();
              
              // Update currency and timezone from real data
              if (realData[0].currency) config.currency = realData[0].currency;
              if (realData[0].timezone) config.timezone = realData[0].timezone;
              
              dynamicPricingService.saveConfig(config);
              
              console.log(`✅ Retrieved ${realData.length} price points for advanced analysis`);
              
              // Update controller instance
              if (controllerInstance) {
                controllerInstance.config = config;
              }
              
              dynamicPricingService.logAction(
                `Pricing data refresh completed - ${realData.length} price points with analysis`
              );
            } else {
              console.log('❌ No pricing data returned, keeping existing data');
            }
          } catch (realDataError) {
            console.log(`❌ Pricing refresh failed: ${realDataError.message}`);
            dynamicPricingService.logAction(
              `Pricing refresh failed: ${realDataError.message}`
            );
          }
        } else {
          console.log('No API token configured for automatic pricing refresh');
        }
      }
    } catch (error) {
      console.error('Error in scheduled pricing refresh:', error);
    }
  });
  
  // Weather data refresh - every 3 hours (more frequent than pricing)
  const weatherRefreshJob = cron.schedule('0 */3 * * *', async () => {
    try {
      if (controllerInstance && 
          controllerInstance.enabled && 
          controllerInstance.config?.conditions?.weather?.enabled) {
        
        console.log('🌤️ Refreshing weather forecast data...');
        
        const weatherData = await dynamicPricingService.getWeatherForecast(
          controllerInstance.config
        );
        
        if (weatherData.success) {
          const analysis = dynamicPricingService.analyzeWeatherConditions(
            controllerInstance.config, 
            weatherData
          );
          
          console.log(`🌤️ Weather analysis - ${analysis.reason}`);
          
          dynamicPricingService.logAction(
            `Weather forecast updated - ${analysis.reason}`
          );
        } else {
          console.log(`❌ Weather refresh failed: ${weatherData.error}`);
        }
      }
    } catch (error) {
      console.error('Error in weather refresh:', error);
    }
  });
  
  // Daily reset - midnight cooldown reset and status logging
  const dailyResetJob = cron.schedule('0 0 * * *', async () => {
    try {
      console.log('🌅 Daily reset - clearing cooldown cycles and logging status...');
      
      // Reset daily cycle count
      dynamicPricingService.updateCooldownState('daily_reset');
      
      if (controllerInstance && controllerInstance.enabled) {
        // Log daily status
        const status = controllerInstance.getStatus();
        console.log('📊 Daily Status:', {
          enabled: status.enabled,
          ready: status.ready,
          cooldownCycles: status.cooldown?.chargingCyclesUsed || 0,
          weatherEnabled: status.conditions?.weather?.enabled || false,
          powerConditionsEnabled: !!(status.conditions?.power?.load?.enabled || 
                                     status.conditions?.power?.pv?.enabled || 
                                     status.conditions?.power?.battery?.enabled)
        });
        
        dynamicPricingService.logAction(
          `Daily reset completed - cooldown cycles reset, status logged`
        );
      }
    } catch (error) {
      console.error('Error in daily reset:', error);
    }
  });
  
  // System health check - every 6 hours
  const healthCheckJob = cron.schedule('0 */6 * * *', () => {
    try {
      console.log('🏥 System health check...');
      
      if (controllerInstance) {
        const status = controllerInstance.getStatus();
        const healthScore = calculateHealthScore(status);
        
        console.log(`🏥 Health Score: ${healthScore}/100`);
        
        if (healthScore < 70) {
          console.log('⚠️ System health below optimal, check configuration');
          dynamicPricingService.logAction(
            `Health check warning - score ${healthScore}/100, check configuration`
          );
        } else {
          dynamicPricingService.logAction(
            `Health check passed - score ${healthScore}/100, all systems operational`
          );
        }
      }
    } catch (error) {
      console.error('Error in health check:', error);
    }
  });
  
  // Store job references for cleanup
  cronJobs = [
    mainEvaluationJob,
    pricingRefreshJob,
    weatherRefreshJob,
    dailyResetJob,
    healthCheckJob
  ];
  
  console.log('✅ Dynamic Pricing Cron Jobs Initialized:');
  console.log('   ⚡ Charging evaluation: Every 10 minutes');
  console.log('   📊 Pricing refresh: Every 4 hours');
  console.log('   🌤️ Weather refresh: Every 3 hours');
  console.log('   🌅 Daily reset: Midnight');
  console.log('   🏥 Health check: Every 6 hours');
}

/**
 * Calculate health score based on system status
 */
function calculateHealthScore(status) {
  let score = 0;
  
  // Basic functionality (40 points)
  if (status.enabled) score += 20;
  if (status.ready) score += 20;
  
  // Configuration completeness (30 points)
  if (status.conditions?.price?.enabled) score += 10;
  if (status.conditions?.time?.enabled) score += 5;
  if (status.conditions?.weather?.enabled) score += 10;
  if (status.conditions?.power?.load?.enabled || 
      status.conditions?.power?.pv?.enabled || 
      status.conditions?.power?.battery?.enabled) score += 5;
  
  // Cooldown management (20 points)
  if (!status.cooldown?.inCooldown) score += 10;
  if (status.cooldown?.chargingCyclesUsed < status.cooldown?.maxCyclesPerDay) score += 10;
  
  // Additional features (10 points)
  if (status.features?.inverterTypeSupport) score += 5;
  if (status.lastDecision) score += 5;
  
  return Math.min(score, 100);
}

/**
 * Cleanup function for graceful shutdown
 */
function cleanupDynamicPricing() {
  console.log('🧹 Cleaning up Dynamic Pricing...');
  
  // Stop all cron jobs
  cronJobs.forEach(job => {
    try {
      job.destroy();
    } catch (error) {
      console.error('Error stopping cron job:', error);
    }
  });
  
  cronJobs = [];
  
  // Clear global references
  if (global.dynamicPricingInstance) {
    global.dynamicPricingInstance = null;
  }
  
  console.log('✅ Dynamic Pricing cleanup completed');
}

// Export for legacy compatibility
function logAction(message) {
  dynamicPricingService.logAction(message);
}

module.exports = {
  initializeDynamicPricing,
  cleanupDynamicPricing,
  getInstance: () => controllerInstance,
  logAction
};