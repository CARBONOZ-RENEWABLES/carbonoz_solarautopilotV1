const express = require('express')
const bodyParser = require('body-parser')
const mqtt = require('mqtt')
const fs = require('fs')
const path = require('path')
const Influx = require('influx')
const ejs = require('ejs')
const moment = require('moment-timezone')
const WebSocket = require('ws')
const retry = require('async-retry')
const axios = require('axios')
const { backOff } = require('exponential-backoff')
const socketPort = 8000
const app = express()
const port = process.env.PORT || 6789
const { http } = require('follow-redirects')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const mongoose = require('mongoose')
const cron = require('node-cron')
const session = require('express-session');
const { startOfDay } = require('date-fns')
const { AuthenticateUser } = require('./utils/mongoService')

// Modify the Mongoose Schemas to include user identification
const SettingsChangeSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    topic: String,
    old_value: mongoose.Schema.Types.Mixed,
    new_value: mongoose.Schema.Types.Mixed,
    system_state: {
      battery_soc: Number,
      pv_power: Number,
      load: Number,
      grid_voltage: Number,
      grid_power: Number,
      inverter_state: mongoose.Schema.Types.Mixed,
      timestamp: String
    },
    change_type: String,
    // Add user identification fields
    user_id: String,
    mqtt_username: String
  })

// Rule Schema with user identification
const RuleSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    active: { type: Boolean, default: true },
    conditions: [{
      parameter: String,
      operator: String,
      value: Number,
    }],
    timeRestrictions: {
      days: [String],
      startTime: String,
      endTime: String,
      enabled: Boolean
    },
    actions: [{
      setting: String,
      value: String,
      inverter: String
    }],
    createdAt: { type: Date, default: Date.now },
    lastTriggered: Date,
    triggerCount: { type: Number, default: 0 },
    // Add user identification fields
    user_id: String,
    mqtt_username: String
  })




// Create MongoDB models
let SettingsChange
let Rule
let dbConnected = false

// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// Read configuration from Home Assistant add-on options
const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))

// Extract configuration values with defaults
const inverterNumber = options.inverter_number || 1
const batteryNumber = options.battery_number || 1
const mqttTopicPrefix = options.mqtt_topic_prefix || 'energy'
const mongoDbUri = options.mongodb_uri || process.env.MONGODB_URI || 'mongodb://localadmin:05e1LbNatrSacABiSYQy4vJE1Ol1EZorMwiaEpgpW7U9YBboHl@100.79.49.117:27017/energy_monitor?authSource=carbonoz_dev&directConnection=true'


// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json')
const RULES_FILE = path.join(__dirname, 'data', 'rules.json')
const CACHE_DURATION = 24 * 3600000 // 24 hours in milliseconds

// Create data directory if it doesn't exist
if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
}
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    apiKey: '',
    selectedZone: '',
    username: ''
  }));
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Disabled for development, enable in production
}))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}))

// Add this line BEFORE initializing the rate limiter
app.set('trust proxy', 1); // Trust first proxy

// Then initialize your rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// InfluxDB configuration
const influxConfig = {
  host: options.influxdb_host || 'localhost',
  port: options.influxdb_port || 8086,
  database: options.influxdb_database || 'home_assistant',
  username: options.influxdb_username || 'admin',
  password: options.influxdb_password || 'adminpassword',
  protocol: 'http',
  timeout: 10000,
}

// Initialize InfluxDB client with error handling
let influx
try {
  influx = new Influx.InfluxDB(influxConfig)
  console.log('InfluxDB client initialized')
} catch (error) {
  console.error('Error initializing InfluxDB client:', error.message)
  // Create a fallback that logs errors instead of crashing
  influx = {
    writePoints: async () => {
      console.error('InfluxDB not available, data not saved')
      return Promise.resolve() // Just resolve to avoid crashing
    }
  }
}

// MQTT configuration
const mqttConfig = {
  host: 'core-mosquitto',
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
  reconnectPeriod: 5000,
  connectTimeout: 30000
}

// Connect to MQTT broker
let mqttClient
let incomingMessages = []
const MAX_MESSAGES = 400

// Learner mode configuration
let learnerModeActive = false
const settingsToMonitor = [
  'energy_pattern',
  'grid_charge',
  'power',
  'device_mode',
  'voltage',
  'work_mode_timer',
  'voltage_point',
  // Battery charging settings
  'max_discharge_current',
  'max_charge_current',
  'max_grid_charge_current',
  'max_generator_charge_current',
  'battery_float_charge_voltage',
  'battery_absorption_charge_voltage',
  'battery_equalization_charge_voltage',
  // Work mode settings
  'remote_switch',
  'generator_charge',
  'force_generator_on',
  'output_shutdown_voltage',
  'stop_battery_discharge_voltage',
  'start_battery_discharge_voltage',
  'start_grid_charge_voltage',
  // Work mode detail settings
  'work_mode',
  'solar_export_when_battery_full',
  'max_sell_power',
  'max_solar_power',
  'grid_trickle_feed'
]

// System state tracking
let currentSystemState = {
  battery_soc: null,
  pv_power: null,
  load: null,
  grid_voltage: null,
  grid_power: null,
  inverter_state: null,
  timestamp: null
}

// Track previous state of settings to detect changes
let previousSettings = {}

// Connect to MongoDB database
async function connectToDatabase() {
    try {
      // Set mongoose options
      const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
        connectTimeoutMS: 10000,
      };
  
      // Connect to MongoDB
      await mongoose.connect(mongoDbUri, options);
      
      console.log('Connected to MongoDB');
      
      // Create models if connection successful
      SettingsChange = mongoose.model('SettingsChange', SettingsChangeSchema);
      Rule = mongoose.model('Rule', RuleSchema);
      
      // Create database indexes
      createDatabaseIndexes();
      
      dbConnected = true;
      
      return true;
    } catch (error) {
      console.error('MongoDB connection error:', error.message);
      dbConnected = false;
      
      // Models will be undefined until successful connection
      SettingsChange = null;
      Rule = null;
      
      return false;
    }
  }
  
// ================ USER IDENTIFICATION SYSTEM ================

// Function to generate a unique user ID based on MQTT credentials
function generateUserId() {
    // Create a unique identifier by combining MQTT username, hostname, and a fixed salt
    const userIdBase = `${mqttConfig.username}:${options.mqtt_host}:${options.mqtt_topic_prefix}`;
    
    // Use a simple hash function to create a shorter ID
    let hash = 0;
    for (let i = 0; i < userIdBase.length; i++) {
      const char = userIdBase.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return `user_${Math.abs(hash).toString(16)}`;
  }
  
  // Store the user ID as a global variable - place this after MQTT config is loaded
  const USER_ID = generateUserId();
  console.log(`Generated User ID: ${USER_ID}`);
  
  // Create database indexes for user identification
  async function createDatabaseIndexes() {
    if (!dbConnected) return;
    
    try {
      await SettingsChange.collection.createIndex({ user_id: 1 });
      
      await Rule.collection.createIndex({ mqtt_username: 1 });
      await Rule.collection.createIndex({ user_id: 1 });
      
      console.log('Database indexes created including user identification');
    } catch (error) {
      console.error('Error creating database indexes:', error.message);
    }
  }
  

// Function to retry DB connection in background
async function retryDatabaseConnection() {
  try {
    if (!dbConnected) {
      console.log('Retrying database connection...')
      await connectToDatabase()
    }
  } catch (error) {
    console.error('Failed to connect to database on retry:', error.message)
    // Schedule another retry
    setTimeout(retryDatabaseConnection, 30000)
  }
}

// Handle incoming MQTT messages
async function handleMqttMessage(topic, message) {
  const formattedMessage = `${topic}: ${message.toString()}`
  
  // Add to the circular buffer of messages
  incomingMessages.push(formattedMessage)
  if (incomingMessages.length > MAX_MESSAGES) {
    incomingMessages.shift()
  }

  // Parse message content
  let messageContent
  try {
    messageContent = message.toString()
    
    // Try to parse as JSON if it looks like JSON
    if (messageContent.startsWith('{') && messageContent.endsWith('}')) {
      messageContent = JSON.parse(messageContent)
    }
  } catch (error) {
    // If not JSON, keep as string
    messageContent = message.toString()
  }

  // Extract the specific topic part after the prefix
  const topicPrefix = options.mqtt_topic_prefix || ''
  let specificTopic = topic
  if (topic.startsWith(topicPrefix)) {
    specificTopic = topic.substring(topicPrefix.length + 1) // +1 for the slash
  }

  // Update system state for key metrics - always do this regardless of learner mode
  if (specificTopic.includes('total/battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent)
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss')
  } else if (specificTopic.includes('total/pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent)
  } else if (specificTopic.includes('total/load_power')) {
    currentSystemState.load = parseFloat(messageContent)
  } else if (specificTopic.includes('total/grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent)
  } else if (specificTopic.includes('total/grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent)
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent
  }

  // ** MODIFIED SECTION: Always handle setting changes, regardless of learner mode **
  try {
    // Handle existing settings changes
    if (specificTopic.includes('grid_charge')) {
      await handleSettingChange(specificTopic, messageContent, 'grid_charge')
    } else if (specificTopic.includes('energy_pattern')) {
      await handleSettingChange(specificTopic, messageContent, 'energy_pattern')
    } else if (specificTopic.includes('voltage_point')) {
      await handleSettingChange(specificTopic, messageContent, 'voltage_point')
    } 
    // Battery charging settings
    else if (specificTopic.includes('max_discharge_current')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_discharge_current')
    } else if (specificTopic.includes('max_charge_current')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_charge_current')
    } else if (specificTopic.includes('max_grid_charge_current')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_grid_charge_current')
    } else if (specificTopic.includes('max_generator_charge_current')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_generator_charge_current')
    } else if (specificTopic.includes('battery_float_charge_voltage')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'battery_float_charge_voltage')
    } else if (specificTopic.includes('battery_absorption_charge_voltage')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'battery_absorption_charge_voltage')
    } else if (specificTopic.includes('battery_equalization_charge_voltage')) {
      await handleBatteryChargingSettingChange(specificTopic, messageContent, 'battery_equalization_charge_voltage')
    }
    // Work mode settings
    else if (specificTopic.includes('remote_switch')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'remote_switch')
    } else if (specificTopic.includes('generator_charge')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'generator_charge')
    } else if (specificTopic.includes('force_generator_on')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'force_generator_on')
    } else if (specificTopic.includes('output_shutdown_voltage')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'output_shutdown_voltage')
    } else if (specificTopic.includes('stop_battery_discharge_voltage')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'stop_battery_discharge_voltage')
    } else if (specificTopic.includes('start_battery_discharge_voltage')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'start_battery_discharge_voltage')
    } else if (specificTopic.includes('start_grid_charge_voltage')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'start_grid_charge_voltage')
    }
    // Work mode detail settings
    else if (specificTopic.includes('work_mode') && !specificTopic.includes('work_mode_timer')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'work_mode')
    } else if (specificTopic.includes('solar_export_when_battery_full')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'solar_export_when_battery_full')
    } else if (specificTopic.includes('max_sell_power')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'max_sell_power')
    } else if (specificTopic.includes('max_solar_power')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'max_solar_power')
    } else if (specificTopic.includes('grid_trickle_feed')) {
      await handleWorkModeSettingChange(specificTopic, messageContent, 'grid_trickle_feed')
    } else {
      // Check if this is any other settings topic we're monitoring
      for (const setting of settingsToMonitor) {
        if (specificTopic.includes(setting)) {
          await handleSettingChange(specificTopic, messageContent, setting)
          break
        }
      }
    }
  } catch (error) {
    console.error('Error handling MQTT message:', error.message)
  }

  // Always update previousSettings to track the latest values
  if (settingsToMonitor.some(setting => specificTopic.includes(setting))) {
    previousSettings[specificTopic] = messageContent
  }

  // Process rules after updating system state
  try {
    await processRules()
  } catch (error) {
    console.error('Error processing rules:', error.message)
  }
}

// Function to handle setting changes
async function handleSettingChange(specificTopic, messageContent, changeType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    // Removed verbose log: console.log(`${changeType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
    
    // Create a detailed change record with user identification
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: changeType,
      // Add user identification
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent;
    
    // Save to database if connected
    if (dbConnected && SettingsChange) {
      try {
        const settingsChange = new SettingsChange(changeData);
        await settingsChange.save();
        // Removed verbose log: console.log('Change saved to database');
      } catch (error) {
        console.error('Error saving to database:', error.message);
        // If DB fails, log to console as fallback but just the error, not full change data
      }
    } else {
      // Try to connect to database in background
      retryDatabaseConnection();
    }
    
    // Send notifications based on change type - these are just status update functions
    // that don't need console.log outputs themselves
    if (changeType === 'grid_charge') {
      sendGridChargeNotification(changeData);
    } else if (changeType === 'energy_pattern') {
      sendEnergyPatternNotification(changeData);
    } else if (changeType === 'voltage_point') {
      sendVoltagePointNotification(changeData);
    }
  }
}


// Function to handle battery charging setting changes
async function handleBatteryChargingSettingChange(specificTopic, messageContent, settingType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    // Removed verbose log: console.log(`${settingType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
    
    // Create a detailed change record with user identification
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: settingType,
      // Add user identification
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent;
    
    // Save to database if connected
    if (dbConnected && SettingsChange) {
      try {
        const settingsChange = new SettingsChange(changeData);
        await settingsChange.save();
        // Removed verbose log: console.log('Battery charging setting change saved to database');
      } catch (error) {
        console.error('Error saving to database:', error.message);
      }
    } else {
      // Try to connect to database in background
      retryDatabaseConnection();
    }
    
    // Send notification without logging
    sendBatteryChargingNotification(changeData);
  }
}
// Function to handle work mode setting changes
async function handleWorkModeSettingChange(specificTopic, messageContent, settingType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    // Removed verbose log: console.log(`${settingType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
    
    // Create a detailed change record with user identification
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: settingType,
      // Add user identification
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent;
    
    // Save to database if connected
    if (dbConnected && SettingsChange) {
      try {
        const settingsChange = new SettingsChange(changeData);
        await settingsChange.save();
        // Removed verbose log: console.log('Work mode setting change saved to database');
      } catch (error) {
        console.error('Error saving to database:', error.message);
      }
    } else {
      // Try to connect to database in background
      retryDatabaseConnection();
    }
    
    // Send notification without logging
    sendWorkModeNotification(changeData);
  }
}

// Modify notification functions to not use console.log
function sendGridChargeNotification(changeData) {
}

function sendEnergyPatternNotification(changeData) {
}

function sendVoltagePointNotification(changeData) {
}

function sendBatteryChargingNotification(changeData) {
}

function sendWorkModeNotification(changeData) {
}



// Function to generate category options
function generateCategoryOptions(inverterNumber, batteryNumber) {
  const categories = ['all', 'loadPower', 'gridPower', 'pvPower', 'total']

  for (let i = 1; i <= inverterNumber; i++) {
    categories.push(`inverter${i}`)
  }

  for (let i = 1; i <= batteryNumber; i++) {
    categories.push(`battery${i}`)
  }

  return categories
}

// ================ TIME ZONE ================

const timezonePath = path.join(__dirname, 'timezone.json')

function getCurrentTimezone() {
  try {
    const data = fs.readFileSync(timezonePath, 'utf8')
    return JSON.parse(data).timezone
  } catch (error) {
    return 'Europe/Berlin' // Default timezone
  }
}

function setCurrentTimezone(timezone) {
  fs.writeFileSync(timezonePath, JSON.stringify({ timezone }))
}

let currentTimezone = getCurrentTimezone()

function getSelectedZone(req) {
    // First, check if a zone is provided in the query
    if (req.query.zone) {
      return req.query.zone;
    }
    return null;
  }

// Function to filter messages by category
function filterMessagesByCategory(category) {
    if (category === 'all') {
      return incomingMessages
    }
  
    return incomingMessages.filter((message) => {
      const topic = message.split(':')[0]
      const topicParts = topic.split('/')
  
      if (category.startsWith('inverter')) {
        const inverterNum = category.match(/\d+$/)[0]
        return topicParts[1] === `inverter_${inverterNum}`
      }
  
      if (category.startsWith('battery')) {
        const batteryNum = category.match(/\d+$/)[0]
        return topicParts[1] === `battery_${batteryNum}`
      }
  
      const categoryKeywords = {
        loadPower: ['load_power'],
        gridPower: ['grid_power'],
        pvPower: ['pv_power'],
        total: ['total'],
      }
  
      return categoryKeywords[category]
        ? topicParts.some((part) => categoryKeywords[category].includes(part))
        : false
    })
  }


// ================ INVERTER AND BATTERY CHECKING================

function checkInverterMessages(messages, expectedInverters) {
    const inverterPattern = new RegExp(`${mqttTopicPrefix}/inverter_(\\d+)/`)
    const foundInverters = new Set()
  
    messages.forEach((message) => {
      const match = message.match(inverterPattern)
      if (match) {
        foundInverters.add(parseInt(match[1]))
      }
    })
  
    if (foundInverters.size !== expectedInverters) {
      return `Warning: Expected ${expectedInverters} inverter(s), but found messages from ${foundInverters.size} inverter(s).`
    }
    return null
  }
  
  function checkBatteryInformation(messages) {
    // More flexible battery pattern that matches various battery topic formats
    const batteryPatterns = [
      new RegExp(`${mqttTopicPrefix}/battery_\\d+/`),
      new RegExp(`${mqttTopicPrefix}/battery/`),
      new RegExp(`${mqttTopicPrefix}/total/battery`),
      new RegExp(`${mqttTopicPrefix}/\\w+/battery`),
    ]
  
    // Check if any message matches any of the battery patterns
    const hasBatteryInfo = messages.some((message) =>
      batteryPatterns.some((pattern) => pattern.test(message))
    )
  
    // Add debug logging to help troubleshoot
    if (!hasBatteryInfo) {
      console.log(
        'Debug: No battery messages found. Current messages:',
        messages.filter((msg) => msg.toLowerCase().includes('battery'))
      )
      return 'Warning: No battery information found in recent messages.'
    }
  
    return null
  }
  
  // Helper function to see what battery messages are being received
  function debugBatteryMessages(messages) {
    const batteryMessages = messages.filter((msg) =>
      msg.toLowerCase().includes('battery')
    )
    console.log('Current battery-related messages:', batteryMessages)
    return batteryMessages
  }

// ================ GRAFANA  ================

const DASHBOARD_CONFIG_PATH = path.join(__dirname, 'grafana', 'provisioning', 'dashboards', 'solar_power_dashboard.json');

// API endpoint to get solar data from the JSON file
app.get('/api/solar-data', (req, res) => {
  try {
      const dashboardData = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
      
      // Extract the necessary panel information from the dashboard config
      const solarData = {};
      
      // Parse through panels and extract configuration
      dashboardData.panels.forEach(panel => {
          const panelId = panel.id.toString();
          const title = panel.title;
          const fieldConfig = panel.fieldConfig?.defaults || {};
          
          solarData[panelId] = {
              title,
              unit: fieldConfig.unit || '',
              min: fieldConfig.min,
              max: fieldConfig.max,
              thresholds: fieldConfig.thresholds?.steps || [],
              customProperties: {
                  neutral: fieldConfig.custom?.neutral,
                  orientation: panel.options?.orientation || 'auto'
              }
          };
          
          // Add any special configurations based on panel type
          if (panel.type === 'gauge') {
              solarData[panelId].gaugeConfig = {
                  showThresholdLabels: panel.options?.showThresholdLabels || false,
                  showThresholdMarkers: panel.options?.showThresholdMarkers || true
              };
          }
      });
      
      res.json(solarData);
  } catch (error) {
      console.error('Error reading dashboard config:', error);
      res.status(500).json({ 
          success: false, 
          message: 'Failed to retrieve solar data',
          error: error.message 
      });
  }
});

// API endpoint to update panel configuration including thresholds
app.post('/api/update-panel-config', (req, res) => {
  try {
      const { panelId, min, max, thresholds } = req.body;
      
      if (typeof min !== 'number' || typeof max !== 'number') {
          return res.status(400).json({
              success: false,
              message: 'Min and max values must be numbers'
          });
      }
      
      // Read the current dashboard config
      const dashboardData = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
      
      // Find the specific panel by ID
      const panel = dashboardData.panels.find(p => p.id.toString() === panelId);
      
      if (!panel) {
          return res.status(404).json({ 
              success: false, 
              message: `Panel with ID ${panelId} not found` 
          });
      }
      
      // Ensure the fieldConfig structure exists
      if (!panel.fieldConfig) panel.fieldConfig = {};
      if (!panel.fieldConfig.defaults) panel.fieldConfig.defaults = {};
      
      // Update the min and max values
      panel.fieldConfig.defaults.min = min;
      panel.fieldConfig.defaults.max = max;
      
      // Update thresholds if provided
      if (thresholds && Array.isArray(thresholds)) {
          // Ensure thresholds structure exists
          if (!panel.fieldConfig.defaults.thresholds) {
              panel.fieldConfig.defaults.thresholds = { mode: 'absolute', steps: [] };
          }
          
          // Convert thresholds array to the format expected by Grafana
          panel.fieldConfig.defaults.thresholds.steps = thresholds.map((threshold, index) => {
              return {
                  color: threshold.color,
                  value: index === 0 ? null : threshold.value // First threshold has null value in Grafana
              };
          });
      }
      
      // Write the updated config back to the file
      fs.writeFileSync(DASHBOARD_CONFIG_PATH, JSON.stringify(dashboardData, null, 2), 'utf8');
      
      res.json({ 
          success: true, 
          message: 'Panel configuration updated successfully',
          updatedConfig: {
              min,
              max,
              thresholds: panel.fieldConfig.defaults.thresholds.steps,
              panelId
          }
      });
  } catch (error) {
      console.error('Error updating panel configuration:', error);
      res.status(500).json({ 
          success: false, 
          message: 'Failed to update panel configuration',
          error: error.message 
      });
  }
});





// ================ ROUTERS ================

app.get('/', async (req, res) => {

  const expectedInverters = parseInt(options.inverter_number) || 1
  const inverterWarning = checkInverterMessages(
    incomingMessages,
    expectedInverters)

  const batteryWarning = checkBatteryInformation(incomingMessages)
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    const selectedZone = settings.selectedZone;
    
    if (!selectedZone) {
      // Redirect to settings page if zone is not configured
      return res.redirect('/settings?message=Please configure your zone first');
    }
    
    let historyData = [], gridEnergyIn = [], pvEnergy = [], gridVoltage = [];
    let isLoading = false;
    let error = null;
    
    try {
      // Check if we have cached carbon intensity data
      const cacheKey = selectedZone;
      const isCached = carbonIntensityCacheByZone.has(cacheKey) && 
                      (Date.now() - carbonIntensityCacheByZone.get(cacheKey).timestamp < CACHE_DURATION);
      
      if (isCached) {
        historyData = carbonIntensityCacheByZone.get(cacheKey).data;
      } else {
        // Set loading state
        isLoading = true;
      }
      
      // Fetch energy data from InfluxDB
      [gridEnergyIn, pvEnergy, gridVoltage] = await Promise.all([
        queryInfluxData(`${mqttTopicPrefix}/total/grid_energy_in/state`, '365d'),
        queryInfluxData(`${mqttTopicPrefix}/total/pv_energy/state`, '365d'),
        queryInfluxData(`${mqttTopicPrefix}/total/grid_voltage/state`, '365d')
      ]);
      
      // If not cached, fetch carbon intensity data
      if (!isCached) {
        historyData = await fetchCarbonIntensityHistory(selectedZone);
        isLoading = false;
      }
    } catch (e) {
      console.error('Error fetching data:', e);
      error = 'Error fetching data. Please try again later.';
      isLoading = false;
      
    }
    
    // Calculate emissions data for the period
    const emissionsData = calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage);
    
    // Get today's data (last item in the array) using current date
    const todayData = emissionsData.length > 0 ? emissionsData[emissionsData.length - 1] : {
      date: moment().format('YYYY-MM-DD'),
      unavoidableEmissions: 0,
      avoidedEmissions: 0,
      selfSufficiencyScore: 0,
      gridEnergy: 0,
      solarEnergy: 0,
      carbonIntensity: 0
    };
    
    // Calculate totals for different time periods
    const weekData = emissionsData.slice(-7);
    const monthData = emissionsData.slice(-30);
    
    const summaryData = {
      today: todayData,
      week: {
        unavoidableEmissions: weekData.reduce((sum, day) => sum + day.unavoidableEmissions, 0),
        avoidedEmissions: weekData.reduce((sum, day) => sum + day.avoidedEmissions, 0),
        selfSufficiencyScore: weekData.reduce((sum, day) => sum + day.selfSufficiencyScore, 0) / Math.max(1, weekData.length)
      },
      month: {
        unavoidableEmissions: monthData.reduce((sum, day) => sum + day.unavoidableEmissions, 0),
        avoidedEmissions: monthData.reduce((sum, day) => sum + day.avoidedEmissions, 0),
        selfSufficiencyScore: monthData.reduce((sum, day) => sum + day.selfSufficiencyScore, 0) / Math.max(1, monthData.length)
      }
    };
    
    // Render the welcome page with the data
    res.render('energy-dashboard', {
      selectedZone,
      todayData: {
        ...todayData,
        date: moment().format('YYYY-MM-DD') // Explicitly set to current date
      },
      summaryData,
      isLoading,
      error,
      ingress_path: process.env.INGRESS_PATH || '',
      mqtt_host: options.mqtt_host, // Include mqtt_host here
      inverterWarning,
      batteryWarning,
      batteryMessages: debugBatteryMessages(incomingMessages), // Add this for debugging in the view
      username: options.mqtt_username || 'User'
    });
  } catch (error) {
    console.error('Error rendering welcome page:', error);
    res.status(500).render('error', { error: 'Error loading welcome page' });
  }
});


app.get('/analytics', async (req, res) => {
  try {
    const selectedZone = req.query.zone || JSON.parse(fs.readFileSync(SETTINGS_FILE)).selectedZone;
    let carbonIntensityData = [];

    if (selectedZone) {
      try {
        carbonIntensityData = await fetchCarbonIntensityHistory(selectedZone);
      } catch (error) {
        console.error('Error fetching carbon intensity data:', error);
      }
    }
    
    const [
      loadPowerData, 
      pvPowerData, 
      batteryStateOfChargeData, 
      batteryPowerData, 
      gridPowerData, 
      gridVoltageData,
      loadPowerYear,
      pvPowerYear,
      batteryStateOfChargeYear,
      batteryPowerYear,
      gridPowerYear,
      gridVoltageYear,
      loadPowerDecade,
      pvPowerDecade,
      batteryStateOfChargeDecade,
      batteryPowerDecade,
      gridPowerDecade,
      gridVoltageDecade
    ] = await Promise.all([
      queryInfluxDB(`${mqttTopicPrefix}/total/load_energy/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/pv_energy/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_in/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_out/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_in/state`),
      queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_out/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/load_energy/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/pv_energy/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/battery_energy_in/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/battery_energy_out/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/grid_energy_in/state`),
      queryInfluxDBForYear(`${mqttTopicPrefix}/total/grid_energy_out/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/load_energy/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/pv_energy/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/battery_energy_in/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/battery_energy_out/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/grid_energy_in/state`),
      queryInfluxDBForDecade(`${mqttTopicPrefix}/total/grid_energy_out/state`)
    ]);

    // Get the list of zones to pass to the template
    const zones = await getZones();

    const data = {
      loadPowerData,
      pvPowerData,
      batteryStateOfChargeData,
      batteryPowerData,
      gridPowerData,
      gridVoltageData,
      carbonIntensityData,
      selectedZone,
      zones, // Add zones to the data object
      loadPowerYear,
      pvPowerYear,
      batteryStateOfChargeYear,
      batteryPowerYear,
      gridPowerYear,
      gridVoltageYear,
      loadPowerDecade,
      pvPowerDecade,
      batteryStateOfChargeDecade,
      batteryPowerDecade,
      gridPowerDecade,
      gridVoltageDecade
    };

    res.render('analytics', {
      data,
      ingress_path: process.env.INGRESS_PATH || '',
      selectedZone // Pass selectedZone to the template for pre-selecting in dropdowns
    })
  } catch (error) {
    console.error('Error fetching analytics data:', error);
    res.status(500).json({ 
      error: 'Error fetching analytics data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
})


app.get('/results', async (req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    const selectedZone = req.query.zone || settings.selectedZone;
    const zones = await getZones();

    let historyData = [], gridEnergyIn = [], pvEnergy = [], gridVoltage = [];
    let error = null;
    let isLoading = false;

    if (selectedZone) {
      try {
        // Check if we have cached data
        const cacheKey = `${selectedZone}`; // Corrected template literal
        const isCached = carbonIntensityCacheByZone.has(cacheKey) && 
                         (Date.now() - carbonIntensityCacheByZone.get(cacheKey).timestamp < CACHE_DURATION);

        if (isCached) {
          historyData = carbonIntensityCacheByZone.get(cacheKey).data;
        } else {
          // Set loading state
          isLoading = true;
        }

        // Fetch InfluxDB data in parallel
        [gridEnergyIn, pvEnergy, gridVoltage] = await Promise.all([
          queryInfluxData(`${mqttTopicPrefix}/total/grid_energy_in/state`, '365d'),
          queryInfluxData(`${mqttTopicPrefix}/total/pv_energy/state`, '365d'),
          queryInfluxData(`${mqttTopicPrefix}/total/grid_voltage/state`, '365d')
        ]);

        // If not cached, fetch carbon intensity data
        if (!isCached) {
          historyData = await fetchCarbonIntensityHistory(selectedZone);
          carbonIntensityCacheByZone.set(cacheKey, { data: historyData, timestamp: Date.now() }); // Update cache
          isLoading = false;
        }
      } catch (e) {
        console.error('Error fetching data:', e);
        error = 'Error fetching data. Please try again later.';
        isLoading = false;
      }
    }

    // Today's date in YYYY-MM-DD format
    const currentDate = moment().format('YYYY-MM-DD');

    // Process the data
    const emissionsData = calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage);

    // Update the last entry with today's date if it exists
    if (emissionsData.length > 0) {
      emissionsData[emissionsData.length - 1].date = currentDate;
    }

    // Find today's data specifically
    const todayData = emissionsData.find(item => item.date === currentDate) || {
      date: currentDate,
      unavoidableEmissions: 0,
      avoidedEmissions: 0,
      selfSufficiencyScore: 0,
      gridEnergy: 0,
      solarEnergy: 0,
      carbonIntensity: 0,
      formattedDate: moment(currentDate).format('MMM D, YYYY')
    };

    // Create periods including today as its own period
    const periods = {
      today: [todayData], // Today's data as a single-item array
      week: emissionsData.slice(-7),
      month: emissionsData.slice(-30),
      quarter: emissionsData.slice(-90),
      year: emissionsData
    };

    // Pass all needed date formats to the template
    res.render('results', {
      selectedZone,
      zones,
      periods,
      todayData,
      error,
      isLoading,
      unavoidableEmissions: todayData.unavoidableEmissions,
      avoidedEmissions: todayData.avoidedEmissions,
      selfSufficiencyScore: todayData.selfSufficiencyScore,
      currentDate: currentDate,
      formattedDate: moment(currentDate).format('MMM D, YYYY'),
      dateString: moment(currentDate).format('MMM D, YYYY'),
      ingress_path: process.env.INGRESS_PATH || '',
    });
  } catch (error) {
    console.error('Server error:', error); // Log the error for debugging
    res.status(500).render('error', { error: 'Error loading results' });
  }
});

app.post('/save-zone', (req, res) => {
  const { zone } = req.body;
  console.log(`Zone saved: ${zone}`);
  res.json({ success: true, message: 'Zone saved successfully' });
});


app.get('/settings', async (req, res) => {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    const zonesResponse = await getZones();
    
    res.render('settings', { 
      settings,
      ingress_path: process.env.INGRESS_PATH || '',
      zones: zonesResponse.zones,
      message: req.query.message,
      error: zonesResponse.error
    });
  } catch (error) {
    res.status(500).render('error', { error: 'Error loading settings' });
  }
});

app.post('/settings', async (req, res) => {
  try {
    const { timezone, apiKey, selectedZone } = req.body;
    
    // Read current settings
    let currentSettings = {};
    try {
      const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
      currentSettings = JSON.parse(settingsData);
    } catch (err) {
      // If settings file doesn't exist yet, use empty defaults
      currentSettings = {
        apiKey: '',
        selectedZone: '',
        timezone: ''
      };
    }
    
    // Update only the provided fields
    const settings = {
      apiKey: apiKey !== undefined ? apiKey : currentSettings.apiKey,
      selectedZone: selectedZone !== undefined ? selectedZone : currentSettings.selectedZone,
      timezone: timezone !== undefined ? timezone : currentSettings.timezone
    };

    // Validate that we have at least one valid field
    if (!settings.selectedZone && !settings.apiKey) {
      return res.status(400).json({
        success: false,
        error: 'At least one of API key or zone must be provided'
      });
    }

    // Save the settings to the settings file
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // Update the current timezone if provided
    if (timezone) {
      currentTimezone = timezone;
      setCurrentTimezone(timezone);
    }

    res.json({
      success: true,
      message: 'Settings saved successfully'
    });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save settings'
    });
  }
});

app.post('/save-zone', (req, res) => {
  try {
      const { zone } = req.body;
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
      settings.selectedZone = zone;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      console.log(`Zone saved: ${zone}`);
      res.json({ success: true, message: 'Zone saved successfully' });
  } catch (error) {
      console.error('Error saving zone:', error);
      res.status(500).json({ success: false, error: 'Failed to save zone' });
  }
});

app.get('/api/messages', (req, res) => {
    const category = req.query.category
    const filteredMessages = filterMessagesByCategory(category)
    res.json(filteredMessages)
  })



  app.get('/api/timezone', (req, res) => {
    res.json({ timezone: currentTimezone })
  })
  
  app.post('/api/timezone', (req, res) => {
    const { timezone } = req.body
    if (moment.tz.zone(timezone)) {
      currentTimezone = timezone
      setCurrentTimezone(timezone)
      res.json({ success: true, timezone: currentTimezone })
    } else {
      res.status(400).json({ error: 'Invalid timezone' })
    }
  })
  
  
app.get('/messages', (req, res) => {
  res.render('messages', {
    ingress_path: process.env.INGRESS_PATH || '',
    categoryOptions: generateCategoryOptions(inverterNumber, batteryNumber),
  })
})


app.get('/chart', (req, res) => {
  res.render('chart', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, // Include mqtt_host here
  })
})


app.get('/api/carbon-intensity/:zone', async (req, res) => {
  try {
    const { zone } = req.params;
    if (!zone) {
      return res.status(400).json({ error: 'Zone parameter is required' });
    }
    
    // Check if data is already cached
    const cacheKey = zone;
    if (carbonIntensityCacheByZone.has(cacheKey)) {
      const cachedData = carbonIntensityCacheByZone.get(cacheKey);
      if (Date.now() - cachedData.timestamp < CACHE_DURATION) {
        return res.json({ 
          data: cachedData.data,
          cached: true,
          cacheAge: Math.round((Date.now() - cachedData.timestamp) / 60000) + ' minutes'
        });
      }
    }
    
    // Otherwise return a status indicating data is being fetched
    res.json({ 
      status: 'fetching',
      message: 'Data is being fetched. Please try again in a moment.'
    });
    
    // Trigger a background fetch if not already in progress
    setTimeout(() => fetchCarbonIntensityHistory(zone), 0);
    
  } catch (error) {
    console.error('Error in carbon intensity API:', error);
    res.status(500).json({ error: 'Failed to fetch carbon intensity data' });
  }
});

app.get('/api/grid-voltage', async (req, res) => {
  try {
    const result = await influx.query(`
      SELECT last("value") AS "value"
      FROM "state"
      WHERE "topic" = '${mqttTopicPrefix}/total/grid_voltage/state'
    `)
    res.json({ voltage: result[0]?.value || 0 })
  } catch (error) {
    console.error('Error fetching grid voltage:', error)
    res.status(500).json({ error: 'Failed to fetch grid voltage' })
  }
})

// ================ CARBON INTENSITY ================

  // Cache for carbon intensity data
  const carbonIntensityCacheByZone = new Map();
  
  // Utility Functions
  async function getZones() {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
      
      if (!settings.apiKey) {
        return {
          success: false,
          error: 'API key not configured',
          zones: []
        };
      }
  
      const response = await axios.get('https://api.electricitymap.org/v3/zones', {
        headers: { 'auth-token': settings.apiKey },
        timeout: 10000
      });
  
      if (response.data.error) {
        return {
          success: false,
          error: response.data.error,
          zones: []
        };
      }
  
      const zones = Object.entries(response.data)
        .map(([key, value]) => ({
          code: key,
          zoneName: value.zoneName || key
        }))
        .sort((a, b) => a.zoneName.localeCompare(b.zoneName));
  
      return {
        success: true,
        zones
      };
    } catch (error) {
      const errorMessage = error.response?.status === 401 
        ? 'Invalid API key. Please check your Electricity Map API credentials.'
        : 'Error connecting to Electricity Map API. Please try again later.';
      
      console.error('Error fetching zones:', error.message);
      return {
        success: false,
        error: errorMessage,
        zones: []
      };
    }
  }


  async function fetchCarbonIntensityHistory(selectedZone) {
    if (!selectedZone) return [];
  
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    if (!settings.apiKey) {
      throw new Error('API key not configured');
    }
  
    // Check if we have a cached version for this zone
    const cacheKey = `${selectedZone}`;
    if (carbonIntensityCacheByZone.has(cacheKey)) {
      const cachedData = carbonIntensityCacheByZone.get(cacheKey);
      if (Date.now() - cachedData.timestamp < CACHE_DURATION) {
        console.log(`Using cached carbon intensity data for ${selectedZone}`);
        return cachedData.data;
      }
    }
  
    const historyData = [];
    const today = moment();
    const oneYearAgo = moment().subtract(1, 'year');
    
    // Increase batch size for fewer API calls
    const batchSize = 30; // Fetch a month at a time
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  
    console.time('Carbon intensity data fetch');
    console.log(`Fetching carbon intensity data for ${selectedZone}...`);
    
    for (let m = moment(oneYearAgo); m.isBefore(today); m.add(batchSize, 'days')) {
      const batchPromises = [];
      for (let i = 0; i < batchSize && m.clone().add(i, 'days').isBefore(today); i++) {
        const date = m.clone().add(i, 'days').format('YYYY-MM-DD');
        batchPromises.push(
          axios.get('https://api.electricitymap.org/v3/carbon-intensity/history', {
            params: { 
              zone: selectedZone,
              datetime: date
            },
            headers: { 'auth-token': settings.apiKey },
            timeout: 10000
          }).then(response => response.data)
            .catch(error => {
              console.error(`Error fetching data for ${date}:`, error.message);
              return { history: [] }; // Return empty history on error
            })
        );
      }
  
      try {
        // Process batches with some delay between them to avoid rate limiting
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach((data, index) => {
          if (data.history && data.history.length > 0) {
            historyData.push({
              date: m.clone().add(index, 'days').format('YYYY-MM-DD'),
              carbonIntensity: data.history[0].carbonIntensity
            });
          }
        });
        
        // Add a small delay between batches to avoid overwhelming the API
        if (m.clone().add(batchSize, 'days').isBefore(today)) {
          await delay(500);
        }
      } catch (error) {
        console.error('Error fetching batch data:', error);
      }
    }
  
    console.timeEnd('Carbon intensity data fetch');
  
    // Cache the entire year's data for this zone
    carbonIntensityCacheByZone.set(cacheKey, {
      data: historyData,
      timestamp: Date.now()
    });
    
    console.log(`Carbon intensity data for ${selectedZone}:`, historyData.length, 'days retrieved');
  
    if (historyData.length > 0) {
      console.log('Sample data (first 5 days):');
      console.log(JSON.stringify(historyData.slice(0, 5), null, 2));
    }
    
    return historyData;
  }


  // More efficient emissions calculation
function calculateEmissionsForPeriod(
    historyData,
    gridEnergyIn,
    pvEnergy,
    gridVoltage
  ) {
    if (!historyData || !historyData.length || !gridEnergyIn || !pvEnergy) {
      console.log("Missing required data arrays for emissions calculation");
      return [];
    }
  
    console.log(`History data length: ${historyData.length}, Grid data length: ${gridEnergyIn.length}, PV data length: ${pvEnergy.length}`);
    if (gridEnergyIn.length > 0) {
      console.log(`Grid energy sample: ${JSON.stringify(gridEnergyIn[0])}`);
    }
    if (pvEnergy.length > 0) {
      console.log(`PV energy sample: ${JSON.stringify(pvEnergy[0])}`);
    }
  
    return historyData.map((dayData, index) => {
      const carbonIntensity = dayData.carbonIntensity || 0;
      const currentGridVoltage = gridVoltage[index]?.value || 0;
  
      const historyDate = new Date(dayData.date).toISOString().split('T')[0];
  
      let gridEnergyForDay = null,
        pvEnergyForDay = null,
        previousGridEnergy = null,
        previousPvEnergy = null;
  
      gridEnergyIn.forEach((entry, i) => {
        const entryDate = new Date(entry.time).toISOString().split('T')[0];
        if (entryDate === historyDate) {
          gridEnergyForDay = entry.value;
          if (i > 0) previousGridEnergy = gridEnergyIn[i - 1].value;
        }
      });
  
      pvEnergy.forEach((entry, i) => {
        const entryDate = new Date(entry.time).toISOString().split('T')[0];
        if (entryDate === historyDate) {
          pvEnergyForDay = entry.value;
          if (i > 0) previousPvEnergy = pvEnergy[i - 1].value;
        }
      });
  
      if (gridEnergyForDay === null && index < gridEnergyIn.length) {
        gridEnergyForDay = gridEnergyIn[index]?.value || 0;
        previousGridEnergy = index > 0 ? gridEnergyIn[index - 1]?.value || 0 : null;
      }
  
      if (pvEnergyForDay === null && index < pvEnergy.length) {
        pvEnergyForDay = pvEnergy[index]?.value || 0;
        previousPvEnergy = index > 0 ? pvEnergy[index - 1]?.value || 0 : null;
      }
  
      let dailyGridEnergy = gridEnergyForDay;
      let dailyPvEnergy = pvEnergyForDay;
  
      // Apply your conditions
      if (
        previousGridEnergy !== null &&
        previousPvEnergy !== null &&
        gridEnergyForDay > previousGridEnergy &&
        pvEnergyForDay > previousPvEnergy
      ) {
        dailyGridEnergy = Math.max(0, gridEnergyForDay - previousGridEnergy);
        dailyPvEnergy = Math.max(0, pvEnergyForDay - previousPvEnergy);
      }
  
      const unavoidableEmissions = (dailyGridEnergy * carbonIntensity) / 1000;
      const avoidedEmissions = (dailyPvEnergy * carbonIntensity) / 1000;
      const totalEnergy = dailyGridEnergy + dailyPvEnergy;
      const selfSufficiencyScore = totalEnergy > 0 ? (dailyPvEnergy / totalEnergy) * 100 : 0;
  
      return {
        date: dayData.date,
        carbonIntensity: carbonIntensity,
        gridVoltage: currentGridVoltage,
        gridEnergy: dailyGridEnergy,
        solarEnergy: dailyPvEnergy,
        unavoidableEmissions: unavoidableEmissions,
        avoidedEmissions: avoidedEmissions,
        selfSufficiencyScore: selfSufficiencyScore,
      };
    });
  }


  // Function to prefetch data in the background after server start
  
  async function prefetchCarbonIntensityData() {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
      if (settings.selectedZone && settings.apiKey) {
        console.log(`Prefetching carbon intensity data for ${settings.selectedZone}...`);
        await fetchCarbonIntensityHistory(settings.selectedZone);
        console.log('Prefetching complete');
      }
    } catch (error) {
      console.error('Error prefetching carbon intensity data:', error);
    }
  }
  

// ================ FORWARDING MESSAGES TO OUR BACKEND ================

  // WebSocket Connection & MQTT Message Forwarding
  const connectToWebSocketBroker = async () => {
    let heartbeatInterval = null;
    const reconnectTimeout = 5000; // 5 seconds reconnection delay
  
    const startHeartbeat = (wsClient) => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      
      heartbeatInterval = setInterval(() => {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000); // Send ping every 30 seconds
    };
  
    const stopHeartbeat = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };
  
    const connect = async () => {
      try {
        const brokerServerUrl = `wss://broker.carbonoz.com:8000`;
        const wsClient = new WebSocket(brokerServerUrl);
  
        wsClient.on('open', async () => {
          console.log('Connected to WebSocket broker');
          
          try {
            const isUser = await AuthenticateUser(options);
            console.log('Authentication Result:', { isUser });
  
            if (isUser) {
              startHeartbeat(wsClient);
  
              // Move MQTT message forwarding outside of the WebSocket connection event
              mqttClient.on('message', (topic, message) => {
                if (wsClient.readyState === WebSocket.OPEN) {
                  try {
                    wsClient.send(
                      JSON.stringify({
                        mqttTopicPrefix,
                        topic,
                        message: message.toString(),
                        userId: isUser,
                        timestamp: new Date().toISOString()
                      })
                    );
          
                  } catch (sendError) {
                    console.error('Error sending message to WebSocket:', sendError);
                  }
                } else {
                  console.warn('WebSocket is not open. Cannot send message');
                }
              });
            } else {
              console.warn('Authentication failed. Message forwarding disabled.');
            }
          } catch (authError) {
            console.error('Authentication error:', authError);
          }
        });
  
        wsClient.on('error', (error) => {
          console.error('WebSocket Error:', error);
          stopHeartbeat();
          setTimeout(connect, reconnectTimeout);
        });
  
        wsClient.on('close', (code, reason) => {
          console.log(`WebSocket closed with code ${code}: ${reason}. Reconnecting...`);
          stopHeartbeat();
          setTimeout(connect, reconnectTimeout);
        });
  
      } catch (error) {
        console.error('Connection setup error:', error);
        setTimeout(connect, reconnectTimeout);
      }
    };
  
    connect();
  };
  


// ================ AUTOMATION RULES ENGINE ================

// Function to check if current time is within the specified time range
function isWithinTimeRange(startTime, endTime) {
  if (!startTime || !endTime) return true;
  
  // Use the current timezone for time calculations
  const currentTime = moment().tz(currentTimezone);
  const start = moment.tz(startTime, 'HH:mm', currentTimezone);
  const end = moment.tz(endTime, 'HH:mm', currentTimezone);
  
  // Handle cases where the time range spans midnight
  if (end.isBefore(start)) {
    // Return true if current time is after start OR before end
    return currentTime.isAfter(start) || currentTime.isBefore(end);
  }
  
  // Normal case: check if current time is between start and end
  return currentTime.isBetween(start, end);
}

// Function to check if current day is in the allowed days
function isAllowedDay(allowedDays) {
  if (!allowedDays || allowedDays.length === 0) return true;
  
  // Use the current timezone for day calculation
  const currentDay = moment().tz(currentTimezone).format('dddd').toLowerCase();
  return allowedDays.includes(currentDay);
}

// Function to evaluate a condition
function evaluateCondition(condition) {
  const { parameter, operator, value } = condition
  let currentValue
  
  // Get the current value based on parameter
  switch (parameter) {
    case 'battery_soc':
      currentValue = currentSystemState.battery_soc
      break
    case 'pv_power':
      currentValue = currentSystemState.pv_power
      break
    case 'load':
      currentValue = currentSystemState.load
      break
    case 'grid_voltage':
      currentValue = currentSystemState.grid_voltage
      break
    case 'grid_power':
      currentValue = currentSystemState.grid_power
      break
    default:
      return false
  }
  
  // If we don't have the value yet, return false
  if (currentValue === null || currentValue === undefined) {
    return false
  }
  
  // Evaluate the condition
  switch (operator) {
    case 'gt': // greater than
      return currentValue > value
    case 'lt': // less than
      return currentValue < value
    case 'eq': // equal to
      return currentValue === value
    case 'gte': // greater than or equal to
      return currentValue >= value
    case 'lte': // less than or equal to
      return currentValue <= value
    default:
      return false
  }
}

// Function to apply an action
function applyAction(action) {
  // Only allow sending commands when learner mode is active
  if (!learnerModeActive) {
    // Removed verbose log: console.warn('Cannot apply action: Learner mode is not active');
    return false;
  }

  const { setting, value, inverter } = action;
  let inverters = [];
  
  // Determine which inverters to apply the action to
  if (inverter === 'all') {
    // Apply to all inverters
    for (let i = 1; i <= inverterNumber; i++) {
      inverters.push(`inverter_${i}`);
    }
  } else {
    // Apply to a specific inverter
    inverters.push(inverter);
  }
  
  // Apply the action to each inverter
  inverters.forEach(inv => {
    let topic, mqttValue;
    
    // Construct the topic and value based on the setting
    switch (setting) {
      // Existing settings
      case 'grid_charge':
        topic = `${mqttTopicPrefix}/${inv}/grid_charge/set`;
        mqttValue = value;
        break;
      case 'energy_pattern':
        topic = `${mqttTopicPrefix}/${inv}/energy_pattern/set`;
        mqttValue = value;
        break;
      
      // Battery charging settings
      case 'max_discharge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_discharge_current/set`;
        mqttValue = value;
        break;
      case 'max_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_charge_current/set`;
        mqttValue = value;
        break;
      case 'max_grid_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_grid_charge_current/set`;
        mqttValue = value;
        break;
      case 'max_generator_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_generator_charge_current/set`;
        mqttValue = value;
        break;
      case 'battery_float_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_float_charge_voltage/set`;
        mqttValue = value;
        break;
      case 'battery_absorption_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_absorption_charge_voltage/set`;
        mqttValue = value;
        break;
      case 'battery_equalization_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_equalization_charge_voltage/set`;
        mqttValue = value;
        break;
        
      // Work mode settings
      case 'remote_switch':
        topic = `${mqttTopicPrefix}/${inv}/remote_switch/set`;
        mqttValue = value;
        break;
      case 'generator_charge':
        topic = `${mqttTopicPrefix}/${inv}/generator_charge/set`;
        mqttValue = value;
        break;
      case 'force_generator_on':
        topic = `${mqttTopicPrefix}/${inv}/force_generator_on/set`;
        mqttValue = value;
        break;
      case 'output_shutdown_voltage':
        topic = `${mqttTopicPrefix}/${inv}/output_shutdown_voltage/set`;
        mqttValue = value;
        break;
      case 'stop_battery_discharge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/stop_battery_discharge_voltage/set`;
        mqttValue = value;
        break;
      case 'start_battery_discharge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/start_battery_discharge_voltage/set`;
        mqttValue = value;
        break;
      case 'start_grid_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/start_grid_charge_voltage/set`;
        mqttValue = value;
        break;
        
      // Work mode detail settings
      case 'work_mode':
        topic = `${mqttTopicPrefix}/${inv}/work_mode/set`;
        mqttValue = value;
        break;
      case 'solar_export_when_battery_full':
        topic = `${mqttTopicPrefix}/${inv}/solar_export_when_battery_full/set`;
        mqttValue = value;
        break;
      case 'max_sell_power':
        topic = `${mqttTopicPrefix}/${inv}/max_sell_power/set`;
        mqttValue = value;
        break;
      case 'max_solar_power':
        topic = `${mqttTopicPrefix}/${inv}/max_solar_power/set`;
        mqttValue = value;
        break;
      case 'grid_trickle_feed':
        topic = `${mqttTopicPrefix}/${inv}/grid_trickle_feed/set`;
        mqttValue = value;
        break;
        
      // Voltage point settings (existing)
      case 'voltage_point_1':
      case 'voltage_point_2':
      case 'voltage_point_3':
      case 'voltage_point_4':
      case 'voltage_point_5':
      case 'voltage_point_6':
        topic = `${mqttTopicPrefix}/${inv}/${setting}/set`;
        mqttValue = value;
        break;
      default:
        console.warn(`Unknown setting: ${setting}`);
        return;
    }
    
    // Send the command via MQTT
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        }
        // Removed verbose log: else { console.log(`Command sent: ${topic} = ${mqttValue}`); }
      });
    }
  });
  
  return true;
}


// Function to process all rules
async function processRules() {
  if (!dbConnected) return;
  
  try {
    // Get all active rules for the current user
    const rules = await Rule.find({ 
      active: true,
      user_id: USER_ID // Filter by user ID
    });
    
    for (const rule of rules) {
      // Check time restrictions
      if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
        const { days, startTime, endTime, specificDates } = rule.timeRestrictions;
        
        // Check day of week restrictions
        if (days && days.length > 0) {
          const currentDay = moment().format('dddd').toLowerCase();
          if (!days.includes(currentDay)) {
            continue; // Skip this rule if not an allowed day
          }
        }
        
        // Check time range restrictions
        if (startTime && endTime) {
          if (!isWithinTimeRange(startTime, endTime)) {
            continue; // Skip this rule if outside time range
          }
        }
        
        // Check specific dates (if configured)
        if (specificDates && specificDates.length > 0) {
          const today = moment().format('YYYY-MM-DD');
          const isSpecialDate = specificDates.includes(today);
          
          // If specific dates are defined but today is not in the list, skip
          if (!isSpecialDate) {
            continue;
          }
        }
      }
      
      // Check if all conditions are met
      const allConditionsMet = rule.conditions.length === 0 || 
        rule.conditions.every(condition => evaluateCondition(condition));
      
      if (allConditionsMet) {
        // Removed verbose log: console.log(`Rule "${rule.name}" triggered: ${rule.description}`);
        
        // We always record the rule match, but only apply actions if learner mode is active
        if (learnerModeActive) {
          // Apply all actions
          rule.actions.forEach(action => {
            applyAction(action);
          });
        }
        
        // Always update rule statistics regardless of whether we applied the action
        rule.lastTriggered = new Date();
        rule.triggerCount += 1;
        await rule.save();
      }
    }
  } catch (error) {
    console.error('Error processing rules:', error);
  }
}

// Function to create a default set of rules if none exist
async function createDefaultRules() {
    if (!dbConnected) return
    
    try {
      // Check if this user already has rules
      const count = await Rule.countDocuments({ user_id: USER_ID })
      
      if (count === 0) {
        console.log('Creating default rules for user:', USER_ID)
        
        // Rule 1: If load is lower than 5000W, change energy pattern to battery first
        const rule1 = new Rule({
          name: 'Low Load Battery First',
          description: 'If load is lower than 5000W, change energy pattern to battery first',
          active: true,
          conditions: [{
            parameter: 'load',
            operator: 'lt',
            value: 5000
          }],
          actions: [{
            setting: 'energy_pattern',
            value: 'Battery first',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 2: If SOC is lower than 20%, turn Grid charge on
        const rule2 = new Rule({
          name: 'Low Battery Enable Grid Charge',
          description: 'If SOC is lower than 20%, turn Grid charge on',
          active: true,
          conditions: [{
            parameter: 'battery_soc',
            operator: 'lt',
            value: 20
          }],
          actions: [{
            setting: 'grid_charge',
            value: 'Enabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 3: Turn Grid charge off on weekends
        const rule3 = new Rule({
          name: 'Weekend Grid Charge Off',
          description: 'Turn Grid charge off every Saturday and Sunday',
          active: true,
          timeRestrictions: {
            days: ['saturday', 'sunday'],
            enabled: true
          },
          conditions: [],
          actions: [{
            setting: 'grid_charge',
            value: 'Disabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 4: Complex condition for grid charge
        const rule4 = new Rule({
          name: 'Smart Grid Charge Management',
          description: 'If SOC < 70% AND Load < 10000W AND PV > 8000W, turn Grid charge ON',
          active: true,
          conditions: [
            {
              parameter: 'battery_soc',
              operator: 'lt',
              value: 70
            },
            {
              parameter: 'load',
              operator: 'lt',
              value: 10000
            },
            {
              parameter: 'pv_power',
              operator: 'gt',
              value: 8000
            }
          ],
          actions: [{
            setting: 'grid_charge',
            value: 'Enabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 5: Emergency grid charge off
        const rule5 = new Rule({
          name: 'Emergency Grid Charge Off',
          description: 'If load > 13000W OR PV < 8000W, turn Grid charge OFF (9:00-17:00)',
          active: true,
          timeRestrictions: {
            startTime: '09:00',
            endTime: '17:00',
            enabled: true
          },
          conditions: [
            {
              parameter: 'load',
              operator: 'gt',
              value: 13000
            }
          ],
          actions: [{
            setting: 'grid_charge',
            value: 'Disabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Save all default rules
        await Promise.all([
          rule1.save(),
          rule2.save(),
          rule3.save(),
          rule4.save(),
          rule5.save()
        ])
        
        console.log('Default rules created for user:', USER_ID)
      }
    } catch (error) {
      console.error('Error creating default rules:', error.message)
    }
  }

  // Function to create extended set of automation rules
async function createExtendedAutomationRules() {
  if (!dbConnected) return;
  
  try {
    // Check if this user already has extended rules
    const count = await Rule.countDocuments({ 
      user_id: USER_ID,
      name: { $regex: 'Extended' } 
    });
    
    if (count === 0) {
      console.log('Creating extended automation rules for user:', USER_ID);
      
      // ===== Power Point Rules Based on Battery SOC =====
      const powerPointRule = new Rule({
        name: 'Extended - Power Point Rules by Battery SOC',
        description: 'Adjusts Power Point 2 based on battery state of charge ranges',
        active: true,
        conditions: [],  // No additional conditions - we'll use nested conditions in the rule logic
        actions: [],  // We'll define four separate rules instead of complex nested logic
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // Create separate rules for each SOC range for power point 2
      const powerPoint2Rule1 = new Rule({
        name: 'Power Point 2 - SOC 0-25%',
        description: 'Set Power Point 2 to 0W when battery SOC is 0-25%',
        active: true,
        conditions: [{
          parameter: 'battery_soc',
          operator: 'lte',
          value: 25
        }],
        actions: [{
          setting: 'voltage_point_2', // Using voltage_point for power points
          value: '0',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const powerPoint2Rule2 = new Rule({
        name: 'Power Point 2 - SOC 26-50%',
        description: 'Set Power Point 2 to 1000W when battery SOC is 26-50%',
        active: true,
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 25
          },
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 50
          }
        ],
        actions: [{
          setting: 'voltage_point_2',
          value: '1000',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const powerPoint2Rule3 = new Rule({
        name: 'Power Point 2 - SOC 51-70%',
        description: 'Set Power Point 2 to 1500W when battery SOC is 51-70%',
        active: true,
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 50
          },
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 70
          }
        ],
        actions: [{
          setting: 'voltage_point_2',
          value: '1500',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const powerPoint2Rule4 = new Rule({
        name: 'Power Point 2 - SOC 71-100%',
        description: 'Set Power Point 2 to 2000W when battery SOC is 71-100%',
        active: true,
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 70
          }
        ],
        actions: [{
          setting: 'voltage_point_2',
          value: '2000',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Morning Energy Pattern Rules (00:05 to 12:00) =====
      const morningEnergyPatternLowSoc = new Rule({
        name: 'Extended - Morning Energy Pattern (Low SOC)',
        description: 'Set energy pattern to Battery First from 00:05-12:00 when SOC is 0-35%',
        active: true,
        timeRestrictions: {
          startTime: '00:05',
          endTime: '12:00',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 35
          }
        ],
        actions: [{
          setting: 'energy_pattern',
          value: 'Battery first',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const morningEnergyPatternHighSoc = new Rule({
        name: 'Extended - Morning Energy Pattern (High SOC)',
        description: 'Set energy pattern to Load First from 00:05-12:00 when SOC is 41-100%',
        active: true,
        timeRestrictions: {
          startTime: '00:05',
          endTime: '12:00',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gte',
            value: 41
          }
        ],
        actions: [{
          setting: 'energy_pattern',
          value: 'Load first',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Afternoon Energy Pattern Rules (12:00 to 17:00) =====
      const afternoonEnergyPatternLowSoc = new Rule({
        name: 'Extended - Afternoon Energy Pattern (Low SOC)',
        description: 'Set energy pattern to Battery First from 12:00-17:00 when SOC is 0-79%',
        active: true,
        timeRestrictions: {
          startTime: '12:00',
          endTime: '17:00',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lt',
            value: 80
          }
        ],
        actions: [{
          setting: 'energy_pattern',
          value: 'Battery first',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const afternoonEnergyPatternHighSoc = new Rule({
        name: 'Extended - Afternoon Energy Pattern (High SOC)',
        description: 'Set energy pattern to Load First from 12:00-17:00 when SOC is 80-100%',
        active: true,
        timeRestrictions: {
          startTime: '12:00',
          endTime: '17:00',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gte',
            value: 80
          }
        ],
        actions: [{
          setting: 'energy_pattern',
          value: 'Load first',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Evening Energy Pattern Rules (17:01 to 23:55) =====
      const eveningEnergyPatternLowSoc = new Rule({
        name: 'Extended - Evening Energy Pattern (Low SOC)',
        description: 'Set energy pattern to Battery First from 17:01-23:55 when SOC is 1-40%',
        active: true,
        timeRestrictions: {
          startTime: '17:01',
          endTime: '23:55',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 40
          },
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 0
          }
        ],
        actions: [{
          setting: 'energy_pattern',
          value: 'Battery first',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const eveningEnergyPatternHighSoc = new Rule({
        name: 'Extended - Evening Energy Pattern (High SOC)',
        description: 'Set energy pattern to Load First from 17:01-23:55 when SOC is 41-100%',
        active: true,
        timeRestrictions: {
          startTime: '17:01',
          endTime: '23:55',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gte',
            value: 41
          }
        ],
        actions: [{
          setting: 'energy_pattern',
          value: 'Load first',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Afternoon Grid Charge Point 1 Rules (13:00 to 17:00) =====
      const afternoonGridChargePoint1LowSoc = new Rule({
        name: 'Extended - Afternoon Grid Charge Point 1 (Low SOC)',
        description: 'Enable Grid Charge Point 1 from 13:00-17:00 when SOC is 0-80%',
        active: true,
        timeRestrictions: {
          startTime: '13:00',
          endTime: '17:00',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 80
          }
        ],
        actions: [{
          setting: 'grid_charge', // Replace with the correct setting for grid charge point 1
          value: 'Enabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const afternoonGridChargePoint1HighSoc = new Rule({
        name: 'Extended - Afternoon Grid Charge Point 1 (High SOC)',
        description: 'Disable Grid Charge Point 1 from 13:00-17:00 when SOC is 81-100%',
        active: true,
        timeRestrictions: {
          startTime: '13:00',
          endTime: '17:00',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 80
          }
        ],
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Evening Grid Charge Point 1 Rules (17:01 to 23:55) =====
      const eveningGridChargePoint1LowSoc = new Rule({
        name: 'Extended - Evening Grid Charge Point 1 (Low SOC)',
        description: 'Enable Grid Charge Point 1 from 17:01-23:55 when SOC is 0-80%',
        active: true,
        timeRestrictions: {
          startTime: '17:01',
          endTime: '23:55',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 80
          }
        ],
        actions: [{
          setting: 'grid_charge',
          value: 'Enabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const eveningGridChargePoint1HighSoc = new Rule({
        name: 'Extended - Evening Grid Charge Point 1 (High SOC)',
        description: 'Disable Grid Charge Point 1 from 17:01-23:55 when SOC is 81-100%',
        active: true,
        timeRestrictions: {
          startTime: '17:01',
          endTime: '23:55',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 80
          }
        ],
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Early Morning Grid Charge Point 2 Rules (00:05 to 08:55) =====
      const earlyMorningGridChargePoint2LowSoc = new Rule({
        name: 'Extended - Early Morning Grid Charge Point 2 (Low SOC)',
        description: 'Enable Grid Charge Point 2 from 00:05-08:55 when SOC is 0-40%',
        active: true,
        timeRestrictions: {
          startTime: '00:05',
          endTime: '08:55',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lte',
            value: 40
          }
        ],
        actions: [{
          setting: 'voltage_point_1', // Using voltage_point_1 for grid charge point 2
          value: '1',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const earlyMorningGridChargePoint2HighSoc = new Rule({
        name: 'Extended - Early Morning Grid Charge Point 2 (High SOC)',
        description: 'Disable Grid Charge Point 2 from 00:05-08:55 when SOC is 41-100%',
        active: true,
        timeRestrictions: {
          startTime: '00:05',
          endTime: '08:55',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gt',
            value: 40
          }
        ],
        actions: [{
          setting: 'voltage_point_1',
          value: '0',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Morning Grid Charge Point 2 Rules (09:00 to 12:59) =====
      const morningGridChargePoint2LowSoc = new Rule({
        name: 'Extended - Morning Grid Charge Point 2 (Low SOC)',
        description: 'Enable Grid Charge Point 2 from 09:00-12:59 when SOC is 0-74%',
        active: true,
        timeRestrictions: {
          startTime: '09:00',
          endTime: '12:59',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lt',
            value: 75
          }
        ],
        actions: [{
          setting: 'voltage_point_1',
          value: '1',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      const morningGridChargePoint2HighSoc = new Rule({
        name: 'Extended - Morning Grid Charge Point 2 (High SOC)',
        description: 'Disable Grid Charge Point 2 from 09:00-12:59 when SOC is 75-100%',
        active: true,
        timeRestrictions: {
          startTime: '09:00',
          endTime: '12:59',
          enabled: true
        },
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gte',
            value: 75
          }
        ],
        actions: [{
          setting: 'voltage_point_1',
          value: '0',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // ===== Timer Disabling Rule =====
      const disableTimerEarlyMorning = new Rule({
        name: 'Extended - Disable Timer Early Morning',
        description: 'Disable Use Timer from 00:00 to 06:00',
        active: true,
        timeRestrictions: {
          startTime: '00:00',
          endTime: '06:00',
          enabled: true
        },
        conditions: [],
        actions: [{
          setting: 'work_mode_timer',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // Save all the extended rules
      await Promise.all([
        powerPoint2Rule1.save(),
        powerPoint2Rule2.save(),
        powerPoint2Rule3.save(),
        powerPoint2Rule4.save(),
        morningEnergyPatternLowSoc.save(),
        morningEnergyPatternHighSoc.save(),
        afternoonEnergyPatternLowSoc.save(),
        afternoonEnergyPatternHighSoc.save(),
        eveningEnergyPatternLowSoc.save(),
        eveningEnergyPatternHighSoc.save(),
        afternoonGridChargePoint1LowSoc.save(),
        afternoonGridChargePoint1HighSoc.save(),
        eveningGridChargePoint1LowSoc.save(),
        eveningGridChargePoint1HighSoc.save(),
        earlyMorningGridChargePoint2LowSoc.save(),
        earlyMorningGridChargePoint2HighSoc.save(),
        morningGridChargePoint2LowSoc.save(),
        morningGridChargePoint2HighSoc.save(),
        disableTimerEarlyMorning.save()
      ]);
      
      console.log(`Extended automation rules created for user: ${USER_ID}`);
    }
  } catch (error) {
    console.error('Error creating extended automation rules:', error.message);
  }
}


// ================ NIGHT CHARGING RULES ================

// Create a rule for night charging to 95% SOC
async function createNightChargingRule() {
  if (!dbConnected) return;
  
  try {
    // Check if the rule already exists
    const existingRule = await Rule.findOne({
      name: 'Night Battery Charging to 95%',
      user_id: USER_ID
    });
    
    if (existingRule) {
      console.log('Night charging rule already exists, updating it...');
      
      // Update the existing rule
      existingRule.description = 'Charges the battery at night (11PM to 6AM) to 95% SOC using Berlin timezone';
      existingRule.active = true;
      existingRule.conditions = [
        {
          parameter: 'battery_soc',
          operator: 'lt',
          value: 95
        }
      ];
      existingRule.timeRestrictions = {
        startTime: '23:00',
        endTime: '06:00',
        enabled: true,
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] // Every day
      };
      existingRule.actions = [
        {
          setting: 'grid_charge',
          value: 'Enabled',
          inverter: 'all'
        }
      ];
      
      await existingRule.save();
      console.log('Night charging rule updated successfully');
    } else {
      // Create a new rule
      const nightChargingRule = new Rule({
        name: 'Night Battery Charging to 95%',
        description: 'Charges the battery at night (11PM to 6AM) to 95% SOC using Berlin timezone',
        active: true,
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'lt',
            value: 95
          }
        ],
        timeRestrictions: {
          startTime: '23:00',
          endTime: '06:00',
          enabled: true,
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] // Every day
        },
        actions: [
          {
            setting: 'grid_charge',
            value: 'Enabled',
            inverter: 'all'
          }
        ],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await nightChargingRule.save();
      console.log('Night charging rule created successfully');
    }
    
    // Create a complementary rule to turn OFF grid charging after 6AM
    const existingComplementaryRule = await Rule.findOne({
      name: 'Disable Grid Charging After 6AM',
      user_id: USER_ID
    });
    
    if (existingComplementaryRule) {
      console.log('Complementary rule already exists, updating it...');
      
      // Update the existing rule
      existingComplementaryRule.description = 'Disables grid charging after 6AM until 11PM (daytime)';
      existingComplementaryRule.active = true;
      existingComplementaryRule.conditions = []; // No condition on battery SOC for this rule
      existingComplementaryRule.timeRestrictions = {
        startTime: '06:01',
        endTime: '22:59',
        enabled: true,
        days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] // Every day
      };
      existingComplementaryRule.actions = [
        {
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }
      ];
      
      await existingComplementaryRule.save();
      console.log('Complementary rule updated successfully');
    } else {
      // Create the complementary rule
      const complementaryRule = new Rule({
        name: 'Disable Grid Charging After 6AM',
        description: 'Disables grid charging after 6AM until 11PM (daytime)',
        active: true,
        conditions: [], // No condition on battery SOC for this rule
        timeRestrictions: {
          startTime: '06:01',
          endTime: '22:59',
          enabled: true,
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] // Every day
        },
        actions: [
          {
            setting: 'grid_charge',
            value: 'Disabled',
            inverter: 'all'
          }
        ],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await complementaryRule.save();
      console.log('Complementary rule created successfully');
    }
    
    // Create an emergency SOC 95%+ rule to ensure grid charging is disabled when battery is full
    const existingEmergencyRule = await Rule.findOne({
      name: 'Disable Grid Charging When Battery Full',
      user_id: USER_ID
    });
    
    if (existingEmergencyRule) {
      console.log('Emergency rule already exists, updating it...');
      
      // Update the existing rule
      existingEmergencyRule.description = 'Disables grid charging when battery SOC reaches 95% or higher';
      existingEmergencyRule.active = true;
      existingEmergencyRule.conditions = [
        {
          parameter: 'battery_soc',
          operator: 'gte',
          value: 95
        }
      ];
      existingEmergencyRule.timeRestrictions = {
        enabled: false // This rule applies at all times
      };
      existingEmergencyRule.actions = [
        {
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }
      ];
      
      await existingEmergencyRule.save();
      console.log('Emergency rule updated successfully');
    } else {
      // Create the emergency rule
      const emergencyRule = new Rule({
        name: 'Disable Grid Charging When Battery Full',
        description: 'Disables grid charging when battery SOC reaches 95% or higher',
        active: true,
        conditions: [
          {
            parameter: 'battery_soc',
            operator: 'gte',
            value: 95
          }
        ],
        timeRestrictions: {
          enabled: false // This rule applies at all times
        },
        actions: [
          {
            setting: 'grid_charge',
            value: 'Disabled',
            inverter: 'all'
          }
        ],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await emergencyRule.save();
      console.log('Emergency rule created successfully');
    }
    
    return true;
  } catch (error) {
    console.error('Error creating night charging rules:', error.message);
    return false;
  }
}

// ================ API ROUTES ================

// API Routes with database integration

app.get('/api/energy-pattern-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const energyPatternChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'energy_pattern' } },
          { change_type: 'energy_pattern' }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 })
      
      res.json(energyPatternChanges)
    } catch (error) {
      console.error('Error retrieving energy pattern changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

// === Add API endpoints for retrieving battery charging settings changes ===
app.get('/api/battery-charging-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const batteryChargingChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'max_discharge_current|max_charge_current|max_grid_charge_current|max_generator_charge_current|battery_float_charge_voltage|battery_absorption_charge_voltage|battery_equalization_charge_voltage' } },
          { change_type: { $in: [
            'max_discharge_current', 
            'max_charge_current', 
            'max_grid_charge_current', 
            'max_generator_charge_current', 
            'battery_float_charge_voltage', 
            'battery_absorption_charge_voltage', 
            'battery_equalization_charge_voltage'
          ] } }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 })
      
      res.json(batteryChargingChanges)
    } catch (error) {
      console.error('Error retrieving battery charging changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

// === Add API endpoints for retrieving work mode settings changes ===
app.get('/api/work-mode-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const workModeChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'remote_switch|generator_charge|force_generator_on|output_shutdown_voltage|stop_battery_discharge_voltage|start_battery_discharge_voltage|start_grid_charge_voltage|work_mode|solar_export_when_battery_full|max_sell_power|max_solar_power|grid_trickle_feed' } },
          { change_type: { $in: [
            'remote_switch', 
            'generator_charge', 
            'force_generator_on', 
            'output_shutdown_voltage', 
            'stop_battery_discharge_voltage', 
            'start_battery_discharge_voltage', 
            'start_grid_charge_voltage',
            'work_mode',
            'solar_export_when_battery_full',
            'max_sell_power',
            'max_solar_power',
            'grid_trickle_feed'
          ] } }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 })
      
      res.json(workModeChanges)
    } catch (error) {
      console.error('Error retrieving work mode changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

// === Add routes for viewing battery charging and work mode settings ===
app.get('/battery-charging', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      changesCount = await SettingsChange.countDocuments({ 
        $or: [
          { topic: { $regex: 'max_discharge_current|max_charge_current|max_grid_charge_current|max_generator_charge_current|battery_float_charge_voltage|battery_absorption_charge_voltage|battery_equalization_charge_voltage' } },
          { change_type: { $in: [
            'max_discharge_current', 
            'max_charge_current', 
            'max_grid_charge_current', 
            'max_generator_charge_current', 
            'battery_float_charge_voltage', 
            'battery_absorption_charge_voltage', 
            'battery_equalization_charge_voltage'
          ] } }
        ]
      })
    }
    
    res.render('battery-charging', { 
      active: learnerModeActive,
      changes_count: changesCount,
      ingress_path: process.env.INGRESS_PATH || '',
      db_connected: dbConnected
    })
  } catch (error) {
    console.error('Error rendering battery-charging page:', error)
    res.status(500).send('Error loading page data')
  }
})

// Update the battery charging settings API
app.post('/api/battery-charging/set', (req, res) => {
  try {
    // Check if learner mode is active
    if (!learnerModeActive) {
      return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' })
    }
    
    const { inverter, setting, value } = req.body
    
    if (!inverter || !setting || value === undefined) {
      return res.status(400).json({ error: 'Missing inverter, setting, or value' })
    }
    
    if (!mqttClient || !mqttClient.connected) {
      return res.status(503).json({ error: 'MQTT client not connected' })
    }
    
    // Validate settings that are allowed to be changed
    const allowedSettings = [
      'max_discharge_current',
      'max_charge_current',
      'max_grid_charge_current',
      'max_generator_charge_current',
      'battery_float_charge_voltage',
      'battery_absorption_charge_voltage',
      'battery_equalization_charge_voltage'
    ]
    
    if (!allowedSettings.includes(setting)) {
      return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` })
    }
    
    // Validate inverter ID
    const inverterID = inverter.replace('inverter_', '')
    if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
      return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` })
    }
    
    // Validate value ranges based on the setting type
    let isValid = true
    let validationError = ''
    
    switch (setting) {
      case 'max_discharge_current':
      case 'max_charge_current':
      case 'max_grid_charge_current':
      case 'max_generator_charge_current':
        // Current values are typically between 0-100A
        if (parseFloat(value) < 0 || parseFloat(value) > 100) {
          isValid = false
          validationError = `${setting} must be between 0 and 100 A`
        }
        break
      case 'battery_float_charge_voltage':
      case 'battery_absorption_charge_voltage':
      case 'battery_equalization_charge_voltage':
        // Voltage values are typically between 40-60V for 48V systems
        if (parseFloat(value) < 40 || parseFloat(value) > 60) {
          isValid = false
          validationError = `${setting} must be between 40 and 60 V`
        }
        break
    }
    
    if (!isValid) {
      return res.status(400).json({ error: validationError })
    }
    
    // Construct MQTT topic
    const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`
    
    // Publish to MQTT
    mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}: ${err.message}`)
        return res.status(500).json({ error: err.message })
      }
      
      console.log(`Battery Charging command sent: ${topic} = ${value}`)
      res.json({ success: true, message: `Command sent: ${topic} = ${value}` })
    })
  } catch (error) {
    console.error('Error sending battery charging command:', error)
    res.status(500).json({ error: error.message })
  }
})

// === Add routes for viewing battery charging and work mode settings ===
app.get('/battery-charging', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'max_discharge_current|max_charge_current|max_grid_charge_current|max_generator_charge_current|battery_float_charge_voltage|battery_absorption_charge_voltage|battery_equalization_charge_voltage' } },
            { change_type: { $in: [
              'max_discharge_current', 
              'max_charge_current', 
              'max_grid_charge_current', 
              'max_generator_charge_current', 
              'battery_float_charge_voltage', 
              'battery_absorption_charge_voltage', 
              'battery_equalization_charge_voltage'
            ] } }
          ],
          user_id: USER_ID // Filter by user ID
        })
      }
      
      res.render('battery-charging', { 
        active: learnerModeActive,
        changes_count: changesCount,
        ingress_path: process.env.INGRESS_PATH || '',
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering battery-charging page:', error)
      res.status(500).send('Error loading page data')
    }
  })

// 3. Add API endpoint for getting current battery charging and work mode settings
app.get('/api/current-settings', async (req, res) => {
  try {
    // Create an object to hold current settings
    const currentSettings = {
      battery_charging: {},
      work_mode: {}
    }
    
    // Filter the previousSettings object to get battery charging settings
    for (const topic in previousSettings) {
      if (topic.includes('max_discharge_current') || 
          topic.includes('max_charge_current') || 
          topic.includes('max_grid_charge_current') || 
          topic.includes('max_generator_charge_current') || 
          topic.includes('battery_float_charge_voltage') || 
          topic.includes('battery_absorption_charge_voltage') || 
          topic.includes('battery_equalization_charge_voltage')) {
        
        // Extract the setting name from the topic
        const settingName = topic.split('/').pop()
        currentSettings.battery_charging[settingName] = previousSettings[topic]
      }
      
      // Filter for work mode settings
      if (topic.includes('remote_switch') || 
          topic.includes('generator_charge') || 
          topic.includes('force_generator_on') || 
          topic.includes('output_shutdown_voltage') || 
          topic.includes('stop_battery_discharge_voltage') || 
          topic.includes('start_battery_discharge_voltage') || 
          topic.includes('start_grid_charge_voltage') || 
          topic.includes('work_mode') || 
          topic.includes('solar_export_when_battery_full') || 
          topic.includes('max_sell_power') || 
          topic.includes('max_solar_power') || 
          topic.includes('grid_trickle_feed')) {
        
        const settingName = topic.split('/').pop()
        currentSettings.work_mode[settingName] = previousSettings[topic]
      }
    }
    
    res.json({
      success: true,
      currentSettings,
      inverterCount: inverterNumber,
      batteryCount: batteryNumber
    })
  } catch (error) {
    console.error('Error retrieving current settings:', error)
    res.status(500).json({ error: 'Failed to retrieve current settings' })
  }
})


// Fix API endpoints for manually changing work mode settings from UI
app.post('/api/work-mode/set', (req, res) => {
  try {
    // Check if learner mode is active
    if (!learnerModeActive) {
      return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' })
    }
    
    const { inverter, setting, value } = req.body
    
    if (!inverter || !setting || value === undefined) {
      return res.status(400).json({ error: 'Missing inverter, setting, or value' })
    }
    
    if (!mqttClient || !mqttClient.connected) {
      return res.status(503).json({ error: 'MQTT client not connected' })
    }
    
    // Validate settings that are allowed to be changed
    const allowedSettings = [
      'remote_switch',
      'generator_charge',
      'force_generator_on',
      'output_shutdown_voltage',
      'stop_battery_discharge_voltage',
      'start_battery_discharge_voltage',
      'start_grid_charge_voltage',
      'work_mode',
      'solar_export_when_battery_full',
      'max_sell_power',
      'max_solar_power',
      'grid_trickle_feed'
    ]
    
    if (!allowedSettings.includes(setting)) {
      return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` })
    }
    
    // Validate inverter ID
    const inverterID = inverter.replace('inverter_', '')
    if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
      return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` })
    }
    
    // Validate value based on setting type
    let isValid = true
    let validationError = ''
    
    switch (setting) {
      case 'remote_switch':
      case 'generator_charge':
      case 'force_generator_on':
      case 'solar_export_when_battery_full':
        // Boolean settings
        if (value !== 'Enabled' && value !== 'Disabled' && value !== 'true' && value !== 'false' && value !== '1' && value !== '0') {
          isValid = false
          validationError = `${setting} must be one of: Enabled, Disabled, true, false, 1, 0`
        }
        break
      case 'work_mode':
        // Enumeration settings
        const validWorkModes = ['Battery first', 'Grid first', 'Solar first', 'Solar + Battery', 'Solar + Grid']
        if (!validWorkModes.includes(value)) {
          isValid = false
          validationError = `${setting} must be one of: ${validWorkModes.join(', ')}`
        }
        break
      case 'output_shutdown_voltage':
      case 'stop_battery_discharge_voltage':
      case 'start_battery_discharge_voltage':
      case 'start_grid_charge_voltage':
        // Voltage values typically between 40-60V for 48V systems
        if (parseFloat(value) < 40 || parseFloat(value) > 60) {
          isValid = false
          validationError = `${setting} must be between 40 and 60 V`
        }
        break
      case 'max_sell_power':
      case 'max_solar_power':
        // Power values in Watts, typical range 0-15000W
        if (parseFloat(value) < 0 || parseFloat(value) > 15000) {
          isValid = false
          validationError = `${setting} must be between 0 and 15000 W`
        }
        break
      case 'grid_trickle_feed':
        // Typically a percentage or small value
        if (parseFloat(value) < 0 || parseFloat(value) > 100) {
          isValid = false
          validationError = `${setting} must be between 0 and 100`
        }
        break
    }
    
    if (!isValid) {
      return res.status(400).json({ error: validationError })
    }
    
    // Construct MQTT topic
    const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`
    
    // Publish to MQTT
    mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}: ${err.message}`)
        return res.status(500).json({ error: err.message })
      }
      
      console.log(`Work Mode command sent: ${topic} = ${value}`)
      res.json({ success: true, message: `Command sent: ${topic} = ${value}` })
    })
  } catch (error) {
    console.error('Error sending work mode command:', error)
    res.status(500).json({ error: error.message })
  }
})


// 5. Add API endpoint for retrieving setting history to create charts/graphs in UI
app.get('/api/settings-history/:setting', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const setting = req.params.setting
      const days = parseInt(req.query.days) || 7 // Default to 7 days
      
      // Calculate date threshold (e.g., past 7 days)
      const dateThreshold = new Date()
      dateThreshold.setDate(dateThreshold.getDate() - days)
      
      // Find all changes for this setting
      const changes = await SettingsChange.find({
        $or: [
          { topic: { $regex: setting } },
          { change_type: setting }
        ],
        timestamp: { $gte: dateThreshold },
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: 1 })
      
      // Format data for charting (timestamp + value pairs)
      const formattedData = changes.map(change => ({
        timestamp: change.timestamp,
        value: change.new_value,
        old_value: change.old_value,
        system_state: change.system_state
      }))
      
      res.json({
        success: true,
        setting,
        data: formattedData,
        count: formattedData.length
      })
    } catch (error) {
      console.error(`Error retrieving ${req.params.setting} history:`, error)
      res.status(500).json({ error: 'Failed to retrieve setting history' })
    }
  })


  app.get('/work-mode', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'remote_switch|generator_charge|force_generator_on|output_shutdown_voltage|stop_battery_discharge_voltage|start_battery_discharge_voltage|start_grid_charge_voltage|work_mode|solar_export_when_battery_full|max_sell_power|max_solar_power|grid_trickle_feed' } },
            { change_type: { $in: [
              'remote_switch', 
              'generator_charge', 
              'force_generator_on', 
              'output_shutdown_voltage', 
              'stop_battery_discharge_voltage', 
              'start_battery_discharge_voltage', 
              'start_grid_charge_voltage',
              'work_mode',
              'solar_export_when_battery_full',
              'max_sell_power',
              'max_solar_power',
              'grid_trickle_feed'
            ] } }
          ],
          user_id: USER_ID // Filter by user ID
        })
      }
      
      res.render('work-mode', { 
        active: learnerModeActive,
        changes_count: changesCount,
        ingress_path: process.env.INGRESS_PATH || '',
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering work-mode page:', error)
      res.status(500).send('Error loading page data')
    }
  })


// New API endpoint for voltage point changes
app.get('/api/voltage-point-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const voltagePointChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'voltage_point' } },
          { change_type: 'voltage_point' }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 });
      
      res.json(voltagePointChanges);
    } catch (error) {
      console.error('Error retrieving voltage point changes:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });

  app.get('/grid-charge', async (req, res) => {
    try {
      let changesCount = 0;
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'grid_charge' } },
            { change_type: 'grid_charge' }
          ],
          user_id: USER_ID // Filter by user ID
        });
      }
      
      res.render('grid-charge', { 
        active: learnerModeActive,
        changes_count: changesCount,
        ingress_path: process.env.INGRESS_PATH || '',
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering grid-charge page:', error);
      res.status(500).send('Error loading page data');
    }
  });

app.get('/api/grid-charge-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    // Get all changes related to grid charge, including:
    // - Basic grid_charge setting
    // - max_grid_charge_current
    // - grid_charge_point_X settings
    const gridChargeChanges = await SettingsChange.find({ 
      $or: [
        { topic: { $regex: 'grid_charge' } },
        { change_type: { $in: ['grid_charge', 'max_grid_charge_current'] } }
      ],
      user_id: USER_ID // Filter by user ID
    }).sort({ timestamp: -1 });
    
    res.json(gridChargeChanges);
  } catch (error) {
    console.error('Error retrieving grid charge changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

app.get('/energy-pattern', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'energy_pattern' } },
            { change_type: 'energy_pattern' }
          ],
          user_id: USER_ID // Filter by user ID
        })
      }
      
      res.render('energy-pattern', { 
        active: learnerModeActive,
        changes_count: changesCount,
        ingress_path: process.env.INGRESS_PATH || '',
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering energy-pattern page:', error)
      res.status(500).send('Error loading page data')
    }
  })

// New route for voltage point view
app.get('/voltage-point', async (req, res) => {
    try {
      let changesCount = 0;
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'voltage_point' } },
            { change_type: 'voltage_point' }
          ],
          user_id: USER_ID // Filter by user ID
        });
      }
      
      res.render('voltage-point', { 
        active: learnerModeActive,
        changes_count: changesCount,
        ingress_path: process.env.INGRESS_PATH || '',
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering voltage-point page:', error);
      res.status(500).send('Error loading page data');
    }
  });

  app.get('/wizard', async (req, res) => {
    try {
      // Check if editing an existing rule (optional)
      const ruleId = req.query.edit;
      let rule = null;
      
      if (ruleId && dbConnected) {
        // Find rule by ID and user ID to ensure it belongs to this user
        rule = await Rule.findOne({
          _id: ruleId,
          user_id: USER_ID
        });
      }
      
      // Get current system state for reference
      const systemState = { ...currentSystemState };
      
      // Get the number of inverters from config
      const numInverters = inverterNumber || 1;
      
      res.render('wizard', { 
        rule,
        systemState,
        numInverters,
        ingress_path: process.env.INGRESS_PATH || '',
        editMode: !!ruleId,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering wizard page:', error);
      res.status(500).send('Error loading wizard page');
    }
  });

// ================ RULES MANAGEMENT API ================

// Get all rules
app.post('/api/rules', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Validate the request body
      const { name, description, active, conditions, timeRestrictions, actions } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'Rule name is required' });
      }
      
      if (!actions || actions.length === 0) {
        return res.status(400).json({ error: 'At least one action is required' });
      }
      
      // Handle specific dates if present
      let processedTimeRestrictions = { ...timeRestrictions };
      
      // Create the rule with user identification
      const rule = new Rule({
        name,
        description,
        active: active !== undefined ? active : true,
        conditions: conditions || [],
        timeRestrictions: processedTimeRestrictions,
        actions,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await rule.save();
      
      // Log the creation
      console.log(`Rule "${name}" created successfully`);
      
      res.status(201).json(rule);
    } catch (error) {
      console.error('Error creating rule:', error);
      res.status(400).json({ error: error.message });
    }
  });

// Get a specific rule
app.put('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const { name, description, active, conditions, timeRestrictions, actions } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'Rule name is required' });
      }
      
      if (!actions || actions.length === 0) {
        return res.status(400).json({ error: 'At least one action is required' });
      }
      
      // Find the rule filtered by both ID and user_id to ensure it belongs to this user
      const rule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      // Update the rule
      rule.name = name;
      rule.description = description;
      rule.active = active !== undefined ? active : true;
      rule.conditions = conditions || [];
      rule.timeRestrictions = timeRestrictions;
      rule.actions = actions;
      // Keep the user identification unchanged
      
      await rule.save();
      
      console.log(`Rule "${name}" updated successfully`);
      
      res.json(rule);
    } catch (error) {
      console.error('Error updating rule:', error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/rules/:id/duplicate', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Find the original rule filtered by both ID and user_id
      const originalRule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!originalRule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      // Create a new rule based on the original
      const newRule = new Rule({
        name: `Copy of ${originalRule.name}`,
        description: originalRule.description,
        active: originalRule.active,
        conditions: originalRule.conditions,
        timeRestrictions: originalRule.timeRestrictions,
        actions: originalRule.actions,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await newRule.save();
      
      console.log(`Rule "${originalRule.name}" duplicated as "${newRule.name}"`);
      
      res.status(201).json(newRule);
    } catch (error) {
      console.error('Error duplicating rule:', error);
      res.status(400).json({ error: error.message });
    }
  });

// Add this route to display rule history
app.get('/rule-history', async (req, res) => {
    try {
      let ruleHistory = [];
      let systemState = { ...currentSystemState };
      
      if (dbConnected) {
        // Get all rules with their trigger history for this user
        ruleHistory = await Rule.find({
          lastTriggered: { $exists: true, $ne: null },
          user_id: USER_ID
        }).sort({ lastTriggered: -1 });
      }
      
      res.render('rule-history', {
        ruleHistory,
        db_connected: dbConnected,
        ingress_path: process.env.INGRESS_PATH || '',
        system_state: systemState,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering rule history page:', error);
      res.status(500).send('Error loading rule history page');
    }
  });

// API route to get rule execution history
app.get('/api/rules/history', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const limit = parseInt(req.query.limit) || 50;
      const skip = parseInt(req.query.skip) || 0;
      const sortBy = req.query.sortBy || 'lastTriggered';
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
      
      // Build sort options
      const sort = {};
      sort[sortBy] = sortOrder;
      
      // Get rules that have been triggered for the current user
      const ruleHistory = await Rule.find({
        lastTriggered: { $exists: true, $ne: null },
        user_id: USER_ID
      })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select('name description lastTriggered triggerCount conditions actions timeRestrictions');
      
      // Get total count for pagination
      const totalCount = await Rule.countDocuments({
        lastTriggered: { $exists: true, $ne: null },
        user_id: USER_ID
      });
      
      res.json({
        rules: ruleHistory,
        pagination: {
          total: totalCount,
          limit,
          skip,
          hasMore: skip + limit < totalCount
        }
      });
    } catch (error) {
      console.error('Error fetching rule history:', error);
      res.status(500).json({ error: 'Failed to retrieve rule history' });
    }
  });


  app.get('/api/rules/statistics', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ 
          totalRules: 0,
          totalExecutions: 0,
          last24Hours: 0,
          mostActiveRule: 'None'
        });
      }
      
      // Get total rules count for the current user
      const totalRules = await Rule.countDocuments({ user_id: USER_ID });
      
      // Get rules with execution data for the current user
      const rulesWithHistory = await Rule.find({
        lastTriggered: { $exists: true, $ne: null },
        user_id: USER_ID
      }).select('name lastTriggered triggerCount');
      
      // Calculate total executions
      const totalExecutions = rulesWithHistory.reduce((sum, rule) => sum + (rule.triggerCount || 0), 0);
      
      // Find most active rule
      let mostActiveRule = null;
      let highestTriggerCount = 0;
      
      for (const rule of rulesWithHistory) {
        if ((rule.triggerCount || 0) > highestTriggerCount) {
          mostActiveRule = rule;
          highestTriggerCount = rule.triggerCount || 0;
        }
      }
      
      // Calculate executions in the last 24 hours
      const now = new Date();
      const oneDayAgo = new Date(now);
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const last24Hours = rulesWithHistory.filter(rule => 
        new Date(rule.lastTriggered) >= oneDayAgo
      ).length;
      
      // Send simplified response with just the data needed for the dashboard
      res.json({
        totalRules: totalRules,
        totalExecutions: totalExecutions,
        last24Hours: last24Hours,
        mostActiveRule: mostActiveRule ? mostActiveRule.name : 'None'
      });
    } catch (error) {
      console.error('Error fetching rule statistics:', error);
      // Return default values if error occurs
      res.json({
        totalRules: 0,
        totalExecutions: 0,
        last24Hours: 0,
        mostActiveRule: 'None'
      });
    }
  });

// Add a route to get full details for a specific rule's execution history
app.get('/api/rules/:id/execution-history', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const rule = await Rule.findById(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    // If the rule has never been triggered, return an empty history
    if (!rule.lastTriggered) {
      return res.json({
        rule: {
          id: rule._id,
          name: rule.name,
          description: rule.description,
          active: rule.active
        },
        executionHistory: []
      });
    }
    
    // Get rule details and execution history
    const ruleDetails = {
      id: rule._id,
      name: rule.name,
      description: rule.description,
      active: rule.active,
      conditions: rule.conditions,
      actions: rule.actions,
      timeRestrictions: rule.timeRestrictions,
      lastTriggered: rule.lastTriggered,
      triggerCount: rule.triggerCount || 0
    };
    
    res.json({
      rule: ruleDetails
    });
  } catch (error) {
    console.error('Error fetching rule execution history:', error);
    res.status(500).json({ error: 'Failed to retrieve rule execution history' });
  }
});


app.post('/api/rules/:id/execute', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    // Check if learner mode is active
    if (!learnerModeActive) {
      return res.status(403).json({ error: 'Learner mode is not active. Cannot execute rules.' });
    }
    
    // Find the rule filtered by both ID and user_id
    const rule = await Rule.findOne({
      _id: req.params.id,
      user_id: USER_ID
    });
    
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    // Force execution regardless of conditions
    if (rule.actions && rule.actions.length > 0) {
      let allActionsApplied = true;
      
      rule.actions.forEach(action => {
        const actionApplied = applyAction(action);
        if (!actionApplied) {
          allActionsApplied = false;
        }
      });
      
      if (!allActionsApplied) {
        return res.status(403).json({ error: 'Some or all actions could not be applied because learner mode is inactive' });
      }
    } else {
      return res.status(400).json({ error: 'Rule has no actions to execute' });
    }
    
    // Update rule statistics
    rule.lastTriggered = new Date();
    rule.triggerCount = (rule.triggerCount || 0) + 1;
    await rule.save();
    
    // Log removed: console.log(`Rule "${rule.name}" manually executed at ${rule.lastTriggered}`);
    
    res.json({ 
      message: `Rule "${rule.name}" executed successfully`, 
      execution: {
        ruleId: rule._id,
        ruleName: rule.name,
        timestamp: rule.lastTriggered,
        triggerCount: rule.triggerCount,
        actions: rule.actions.map(action => ({
          setting: action.setting,
          value: action.value,
          inverter: action.inverter
        }))
      }
    });
  } catch (error) {
    console.error('Error executing rule:', error);
    res.status(500).json({ error: error.message });
  }
});


// Enhance the rules page with additional data
app.get('/rules', async (req, res) => {
    try {
      let rulesCount = 0;
      let activeRulesCount = 0;
      let systemState = { ...currentSystemState };
      let recentlyTriggered = [];
      
      if (dbConnected) {
        rulesCount = await Rule.countDocuments({ user_id: USER_ID });
        activeRulesCount = await Rule.countDocuments({ active: true, user_id: USER_ID });
        
        // Get recently triggered rules
        recentlyTriggered = await Rule.find({
          lastTriggered: { $exists: true, $ne: null },
          user_id: USER_ID
        })
        .sort({ lastTriggered: -1 })
        .limit(5)
        .select('name lastTriggered');
      }
      
      res.render('rules', { 
        db_connected: dbConnected,
        rules_count: rulesCount,
        active_rules_count: activeRulesCount,
        ingress_path: process.env.INGRESS_PATH || '',
        system_state: systemState,
        recently_triggered: recentlyTriggered,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering rules page:', error);
      res.status(500).send('Error loading page data');
    }
  });
  

app.get('/api/rules', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const rules = await Rule.find({ user_id: USER_ID }).sort({ name: 1 });
      res.json(rules);
    } catch (error) {
      console.error('Error retrieving rules:', error);
      res.status(500).json({ error: 'Failed to retrieve rules' });
    }
  });

  app.delete('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Find and delete the rule filtered by both ID and user_id
      const rule = await Rule.findOneAndDelete({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      res.json({ message: 'Rule deleted successfully' });
    } catch (error) {
      console.error('Error deleting rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

app.get('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Find the rule filtered by both ID and user_id
      const rule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      res.json(rule);
    } catch (error) {
      console.error('Error retrieving rule:', error);
      res.status(500).json({ error: 'Failed to retrieve rule' });
    }
  });

// API endpoint for current system state
app.get('/api/system-state', (req, res) => {
  res.json({ 
    current_state: currentSystemState,
    timestamp: new Date()
  })
})

app.get('/api/settings-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const changeType = req.query.type
      const limit = parseInt(req.query.limit) || 100
      const skip = parseInt(req.query.skip) || 0
      
      let query = { user_id: USER_ID } // Filter by user ID
      if (changeType) {
        query.change_type = changeType
      }
      
      const changes = await SettingsChange.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
      
      const total = await SettingsChange.countDocuments(query)
      
      res.json({
        changes,
        pagination: {
          total,
          limit,
          skip,
          hasMore: skip + limit < total
        }
      })
    } catch (error) {
      console.error('Error retrieving settings changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

app.get('/api/learner/status', (req, res) => {
  res.json({ 
    active: learnerModeActive,
    change_detection: 'always', // Indicating that changes are always detected
    action_execution: learnerModeActive ? 'enabled' : 'disabled', // Only execute actions when learner mode is active
    monitored_settings: settingsToMonitor,
    current_system_state: currentSystemState,
    db_connected: dbConnected
  })
})

app.post('/api/learner/toggle', (req, res) => {
  learnerModeActive = !learnerModeActive
  
  console.log(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`)
  
  res.json({ 
    success: true, 
    active: learnerModeActive,
    message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`,
    note: "Setting changes are still detected and recorded, but commands will only be sent when learner mode is active."
  })
})

app.get('/api/learner/changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const limit = parseInt(req.query.limit) || 50
      const changes = await SettingsChange.find({ user_id: USER_ID }) // Filter by user ID
        .sort({ timestamp: -1 })
        .limit(limit)
      
      res.json(changes)
    } catch (error) {
      console.error('Error retrieving learner changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

app.get('/api/database/status', (req, res) => {
  res.json({
    connected: dbConnected,
    uri: mongoDbUri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@') // Hide credentials
  })
})

app.get('/learner', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ user_id: USER_ID })
      }
      
      res.render('learner', { 
        active: learnerModeActive,
        change_detection: 'always', // New property to inform the front-end
        monitored_settings: settingsToMonitor,
        ingress_path: process.env.INGRESS_PATH || '',
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering learner page:', error)
      res.status(500).send('Error loading page data')
    }
  })


// Update the direct MQTT command injection route
app.post('/api/command', (req, res) => {
  try {
    // Check if learner mode is active
    if (!learnerModeActive) {
      return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' })
    }
    
    const { topic, value } = req.body;
    
    if (!topic || !value) {
      return res.status(400).json({ error: 'Missing topic or value' });
    }
    
    if (!mqttClient || !mqttClient.connected) {
      return res.status(503).json({ error: 'MQTT client not connected' });
    }
    
    mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}: ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
      
      // Removed verbose log: console.log(`Manual command sent: ${topic} = ${value}`);
      res.json({ success: true, message: `Command sent: ${topic} = ${value}` });
    });
  } catch (error) {
    console.error('Error sending command:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================ MQTT and CRON SCHEDULING ================

// Connect to MQTT with robust error handling
function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
    clientId: mqttConfig.clientId,
    reconnectPeriod: mqttConfig.reconnectPeriod,
    connectTimeout: mqttConfig.connectTimeout
  })

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker')
    // Subscribe to all topics with the prefix
    mqttClient.subscribe(`${mqttTopicPrefix}/#`, (err) => {
      if (err) {
        console.error('Error subscribing to topics:', err.message)
      } else {
        console.log(`Subscribed to ${mqttTopicPrefix}/#`)
      }
    })
  })

  mqttClient.on('message', (topic, message) => {
    const formattedMessage = `${topic}: ${message.toString()}`
    incomingMessages.push(formattedMessage)
    if (incomingMessages.length > MAX_MESSAGES) {
      incomingMessages.shift()
    }
    
    // Always save messages to InfluxDB regardless of learner mode
    saveMessageToInfluxDB(topic, message)
  })

  mqttClient.on('error', (err) => {
    console.error('MQTT error:', err.message)
  })
  
  mqttClient.on('disconnect', () => {
    console.log('Disconnected from MQTT broker')
  })
  
  mqttClient.on('reconnect', () => {
    console.log('Reconnecting to MQTT broker...')
  })
}

// Save MQTT message to InfluxDB with better error handling
async function saveMessageToInfluxDB(topic, message) {
  try {
    const parsedMessage = parseFloat(message.toString())

    if (isNaN(parsedMessage)) {
      return
    }

    const timestamp = new Date().getTime()
    const dataPoint = {
      measurement: 'state',
      fields: { value: parsedMessage },
      tags: { topic: topic },
      timestamp: timestamp * 1000000,
    }

    await retry(
      async () => {
        await influx.writePoints([dataPoint])
      },
      {
        retries: 5,
        minTimeout: 1000,
      }
    )
  } catch (err) {
    console.error(
      'Error saving message to InfluxDB:',
      err.response ? err.response.body : err.message
    )
  }
}


// Fetch analytics data from InfluxDB
async function queryInfluxDB(topic) {
    const query = `
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - 30d
        GROUP BY time(1d) tz('${currentTimezone}')
    `
    try {
      return await influx.query(query)
    } catch (error) {
      console.error(
        `Error querying InfluxDB for topic ${topic}:`,
        error.toString()
      )
      throw error
    }
  }
  
  // Function to query InfluxDB for the last 12 months of data
  async function queryInfluxDBForYear(topic) {
    const query = `
      SELECT last("value") AS "value"
      FROM "state"
      WHERE "topic" = '${topic}'
      AND time >= now() - 365d
      GROUP BY time(1d) tz('${currentTimezone}')
    `
    try {
      return await influx.query(query)
    } catch (error) {
      console.error(
        `Error querying InfluxDB for topic ${topic}:`,
        error.toString()
      )
      throw error
    }
  }
  
  async function queryInfluxDBForDecade(topic) {
    const query = `
      SELECT last("value") AS "value"
      FROM "state"
      WHERE "topic" = '${topic}'
      AND time >= now() - 3650d
      GROUP BY time(1d) tz('${currentTimezone}')
    `
    try {
      return await influx.query(query)
    } catch (error) {
      console.error(
        `Error querying InfluxDB for topic ${topic}:`,
        error.toString()
      )
      throw error
    }
  }

  async function queryInfluxData(topic, duration = '365d') {
    const query = `
      SELECT mean("value") AS "value"
      FROM "state"
      WHERE "topic" = '${topic}'
      AND time >= now() - ${duration}
      GROUP BY time(1d) tz('${currentTimezone}')
    `
    try {
      return await influx.query(query)
    } catch (error) {
      console.error(
        `Error querying InfluxDB for topic ${topic}:`,
        error.toString()
      )
      throw error
    }
  }



// Periodic rule evaluation (every minute)
cron.schedule('* * * * *', () => {
  console.log('Running scheduled rule evaluation...')
  processRules()
})

// Weekend rules scheduling
cron.schedule('0 0 * * 6', () => {
  // console.log('It\'s Saturday! Applying weekend settings...')
  // Can add specific weekend settings here if needed
})

cron.schedule('0 0 * * 1', () => {
  // console.log('It\'s Monday! Reverting weekend settings...')
  // Can add specific weekday settings here if needed
})

// Graceful shutdown function
function gracefulShutdown() {
  console.log('Starting graceful shutdown...')
  
  // Close database connection
  if (mongoose.connection.readyState === 1) {
    console.log('Closing MongoDB connection')
    mongoose.connection.close()
  }
  
  // Close MQTT connection
  if (mqttClient) {
    console.log('Closing MQTT connection')
    mqttClient.end(true)
  }
  
  console.log('Shutdown complete')
  process.exit(0)
}

// Register signal handlers
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// Initialize connections to external services
async function initializeConnections() {
  // Connect to MQTT broker
  connectToMqtt()
// Connect to Web Socket broker
  connectToWebSocketBroker();
  
  // Connect to database
  try {
    await connectToDatabase()
    
    // Create default rules if connected to DB
    if (dbConnected) {
      // Replace the original createDefaultRules() call with our enhanced initialization
      await initializeAutomationRules()
    }
  } catch (err) {
    console.error('Initial database connection failed:', err)
    // Continue app startup even if DB fails initially
    setTimeout(retryDatabaseConnection, 10000)
  }
}

// Function that integrates both default and extended rules
async function initializeAutomationRules() {
  try {
    // First create the basic default rules
    await createDefaultRules();
    
    // Then create the extended advanced rules
    await createExtendedAutomationRules();

     // Finally, create the night charging rules
     await createNightChargingRule();
    
    console.log('All automation rules initialized successfully');
  } catch (error) {
    console.error('Error initializing automation rules:', error.message);
  }
}

// Initialize connections when server starts
initializeConnections()

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

// 404 handler
app.use((req, res, next) => {
  res.status(404).send("Sorry, that route doesn't exist.")
})

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})