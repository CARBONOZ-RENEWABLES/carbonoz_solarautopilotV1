const express = require('express')
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
const JsonRuleStorage = require('./utils/jsonRuleStorage');
const cron = require('node-cron')
const session = require('express-session');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { startOfDay } = require('date-fns')
const { AuthenticateUser } = require('./utils/mongoService')
const telegramService = require('./services/telegramService');
const warningService = require('./services/warningService');
const notificationRoutes = require('./routes/notificationRoutes');
const tibberService = require('./services/tibberService');
const aiChargingEngine = require('./services/aiChargingEngine');

let aiEngineInitialized = false;

// Initialize AI engine after MQTT connection
function initializeAIEngine() {
  if (!aiEngineInitialized && mqttClient && mqttClient.connected) {
    try {
      // Set up AI engine with MQTT client and system state
      if (aiChargingEngine && aiChargingEngine.initialize) {
        aiChargingEngine.initialize(mqttClient, currentSystemState);
        console.log('✅ AI Charging Engine initialized');
        aiEngineInitialized = true;
      }
    } catch (error) {
      console.error('❌ Error initializing AI engine:', error);
    }
  }
}

const GRAFANA_URL = 'http://localhost:3001';
const BASE_PATH = process.env.INGRESS_PATH || '';



// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))

// JSON parsing with error handling - reduced limit
app.use(express.json({ 
  limit: '1mb'
}));

app.use(express.urlencoded({ extended: true }))

// JSON parsing error handler
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    console.error('❌ JSON Syntax Error:', error.message);
    console.error('Request path:', req.path);
    console.error('Request method:', req.method);
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON format in request body',
      details: error.message
    });
  }
  next(error);
});
app.use(express.static(path.join(__dirname, 'public')))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

app.use((req, res, next) => {
  if (req.path.includes('/hassio_ingress/')) {
    const pathParts = req.path.split('/');
    const ingressIndex = pathParts.indexOf('hassio_ingress');
    if (ingressIndex >= 0 && pathParts[ingressIndex + 1]) {
      req.basePath = `/api/hassio_ingress/${pathParts[ingressIndex + 1]}`;
    }
  } else {
    req.basePath = BASE_PATH;
  }
  next();
});

// Grafana proxy - handles all the path rewriting
const grafanaProxy = createProxyMiddleware({
  target: GRAFANA_URL,
  changeOrigin: true,
  ws: true,
  pathRewrite: (path, req) => {
    let newPath = path;
    
    // Remove ingress path if present
    if (req.basePath && path.startsWith(req.basePath)) {
      newPath = path.substring(req.basePath.length);
    }
    
    // Remove /hassio_ingress/TOKEN part for stripped paths
    if (path.includes('/hassio_ingress/')) {
      const parts = path.split('/');
      const idx = parts.indexOf('hassio_ingress');
      if (idx >= 0 && parts[idx + 2]) {
        newPath = '/' + parts.slice(idx + 2).join('/');
      }
    }
    
    // Remove /grafana prefix
    if (newPath.startsWith('/grafana')) {
      newPath = newPath.substring('/grafana'.length);
    }
    
    // Ensure leading slash
    if (!newPath.startsWith('/')) {
      newPath = '/' + newPath;
    }
    
    console.log(`Proxy: ${path} -> ${newPath}`);
    return newPath;
  },
  onProxyRes: (proxyRes, req, res) => {
    // Allow iframe embedding
    delete proxyRes.headers['x-frame-options'];
  }
});
// Apply Grafana proxy to all necessary routes
app.use('/grafana', grafanaProxy);
app.use('/api/hassio_ingress/:token/grafana', grafanaProxy);
app.use('/hassio_ingress/:token/grafana', grafanaProxy);


// Read configuration from Home Assistant add-on options
const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))

// Optimized favicon handler
app.get('/favicon.ico', (req, res) => {
  res.status(204).end(); // Use .end() instead of .send() for better performance
});

// Test endpoint to check for corrupted data
app.get('/api/debug/rules', (req, res) => {
  if (!dbConnected || !jsonStorage) {
    return res.json({ error: 'Storage not connected' });
  }
  
  try {
    const rules = jsonStorage.getAllRules().slice(0, 5);
    
    const debugInfo = rules.map(rule => {
      const info = { id: rule.id, name: rule.name };
      
      // Test each field
      ['conditions', 'timeRestrictions', 'actions'].forEach(field => {
        try {
          if (rule[field]) {
            info[field] = 'valid';
          } else {
            info[field] = 'null';
          }
        } catch (e) {
          info[field] = `error: ${e.message}`;
        }
      });
      
      return info;
    });
    
    res.json({ rules: debugInfo, total: rules.length });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Endpoint to fix all corrupted rules
app.post('/api/debug/fix-rules', (req, res) => {
  if (!dbConnected || !jsonStorage) {
    return res.json({ error: 'Storage not connected' });
  }
  
  try {
    // JSON storage doesn't have corruption issues like SQLite
    res.json({ 
      success: true, 
      message: 'JSON storage does not require corruption fixes',
      nullFixed: 0,
      allFixed: 0
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});



// ================ ENHANCED STATIC FILE HANDLER ================

// Extract configuration values with defaults
const inverterNumber = options.inverter_number 
const batteryNumber = options.battery_number 
const mqttTopicPrefix = options.mqtt_topic_prefix 

// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json')
const RULES_FILE = path.join(__dirname, 'data', 'rules.json')
const CACHE_DURATION = 24 * 3600000 // 24 hours in milliseconds
const DB_FILE = path.join(__dirname, 'data', 'energy_monitor.db')
const TELEGRAM_CONFIG_FILE = path.join(__dirname, 'data', 'telegram_config.json')
const WARNINGS_CONFIG_FILE = path.join(__dirname, 'data', 'warnings_config.json')

// Create data directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'))
}

// JSON storage instance
let jsonStorage;
let dbConnected = false;

// JSON storage doesn't need corruption cleanup

if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    apiKey: '',
    selectedZone: '',
    username: ''
  }));
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}))
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}))

// Configure trust proxy more securely for Home Assistant ingress
const TRUSTED_PROXIES = [
  'loopback',           // Trust localhost (127.0.0.1, ::1)
  'linklocal',          // Trust link-local addresses
  '172.16.0.0/12',      // Docker networks
  '192.168.0.0/16',     // Private networks
  '10.0.0.0/8'          // Private networks
];

app.set('trust proxy', TRUSTED_PROXIES);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased limit to 1000 requests per windowMs
  
  // Custom key generator that safely handles proxy headers
  keyGenerator: (req) => {
    // Get the real IP address, fallback to connection remote address
    const forwarded = req.get('x-forwarded-for');
    const realIp = req.get('x-real-ip');
    const connectionIp = req.connection?.remoteAddress || req.socket?.remoteAddress;
    
    // Use the first forwarded IP if available and valid, otherwise use real IP or connection IP
    let clientIp = connectionIp;
    
    if (forwarded) {
      const forwardedIps = forwarded.split(',').map(ip => ip.trim());
      const firstIp = forwardedIps[0];
      if (firstIp && firstIp !== 'unknown') {
        clientIp = firstIp;
      }
    } else if (realIp && realIp !== 'unknown') {
      clientIp = realIp;
    }
    
    // Fallback to a default if we still don't have a valid IP
    return clientIp || 'unknown-client';
  },
  
  // Skip rate limiting for health checks and rules API
  skip: (req) => {
    const skipPaths = ['/health', '/api/health', '/status', '/api/rules'];
    return skipPaths.some(path => req.path.includes(path));
  },
  
  // Custom handler for rate limit exceeded
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests, please try again later.',
      retryAfter: Math.ceil(15 * 60) // 15 minutes in seconds
    });
  }
});

app.use('/api/', limiter);

const API_REQUEST_INTERVAL = 200; // Reduced to 200ms between API requests

// InfluxDB configuration
const influxConfig = {
  host: 'localhost',
  port: 8086,
  database: 'home_assistant',
  username: 'admin',
  password: 'adminpassword',
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
  influx = {
    writePoints: async () => {
      console.error('InfluxDB not available, data not saved')
      return Promise.resolve()
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
const MAX_MESSAGES = 100

// Learner mode configuration
global.learnerModeActive = false

// Updated settings to monitor including new inverter types
const settingsToMonitor = [
  // Legacy inverter settings
  'energy_pattern',
  'grid_charge',
  'power',
  'device_mode',
  'voltage',
  'work_mode_timer',
  'voltage_point',
  
  // New inverter settings  
  'charger_source_priority',
  'output_source_priority',
  
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
  'work_mode',
  'solar_export_when_battery_full',
  'max_sell_power',
  'max_solar_power',
  'grid_trickle_feed',
  'serial_number',
  'power_saving',
]

// System state tracking
let currentSystemState = {
  battery_soc: null,
  pv_power: null,
  load: null,
  grid_voltage: null,
  grid_power: null,
  battery_power: null,  // Add this line
  inverter_state: null,
  timestamp: null
}

// Updated current settings state to handle both inverter types
const currentSettingsState = {
  // Legacy Grid Charge Settings
  grid_charge: {},
  
  // Legacy Energy Pattern Settings
  energy_pattern: {},
  
  // New Inverter Settings
  charger_source_priority: {},
  output_source_priority: {},
  
  // Voltage Point Settings
  voltage_point: {},
  
  // Work Mode Settings
  work_mode: {},
  remote_switch: {},
  generator_charge: {},
  force_generator_on: {},
  output_shutdown_voltage: {},
  stop_battery_discharge_voltage: {},
  start_battery_discharge_voltage: {},
  start_grid_charge_voltage: {},
  solar_export_when_battery_full: {},
  max_sell_power: {},
  max_solar_power: {},
  grid_trickle_feed: {},
  
  // Battery Charging Settings
  max_discharge_current: {},
  max_charge_current: {},
  max_grid_charge_current: {},
  max_generator_charge_current: {},
  battery_float_charge_voltage: {},
  battery_absorption_charge_voltage: {},
  battery_equalization_charge_voltage: {},

  // Specification settings
  serial_number: {},
  power_saving: {},
  
  // Last updated timestamp
  lastUpdated: null
};

// Track previous state of settings to detect changes
let previousSettings = {}

// Track inverter types for each inverter
const inverterTypes = {}

// Dynamic pricing instance removed

// Make learner mode accessible globally
global.learnerModeActive = learnerModeActive;

// Make inverter types globally accessible
global.inverterTypes = inverterTypes;

// Make configuration globally accessible for AI engine
global.inverterNumber = inverterNumber;
global.mqttTopicPrefix = mqttTopicPrefix;

// ================ INVERTER TYPE DETECTION ================

// Function to detect inverter type based on received MQTT messages
function detectInverterType(inverterId, specificTopic, messageContent) {
  // Initialize inverter type if not exists
  if (!inverterTypes[inverterId]) {
    inverterTypes[inverterId] = {
      type: 'unknown',
      hasLegacySettings: false,
      hasNewSettings: false,
      detectionConfidence: 0
    };
  }
  
  const inverterData = inverterTypes[inverterId];
  
  // Check for legacy settings
  if (specificTopic.includes('/energy_pattern/') || specificTopic.includes('/grid_charge/')) {
    inverterData.hasLegacySettings = true;
    inverterData.detectionConfidence += 10;
  }
  
  // Check for new settings
  if (specificTopic.includes('/charger_source_priority/') || specificTopic.includes('/output_source_priority/')) {
    inverterData.hasNewSettings = true;
    inverterData.detectionConfidence += 10;
  }
  
  // Determine type based on detection
  if (inverterData.hasLegacySettings && !inverterData.hasNewSettings && inverterData.detectionConfidence >= 10) {
    inverterData.type = 'legacy';
  } else if (inverterData.hasNewSettings && !inverterData.hasLegacySettings && inverterData.detectionConfidence >= 10) {
    inverterData.type = 'new';
  } else if (inverterData.hasLegacySettings && inverterData.hasNewSettings) {
    inverterData.type = 'hybrid';
  }
  
  return inverterData.type;
}

// Function to get inverter type
function getInverterType(inverterId) {
  return inverterTypes[inverterId]?.type || 'unknown';
}

// ================ SETTING MAPPING FUNCTIONS ================

// Map legacy energy_pattern to new output_source_priority
function mapEnergyPatternToOutputSourcePriority(energyPattern) {
  switch (energyPattern) {
    case 'Battery first':
      return 'Solar/Battery/Utility';
    case 'Load first':
      return 'Solar first';
    case 'Grid first':
      return 'Utility first';
    case 'Solar first':
      return 'Solar first';
    default:
      return 'Solar/Battery/Utility';
  }
}

// Map new output_source_priority to legacy energy_pattern
function mapOutputSourcePriorityToEnergyPattern(outputPriority) {
  switch (outputPriority) {
    case 'Solar/Battery/Utility':
      return 'Battery first';
    case 'Solar first':
      return 'Solar first';
    case 'Utility first':
      return 'Grid first';
    case 'Solar/Utility/Battery':
      return 'Load first';
    default:
      return 'Battery first';
  }
}

// Map legacy grid_charge to new charger_source_priority
function mapGridChargeToChargerSourcePriority(gridCharge) {
  switch (gridCharge) {
    case 'Enabled':
      return 'Solar and utility simultaneously';
    case 'Disabled':
      return 'Solar first';
    default:
      return 'Solar first';
  }
}

// Map new charger_source_priority to legacy grid_charge
function mapChargerSourcePriorityToGridCharge(chargerPriority) {
  switch (chargerPriority) {
    case 'Utility first':
    case 'Solar and utility simultaneously':
      return 'Enabled';
    case 'Solar first':
    case 'Solar only':
      return 'Disabled';
    default:
      return 'Disabled';
  }
}

// ================ DATABASE FUNCTIONS ================

async function initializeDatabase() {
  try {
    jsonStorage = new JsonRuleStorage(path.join(__dirname, 'data'));
    console.log('JSON storage initialized');
    dbConnected = true;
    return true;
  } catch (error) {
    console.error('Error initializing JSON storage:', error.message);
    dbConnected = false;
    return false;
  }
}

function cleanupCurrentSettingsState() {
  try {
    const now = Date.now();
    const MAX_AGE_MS = 60 * 60 * 1000; // Reduced to 1 hour
    
    Object.keys(currentSettingsState).forEach(category => {
      if (typeof currentSettingsState[category] === 'object' && category !== 'lastUpdated') {
        Object.keys(currentSettingsState[category]).forEach(inverterId => {
          if (currentSettingsState[category][inverterId] && 
              currentSettingsState[category][inverterId].lastUpdated) {
            const lastUpdated = new Date(currentSettingsState[category][inverterId].lastUpdated).getTime();
            if (now - lastUpdated > MAX_AGE_MS) {
              delete currentSettingsState[category][inverterId];
            }
          }
        });
      }
    });
    
    console.log('Cleaned up stale entries in currentSettingsState');
  } catch (error) {
    console.error('Error cleaning up currentSettingsState:', error.message);
  }
}

// ================ USER IDENTIFICATION SYSTEM ================

function generateUserId() {
  const userIdBase = `${mqttConfig.username}:${options.mqtt_host}:${options.mqtt_topic_prefix}`;
  
  let hash = 0;
  for (let i = 0; i < userIdBase.length; i++) {
    const char = userIdBase.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  return `user_${Math.abs(hash).toString(16)}`;
}

const USER_ID = generateUserId();
console.log(`Generated User ID: ${USER_ID}`);

async function retryDatabaseConnection() {
  try {
    if (!dbConnected) {
      console.log('Retrying database connection...')
      await connectToDatabase()
    }
  } catch (error) {
    console.error('Failed to connect to database on retry:', error.message)
    setTimeout(retryDatabaseConnection, 30000)
  }
}

// ================ SETTINGS CHANGE FUNCTIONS ================

async function saveSettingsChange(changeData) {
  try {
    const point = {
      measurement: 'settings_changes',
      tags: {
        topic: changeData.topic,
        change_type: changeData.change_type,
        user_id: changeData.user_id,
        mqtt_username: changeData.mqtt_username
      },
      fields: {
        old_value: String(changeData.old_value || ''),
        new_value: String(changeData.new_value || ''),
        system_state: JSON.stringify(changeData.system_state || {})
      },
      timestamp: changeData.timestamp
    };
    
    await influx.writePoints([point]);
    return true;
  } catch (error) {
    console.error('Error saving settings change to InfluxDB:', error.message);
    return false;
  }
}

async function handleSettingChange(specificTopic, messageContent, changeType) {
  if (previousSettings[specificTopic] !== messageContent) {
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: changeType,
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    previousSettings[specificTopic] = messageContent;
    
    if (dbConnected) {
      try {
        await saveSettingsChange(changeData);
      } catch (error) {
        console.error('Error saving to database:', error.message);
        retryDatabaseConnection();
      }
    } else {
      retryDatabaseConnection();
    }
    
    if (changeType === 'grid_charge' || changeType === 'charger_source_priority') {
      sendGridChargeNotification(changeData);
    } else if (changeType === 'energy_pattern' || changeType === 'output_source_priority') {
      sendEnergyPatternNotification(changeData);
    } else if (changeType === 'voltage_point') {
      sendVoltagePointNotification(changeData);
    }
  }
}

async function handleBatteryChargingSettingChange(specificTopic, messageContent, settingType) {
  if (previousSettings[specificTopic] !== messageContent) {
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: settingType,
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    previousSettings[specificTopic] = messageContent;
    
    if (dbConnected) {
      try {
        await saveSettingsChange(changeData);
      } catch (error) {
        console.error('Error saving to database:', error.message);
        retryDatabaseConnection();
      }
    } else {
      retryDatabaseConnection();
    }
    
    sendBatteryChargingNotification(changeData);
  }
}

async function handleWorkModeSettingChange(specificTopic, messageContent, settingType) {
  if (previousSettings[specificTopic] !== messageContent) {
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: settingType,
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    previousSettings[specificTopic] = messageContent;
    
    if (dbConnected) {
      try {
        await saveSettingsChange(changeData);
      } catch (error) {
        console.error('Error saving to database:', error.message);
        retryDatabaseConnection();
      }
    } else {
      retryDatabaseConnection();
    }
    
    sendWorkModeNotification(changeData);
  }
}

// ================ RULES FUNCTIONS ================

function countRules(userId) {
  if (!dbConnected || !jsonStorage) return 0;
  
  try {
    return jsonStorage.countRules(userId);
  } catch (error) {
    console.error('Error counting rules:', error.message);
    return 0;
  }
}

function batchUpdateRules(rules) {
  if (!dbConnected || !jsonStorage || rules.length === 0) return;
  
  try {
    return jsonStorage.batchUpdateRules(rules);
  } catch (error) {
    console.error('Error batch updating rules:', error.message);
    return false;
  }
}

function saveRule(ruleData) {
  if (!dbConnected || !jsonStorage) return null;
  
  try {
    return jsonStorage.saveRule(ruleData);
  } catch (error) {
    console.error('Error saving rule:', error.message);
    return null;
  }
}

function updateRule(id, ruleData) {
  if (!dbConnected || !jsonStorage) return false;
  
  try {
    return jsonStorage.updateRule(id, ruleData);
  } catch (error) {
    console.error('Error updating rule:', error.message);
    return false;
  }
}

function getAllRules(userId, options = {}) {
  if (!dbConnected || !jsonStorage) return [];
  
  try {
    return jsonStorage.getAllRules(userId, options);
  } catch (error) {
    console.error('Error getting rules:', error.message);
    return [];
  }
}

function deleteRule(id, userId) {
  if (!dbConnected || !jsonStorage) return false;
  
  try {
    return jsonStorage.deleteRule(id, userId);
  } catch (error) {
    console.error('Error deleting rule:', error.message);
    return false;
  }
}

function getRuleById(id, userId) {
  if (!dbConnected || !jsonStorage) return null;
  
  try {
    return jsonStorage.getRuleById(id, userId);
  } catch (error) {
    console.error('Error getting rule by ID:', error.message);
    return null;
  }
}

async function getSettingsChanges(userId, options = {}) {
  try {
    const limit = options.limit || 100;
    const skip = options.skip || 0;
    
    let query = `SELECT * FROM settings_changes WHERE user_id = '${userId}'`;
    
    if (options.changeType) {
      query += ` AND change_type = '${options.changeType}'`;
    }
    
    query += ` ORDER BY time DESC LIMIT ${limit} OFFSET ${skip}`;
    
    const result = await influx.query(query);
    
    const formattedChanges = result.map(change => ({
      time: change.time,
      topic: change.topic,
      old_value: change.old_value,
      new_value: change.new_value,
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    return {
      changes: formattedChanges,
      pagination: {
        total: formattedChanges.length,
        limit,
        skip,
        hasMore: formattedChanges.length === limit
      }
    };
  } catch (error) {
    console.error('Error getting settings changes from InfluxDB:', error.message);
    return { changes: [], pagination: { total: 0 } };
  }
}

function parseJsonOrValue(value) {
  if (!value) return value;
  
  try {
    if (value.startsWith('{') || value.startsWith('[')) {
      return JSON.parse(value);
    }
  } catch (e) {
    // Not JSON, just return the value
  }
  
  return value;
}

// ================ COMPLETE ENHANCED MQTT MESSAGE HANDLING ================

async function handleMqttMessage(topic, message) {
  const bufferSize = learnerModeActive ? Math.min(50, MAX_MESSAGES) : MAX_MESSAGES;
  
  const messageStr = message.toString();
  const maxMessageSize = 1000; // Further reduced
  
  const truncatedMessage = messageStr.length > maxMessageSize 
    ? messageStr.substring(0, maxMessageSize) + '...' 
    : messageStr;
  
  const formattedMessage = `${topic}: ${truncatedMessage}`;
  
  // More aggressive message buffer management
  if (incomingMessages.length >= bufferSize) {
    incomingMessages.shift(); // Remove oldest message
  }
  incomingMessages.push(formattedMessage);

  let messageContent;
  try {
    messageContent = messageStr;
    
    if (messageStr.length < maxMessageSize && messageStr.startsWith('{') && messageStr.endsWith('}')) {
      messageContent = JSON.parse(messageStr);
    }
  } catch (error) {
    messageContent = messageStr;
  }

  const topicPrefix = options.mqtt_topic_prefix || '';
  let specificTopic = topic;
  if (topic.startsWith(topicPrefix)) {
    specificTopic = topic.substring(topicPrefix.length + 1);
  }

  let shouldProcessRules = false;

  // Extract inverter ID from the topic
  let inverterId = "inverter_1";
  const inverterMatch = specificTopic.match(/inverter_(\d+)/);
  if (inverterMatch) {
    inverterId = `inverter_${inverterMatch[1]}`;
  }
  
  // Enhanced inverter type detection based on MQTT messages
  detectInverterType(inverterId, specificTopic, messageContent);

  // ========= UPDATE CURRENT SETTINGS STATE IN MEMORY WITH ENHANCED SUPPORT =========
  
  // Handle legacy grid_charge settings
  if (specificTopic.includes('/grid_charge/')) {
    if (!currentSettingsState.grid_charge[inverterId]) {
      currentSettingsState.grid_charge[inverterId] = {};
    }
    currentSettingsState.grid_charge[inverterId].value = messageContent;
    currentSettingsState.grid_charge[inverterId].lastUpdated = new Date();
  } 
  
  // Handle legacy energy_pattern settings
  else if (specificTopic.includes('/energy_pattern/')) {
    if (!currentSettingsState.energy_pattern[inverterId]) {
      currentSettingsState.energy_pattern[inverterId] = {};
    }
    currentSettingsState.energy_pattern[inverterId].value = messageContent;
    currentSettingsState.energy_pattern[inverterId].lastUpdated = new Date();
  }
  
  // Handle NEW charger_source_priority settings
  else if (specificTopic.includes('/charger_source_priority/')) {
    if (!currentSettingsState.charger_source_priority[inverterId]) {
      currentSettingsState.charger_source_priority[inverterId] = {};
    }
    currentSettingsState.charger_source_priority[inverterId].value = messageContent;
    currentSettingsState.charger_source_priority[inverterId].lastUpdated = new Date();
    
    // Also update equivalent legacy grid_charge value for compatibility
    const equivalentGridCharge = mapChargerSourcePriorityToGridCharge(messageContent);
    if (!currentSettingsState.grid_charge[inverterId]) {
      currentSettingsState.grid_charge[inverterId] = {};
    }
    currentSettingsState.grid_charge[inverterId].value = equivalentGridCharge;
    currentSettingsState.grid_charge[inverterId].lastUpdated = new Date();
    currentSettingsState.grid_charge[inverterId].mappedFrom = 'charger_source_priority';
  }
  
  // Handle NEW output_source_priority settings
  else if (specificTopic.includes('/output_source_priority/')) {
    if (!currentSettingsState.output_source_priority[inverterId]) {
      currentSettingsState.output_source_priority[inverterId] = {};
    }
    currentSettingsState.output_source_priority[inverterId].value = messageContent;
    currentSettingsState.output_source_priority[inverterId].lastUpdated = new Date();
    
    // Also update equivalent legacy energy_pattern value for compatibility
    const equivalentEnergyPattern = mapOutputSourcePriorityToEnergyPattern(messageContent);
    if (!currentSettingsState.energy_pattern[inverterId]) {
      currentSettingsState.energy_pattern[inverterId] = {};
    }
    currentSettingsState.energy_pattern[inverterId].value = equivalentEnergyPattern;
    currentSettingsState.energy_pattern[inverterId].lastUpdated = new Date();
    currentSettingsState.energy_pattern[inverterId].mappedFrom = 'output_source_priority';
  }
  
  // Handle voltage point settings
  else if (specificTopic.match(/\/voltage_point_\d+\//)) {
    const voltagePointMatch = specificTopic.match(/voltage_point_(\d+)/);
    if (voltagePointMatch) {
      const pointNumber = voltagePointMatch[1];
      if (!currentSettingsState.voltage_point[inverterId]) {
        currentSettingsState.voltage_point[inverterId] = {};
      }
      if (!currentSettingsState.voltage_point[inverterId][`point_${pointNumber}`]) {
        currentSettingsState.voltage_point[inverterId][`point_${pointNumber}`] = {};
      }
      currentSettingsState.voltage_point[inverterId][`point_${pointNumber}`].value = messageContent;
      currentSettingsState.voltage_point[inverterId][`point_${pointNumber}`].lastUpdated = new Date();
    }
  }
  
  // Handle work mode settings
  else if (specificTopic.includes('/work_mode/') && !specificTopic.includes('work_mode_timer')) {
    if (!currentSettingsState.work_mode[inverterId]) {
      currentSettingsState.work_mode[inverterId] = {};
    }
    currentSettingsState.work_mode[inverterId].value = messageContent;
    currentSettingsState.work_mode[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/remote_switch/')) {
    if (!currentSettingsState.remote_switch[inverterId]) {
      currentSettingsState.remote_switch[inverterId] = {};
    }
    currentSettingsState.remote_switch[inverterId].value = messageContent;
    currentSettingsState.remote_switch[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/generator_charge/')) {
    if (!currentSettingsState.generator_charge[inverterId]) {
      currentSettingsState.generator_charge[inverterId] = {};
    }
    currentSettingsState.generator_charge[inverterId].value = messageContent;
    currentSettingsState.generator_charge[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/force_generator_on/')) {
    if (!currentSettingsState.force_generator_on[inverterId]) {
      currentSettingsState.force_generator_on[inverterId] = {};
    }
    currentSettingsState.force_generator_on[inverterId].value = messageContent;
    currentSettingsState.force_generator_on[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/output_shutdown_voltage/')) {
    if (!currentSettingsState.output_shutdown_voltage[inverterId]) {
      currentSettingsState.output_shutdown_voltage[inverterId] = {};
    }
    currentSettingsState.output_shutdown_voltage[inverterId].value = messageContent;
    currentSettingsState.output_shutdown_voltage[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/stop_battery_discharge_voltage/')) {
    if (!currentSettingsState.stop_battery_discharge_voltage[inverterId]) {
      currentSettingsState.stop_battery_discharge_voltage[inverterId] = {};
    }
    currentSettingsState.stop_battery_discharge_voltage[inverterId].value = messageContent;
    currentSettingsState.stop_battery_discharge_voltage[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/start_battery_discharge_voltage/')) {
    if (!currentSettingsState.start_battery_discharge_voltage[inverterId]) {
      currentSettingsState.start_battery_discharge_voltage[inverterId] = {};
    }
    currentSettingsState.start_battery_discharge_voltage[inverterId].value = messageContent;
    currentSettingsState.start_battery_discharge_voltage[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/start_grid_charge_voltage/')) {
    if (!currentSettingsState.start_grid_charge_voltage[inverterId]) {
      currentSettingsState.start_grid_charge_voltage[inverterId] = {};
    }
    currentSettingsState.start_grid_charge_voltage[inverterId].value = messageContent;
    currentSettingsState.start_grid_charge_voltage[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/solar_export_when_battery_full/')) {
    if (!currentSettingsState.solar_export_when_battery_full[inverterId]) {
      currentSettingsState.solar_export_when_battery_full[inverterId] = {};
    }
    currentSettingsState.solar_export_when_battery_full[inverterId].value = messageContent;
    currentSettingsState.solar_export_when_battery_full[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/max_sell_power/')) {
    if (!currentSettingsState.max_sell_power[inverterId]) {
      currentSettingsState.max_sell_power[inverterId] = {};
    }
    currentSettingsState.max_sell_power[inverterId].value = messageContent;
    currentSettingsState.max_sell_power[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/max_solar_power/')) {
    if (!currentSettingsState.max_solar_power[inverterId]) {
      currentSettingsState.max_solar_power[inverterId] = {};
    }
    currentSettingsState.max_solar_power[inverterId].value = messageContent;
    currentSettingsState.max_solar_power[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/grid_trickle_feed/')) {
    if (!currentSettingsState.grid_trickle_feed[inverterId]) {
      currentSettingsState.grid_trickle_feed[inverterId] = {};
    }
    currentSettingsState.grid_trickle_feed[inverterId].value = messageContent;
    currentSettingsState.grid_trickle_feed[inverterId].lastUpdated = new Date();
  }
  
  // Handle battery charging settings
  else if (specificTopic.includes('/max_discharge_current/')) {
    if (!currentSettingsState.max_discharge_current[inverterId]) {
      currentSettingsState.max_discharge_current[inverterId] = {};
    }
    currentSettingsState.max_discharge_current[inverterId].value = messageContent;
    currentSettingsState.max_discharge_current[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/max_charge_current/')) {
    if (!currentSettingsState.max_charge_current[inverterId]) {
      currentSettingsState.max_charge_current[inverterId] = {};
    }
    currentSettingsState.max_charge_current[inverterId].value = messageContent;
    currentSettingsState.max_charge_current[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/max_grid_charge_current/')) {
    if (!currentSettingsState.max_grid_charge_current[inverterId]) {
      currentSettingsState.max_grid_charge_current[inverterId] = {};
    }
    currentSettingsState.max_grid_charge_current[inverterId].value = messageContent;
    currentSettingsState.max_grid_charge_current[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/max_generator_charge_current/')) {
    if (!currentSettingsState.max_generator_charge_current[inverterId]) {
      currentSettingsState.max_generator_charge_current[inverterId] = {};
    }
    currentSettingsState.max_generator_charge_current[inverterId].value = messageContent;
    currentSettingsState.max_generator_charge_current[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/battery_float_charge_voltage/')) {
    if (!currentSettingsState.battery_float_charge_voltage[inverterId]) {
      currentSettingsState.battery_float_charge_voltage[inverterId] = {};
    }
    currentSettingsState.battery_float_charge_voltage[inverterId].value = messageContent;
    currentSettingsState.battery_float_charge_voltage[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/battery_absorption_charge_voltage/')) {
    if (!currentSettingsState.battery_absorption_charge_voltage[inverterId]) {
      currentSettingsState.battery_absorption_charge_voltage[inverterId] = {};
    }
    currentSettingsState.battery_absorption_charge_voltage[inverterId].value = messageContent;
    currentSettingsState.battery_absorption_charge_voltage[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/battery_equalization_charge_voltage/')) {
    if (!currentSettingsState.battery_equalization_charge_voltage[inverterId]) {
      currentSettingsState.battery_equalization_charge_voltage[inverterId] = {};
    }
    currentSettingsState.battery_equalization_charge_voltage[inverterId].value = messageContent;
    currentSettingsState.battery_equalization_charge_voltage[inverterId].lastUpdated = new Date();
  }

  // Handle specification data
  else if (specificTopic.includes('/serial_number/')) {
    if (!currentSettingsState.serial_number[inverterId]) {
      currentSettingsState.serial_number[inverterId] = {};
    }
    currentSettingsState.serial_number[inverterId].value = messageContent;
    currentSettingsState.serial_number[inverterId].lastUpdated = new Date();
  }
  else if (specificTopic.includes('/power_saving/')) {
    if (!currentSettingsState.power_saving[inverterId]) {
      currentSettingsState.power_saving[inverterId] = {};
    }
    currentSettingsState.power_saving[inverterId].value = messageContent;
    currentSettingsState.power_saving[inverterId].lastUpdated = new Date();
  }

  currentSettingsState.lastUpdated = new Date();

  // Update system state for key metrics with enhanced tracking
  if (specificTopic.includes('total/battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent);
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
    shouldProcessRules = true;
    
    // Update AI engine system state
    if (aiChargingEngine && aiChargingEngine.updateSystemState) {
      aiChargingEngine.updateSystemState(currentSystemState);
    }
  } else if (specificTopic.includes('total/pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent);
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/load_power')) {
    currentSystemState.load = parseFloat(messageContent);
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent);
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent);
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/battery_power')) { // Add this block
    currentSystemState.battery_power = parseFloat(messageContent);
    shouldProcessRules = true;
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent;
    shouldProcessRules = true;
  }

  // ========= ENHANCED DYNAMIC PRICING INTEGRATION WITH INTELLIGENT INVERTER TYPE SUPPORT =========
  if (topic.includes('battery_state_of_charge') || 
  topic.includes('grid_voltage') || 
  topic.includes('pv_power') ||
  topic.includes('load_power') ||
  topic.includes('battery_power')) {  // Add this line

// Dynamic pricing logic removed
}

  // Batch changes to be processed together for better performance
  const settingsChanges = [];

  // Check if this topic is in our monitored settings with enhanced detection
  let matchedSetting = null;
  
  try {
    // Check for legacy settings first
    if (specificTopic.includes('grid_charge')) {
      matchedSetting = 'grid_charge';
    } else if (specificTopic.includes('energy_pattern')) {
      matchedSetting = 'energy_pattern';
    } 
    // Check for new inverter settings
    else if (specificTopic.includes('charger_source_priority')) {
      matchedSetting = 'charger_source_priority';
    } else if (specificTopic.includes('output_source_priority')) {
      matchedSetting = 'output_source_priority';
    } 
    // Check for other settings
    else if (specificTopic.includes('voltage_point')) {
      matchedSetting = 'voltage_point';
    } else if (specificTopic.includes('max_discharge_current')) {
      matchedSetting = 'max_discharge_current';
    } else if (specificTopic.includes('max_charge_current')) {
      matchedSetting = 'max_charge_current';
    } else if (specificTopic.includes('max_grid_charge_current')) {
      matchedSetting = 'max_grid_charge_current';
    } else if (specificTopic.includes('max_generator_charge_current')) {
      matchedSetting = 'max_generator_charge_current';
    } else if (specificTopic.includes('battery_float_charge_voltage')) {
      matchedSetting = 'battery_float_charge_voltage';
    } else if (specificTopic.includes('battery_absorption_charge_voltage')) {
      matchedSetting = 'battery_absorption_charge_voltage';
    } else if (specificTopic.includes('battery_equalization_charge_voltage')) {
      matchedSetting = 'battery_equalization_charge_voltage';
    } else if (specificTopic.includes('remote_switch')) {
      matchedSetting = 'remote_switch';
    } else if (specificTopic.includes('generator_charge')) {
      matchedSetting = 'generator_charge';
    } else if (specificTopic.includes('force_generator_on')) {
      matchedSetting = 'force_generator_on';
    } else if (specificTopic.includes('output_shutdown_voltage')) {
      matchedSetting = 'output_shutdown_voltage';
    } else if (specificTopic.includes('stop_battery_discharge_voltage')) {
      matchedSetting = 'stop_battery_discharge_voltage';
    } else if (specificTopic.includes('start_battery_discharge_voltage')) {
      matchedSetting = 'start_battery_discharge_voltage';
    } else if (specificTopic.includes('start_grid_charge_voltage')) {
      matchedSetting = 'start_grid_charge_voltage';
    } else if (specificTopic.includes('work_mode') && !specificTopic.includes('work_mode_timer')) {
      matchedSetting = 'work_mode';
    } else if (specificTopic.includes('solar_export_when_battery_full')) {
      matchedSetting = 'solar_export_when_battery_full';
    } else if (specificTopic.includes('max_sell_power')) {
      matchedSetting = 'max_sell_power';
    } else if (specificTopic.includes('max_solar_power')) {
      matchedSetting = 'max_solar_power';
    } else if (specificTopic.includes('grid_trickle_feed')) {
      matchedSetting = 'grid_trickle_feed';
    } else {
      for (const setting of settingsToMonitor) {
        if (specificTopic.includes(setting)) {
          matchedSetting = setting;
          break;
        }
      }
    }
    
    if (matchedSetting && previousSettings[specificTopic] !== messageContent) {
      const changeData = {
        timestamp: new Date(),
        topic: specificTopic,
        old_value: previousSettings[specificTopic],
        new_value: messageContent,
        system_state: { ...currentSystemState },
        change_type: matchedSetting,
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      settingsChanges.push(changeData);
      previousSettings[specificTopic] = messageContent;
      shouldProcessRules = true;
    }
  } catch (error) {
    console.error('Error handling enhanced MQTT message with inverter type support:', error.message);
  }

  if (settingsChanges.length > 0 && dbConnected) {
    try {
      queueSettingsChanges(settingsChanges);
    } catch (error) {
      console.error('Error queuing enhanced settings changes:', error.message);
      retryDatabaseConnection();
    }
  }

  if (shouldProcessRules) {
    try {
      debouncedProcessRules();
    } catch (error) {
      console.error('Error processing enhanced rules with inverter type support:', error.message);
    }
  }
}

// Create a settings changes queue with rate limiting
const settingsChangesQueue = [];
const MAX_QUEUE_SIZE = 100;
let processingQueue = false;
const PROCESSING_INTERVAL = 1000;

function queueSettingsChanges(changes) {
  if (settingsChangesQueue.length + changes.length > MAX_QUEUE_SIZE) {
    console.warn(`Settings changes queue exceeding limit (${MAX_QUEUE_SIZE}). Dropping oldest items.`);
    const totalToKeep = MAX_QUEUE_SIZE - changes.length;
    if (totalToKeep > 0) {
      settingsChangesQueue.splice(0, settingsChangesQueue.length - totalToKeep);
    } else {
      settingsChangesQueue.length = 0;
    }
  }
  
  settingsChangesQueue.push(...changes);
  
  if (!processingQueue) {
    processingQueue = true;
    setTimeout(processSettingsChangesQueue, 50);
  }
}

class Mutex {
  constructor() {
    this.locked = false;
    this.queue = [];
  }

  async acquire() {
    return new Promise(resolve => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      nextResolve();
    } else {
      this.locked = false;
    }
  }
}

const dbMutex = new Mutex();

function executeWithDbMutex(operation) {
  // Since better-sqlite3 is synchronous, we don't need complex async mutex
  // Just execute directly
  try {
    return operation();
  } catch (error) {
    console.error('Error in database operation:', error.message);
    throw error;
  }
}

async function processSettingsChangesQueue() {
  if (settingsChangesQueue.length === 0) {
    processingQueue = false;
    return;
  }

  try {
    const batchSize = Math.min(20, settingsChangesQueue.length); // Smaller batches
    const currentBatch = settingsChangesQueue.splice(0, batchSize);
    
    if (dbConnected) {
      await batchSaveSettingsChanges(currentBatch);
      await pruneOldSettingsChanges();
    }
    
    if (settingsChangesQueue.length > 0) {
      setTimeout(processSettingsChangesQueue, PROCESSING_INTERVAL);
    } else {
      processingQueue = false;
    }
  } catch (error) {
    console.error('Error processing settings changes queue:', error.message);
    processingQueue = false; // ✅ Reset the flag
    setTimeout(() => {
      processSettingsChangesQueue(); // ✅ Retry after delay
    }, PROCESSING_INTERVAL * 2);
  }
}

async function batchSaveSettingsChanges(changes) {
  if (changes.length === 0) return;
  
  try {
    const points = changes.map(changeData => ({
      measurement: 'settings_changes',
      tags: {
        topic: changeData.topic,
        change_type: changeData.change_type,
        user_id: changeData.user_id,
        mqtt_username: changeData.mqtt_username
      },
      fields: {
        old_value: String(changeData.old_value || ''),
        new_value: String(changeData.new_value || ''),
        system_state: JSON.stringify(changeData.system_state || {})
      },
      timestamp: changeData.timestamp
    }));
    
    await influx.writePoints(points);
    return true;
  } catch (error) {
    console.error('Error batch saving settings changes to InfluxDB:', error.message);
    return false;
  }
}

const API_REQUEST_LIMIT = new Map();
const MAX_RATE_LIMIT_ENTRIES = 200;

function canMakeRequest(endpoint, userId, clientIp) {
  // Create a composite key using both user ID and IP for better security
  const key = `${endpoint}:${userId}:${clientIp || 'unknown'}`;
  const now = Date.now();
  
  // Clean old entries periodically to prevent memory leaks
  if (API_REQUEST_LIMIT.size > MAX_RATE_LIMIT_ENTRIES) {
    const cutoff = now - (API_REQUEST_INTERVAL * 10);
    for (const [k, v] of API_REQUEST_LIMIT.entries()) {
      if (v < cutoff) {
        API_REQUEST_LIMIT.delete(k);
      }
    }
  }
  
  if (!API_REQUEST_LIMIT.has(key)) {
    API_REQUEST_LIMIT.set(key, now);
    return true;
  }
  
  const timeSinceLastRequest = now - API_REQUEST_LIMIT.get(key);
  if (timeSinceLastRequest < API_REQUEST_INTERVAL) {
    return false;
  }
  
  API_REQUEST_LIMIT.set(key, now);
  return true;
}

function apiRateLimiter(req, res, next) {
  const endpoint = req.originalUrl.split('?')[0];
  const userId = USER_ID;

  // Skip rate limiting for rules API endpoints
  if (endpoint.includes('/api/rules')) {
    return next();
  }

  // Get client IP safely
  const clientIp = req.ip || 
    req.get('x-forwarded-for')?.split(',')[0]?.trim() || 
    req.get('x-real-ip') || 
    req.connection?.remoteAddress || 
    'unknown';
  
  if (!canMakeRequest(endpoint, userId, clientIp)) {
    console.warn(`API rate limit exceeded for ${clientIp} on ${endpoint}`);
    return res.status(429).json({
      error: 'Too many requests, please try again later.',
      retryAfter: Math.ceil(API_REQUEST_INTERVAL / 1000)
    });
  }
  
  next();
}

const debouncedProcessRules = (() => {
  let timeout = null;
  let pendingRuleProcess = false;
  let lastProcessTime = 0;
  const MIN_INTERVAL = 5000;
  
  return function() {
    if (timeout) {
      clearTimeout(timeout);
    }
    
    const now = Date.now();
    
    if (now - lastProcessTime < MIN_INTERVAL) {
      timeout = setTimeout(() => {
        pendingRuleProcess = false;
        debouncedProcessRules();
      }, MIN_INTERVAL - (now - lastProcessTime));
      return;
    }
    
    if (pendingRuleProcess) {
      return;
    }
    
    pendingRuleProcess = true;
    lastProcessTime = now;
    
    processRules().catch(error => {
      console.error('Error in rule processing:', error);
    }).finally(() => {
      timeout = setTimeout(() => {
        pendingRuleProcess = false;
      }, 1000);
    });
  };
})();

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
    return 'Europe/Berlin'
  }
}

function setCurrentTimezone(timezone) {
  fs.writeFileSync(timezonePath, JSON.stringify({ timezone }))
}

let currentTimezone = getCurrentTimezone()

function getSelectedZone(req) {
    if (req.query.zone) {
      return req.query.zone;
    }
    return null;
  }

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
    const batteryPatterns = [
      new RegExp(`${mqttTopicPrefix}/battery_\\d+/`),
      new RegExp(`${mqttTopicPrefix}/battery/`),
      new RegExp(`${mqttTopicPrefix}/total/battery`),
      new RegExp(`${mqttTopicPrefix}/\\w+/battery`),
    ]
  
    const hasBatteryInfo = messages.some((message) =>
      batteryPatterns.some((pattern) => pattern.test(message))
    )
  
    if (!hasBatteryInfo) {
      return 'Warning: No battery information found in recent messages.'
    }
  
    return null
  }
  
  function debugBatteryMessages(messages) {
    const batteryMessages = messages.filter((msg) =>
      msg.toLowerCase().includes('battery')
    )
    return batteryMessages
  }

// ================ GRAFANA  ================

const DASHBOARD_CONFIG_PATH = path.join(__dirname, 'grafana', 'provisioning', 'dashboards', 'solar_power_dashboard.json');

app.get('/api/solar-data', (req, res) => {
  try {
      const dashboardData = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
      
      const solarData = {};
      
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

app.post('/api/update-panel-config', (req, res) => {
  try {
      const { panelId, min, max, thresholds } = req.body;
      
      if (typeof min !== 'number' || typeof max !== 'number') {
          return res.status(400).json({
              success: false,
              message: 'Min and max values must be numbers'
          });
      }
      
      const dashboardData = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
      
      const panel = dashboardData.panels.find(p => p.id.toString() === panelId);
      
      if (!panel) {
          return res.status(404).json({ 
              success: false, 
              message: `Panel with ID ${panelId} not found` 
          });
      }
      
      if (!panel.fieldConfig) panel.fieldConfig = {};
      if (!panel.fieldConfig.defaults) panel.fieldConfig.defaults = {};
      
      panel.fieldConfig.defaults.min = min;
      panel.fieldConfig.defaults.max = max;
      
      if (thresholds && Array.isArray(thresholds)) {
          if (!panel.fieldConfig.defaults.thresholds) {
              panel.fieldConfig.defaults.thresholds = { mode: 'absolute', steps: [] };
          }
          
          panel.fieldConfig.defaults.thresholds.steps = thresholds.map((threshold, index) => {
              return {
                  color: threshold.color,
                  value: index === 0 ? null : threshold.value
              };
          });
      }
      
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

function getGrafanaHost(req) {
  const host = req.get('host') || 'localhost:6789';
  const hostWithoutPort = host.split(':')[0];
  return hostWithoutPort;
}




// ================ AUTOMATIC PRICE DATA REFRESH ================

// Schedule automatic price data refresh every hour
cron.schedule('0 * * * *', () => {
  console.log('🔄 Running hourly price data refresh...');
  refreshPricingData();
});

// Memory cleanup every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('🧹 Running memory cleanup...');
  cleanupCurrentSettingsState();
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
  
  // Log memory usage
  const used = process.memoryUsage();
  const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;
  console.log(`📊 Memory: RSS: ${mb(used.rss)}MB, Heap: ${mb(used.heapUsed)}MB`);
});

// Initial price data refresh on startup
setTimeout(() => {
  console.log('🚀 Initial price data refresh on startup...');
  refreshPricingData();
}, 5000);

// ================ ROUTERS ================



app.get('/', async (req, res) => {
  const grafanaHost = getGrafanaHost(req);

  const expectedInverters = parseInt(options.inverter_number) || 1
  const inverterWarning = checkInverterMessages(
    incomingMessages,
    expectedInverters)

  const batteryWarning = checkBatteryInformation(incomingMessages)
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    const selectedZone = settings.selectedZone;
    
    if (!selectedZone) {
      return res.redirect('/settings?message=Please configure your zone first');
    }
    
    let historyData = [];
    // Fetch the same data arrays as analytics page
    let loadPowerData = [], pvPowerData = [], batteryStateOfChargeData = [], 
        batteryPowerData = [], gridPowerData = [], gridVoltageData = [];
    let isLoading = false;
    let error = null;
    
    try {
      const cacheKey = selectedZone;
      const isCached = carbonIntensityCacheByZone.has(cacheKey) && 
                      (Date.now() - carbonIntensityCacheByZone.get(cacheKey).timestamp < CACHE_DURATION);
      
      if (isCached) {
        historyData = carbonIntensityCacheByZone.get(cacheKey).data;
      } else {
        isLoading = true;
      }
      
      // Use the same data fetching as analytics page
      [loadPowerData, pvPowerData, batteryStateOfChargeData, batteryPowerData, gridPowerData, gridVoltageData] = await Promise.all([
        queryInfluxDB(`${mqttTopicPrefix}/total/load_energy/state`),
        queryInfluxDB(`${mqttTopicPrefix}/total/pv_energy/state`),
        queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_in/state`),
        queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_out/state`),
        queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_in/state`),
        queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_out/state`)
      ]);
      
      if (!isCached) {
        historyData = await fetchCarbonIntensityHistory(selectedZone);
        isLoading = false;
      }
    } catch (e) {
      console.error('Error fetching data:', e);
      error = 'Error fetching data. Please try again later.';
      isLoading = false;
    }
    
    // Use the updated emissions calculation function
    const emissionsData = calculateEmissionsForPeriod(historyData, loadPowerData, pvPowerData, batteryStateOfChargeData, batteryPowerData, gridPowerData, gridVoltageData);
    
    const todayData = emissionsData.length > 0 ? emissionsData[emissionsData.length - 1] : {
      date: moment().format('YYYY-MM-DD'),
      unavoidableEmissions: 0,
      avoidedEmissions: 0,
      selfSufficiencyScore: 0,
      gridEnergy: 0,
      solarEnergy: 0,
      carbonIntensity: 0
    };
    
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
    
    res.render('energy-dashboard', {
      selectedZone,
      todayData: {
        ...todayData,
        date: moment().format('YYYY-MM-DD')
      },
      summaryData,
      isLoading,
      error,
      ingress_path: process.env.INGRESS_PATH || '',
      grafanaHost: grafanaHost,  
      inverterWarning,
      batteryWarning,
      batteryMessages: debugBatteryMessages(incomingMessages),
      username: options.mqtt_username || 'User'
    });
  } catch (error) {
    console.error('Error rendering welcome page:', error);
    res.status(500).render('error', { error: 'Error loading welcome page' });
  }
});

app.get('/api/hassio_ingress/:token/energy-dashboard', (req, res) => {
  // Redirect to simplified handler
  req.url = '/energy-dashboard';
  app._router.handle(req, res);
});

app.get('/hassio_ingress/:token/energy-dashboard', (req, res) => {
  // Redirect to simplified handler
  req.url = '/energy-dashboard';
  app._router.handle(req, res);
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
        zones,
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
        selectedZone
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
  
      let historyData = [];
      // Use the same data arrays as analytics page
      let loadPowerData = [], pvPowerData = [], batteryStateOfChargeData = [], 
          batteryPowerData = [], gridPowerData = [], gridVoltageData = [];
      let error = null;
      let isLoading = false;
  
      if (selectedZone) {
        try {
          const cacheKey = `${selectedZone}`;
          const isCached = carbonIntensityCacheByZone.has(cacheKey) && 
                           (Date.now() - carbonIntensityCacheByZone.get(cacheKey).timestamp < CACHE_DURATION);
  
          if (isCached) {
            historyData = carbonIntensityCacheByZone.get(cacheKey).data;
          } else {
            isLoading = true;
          }
  
          // Use the same data fetching as analytics page
          [loadPowerData, pvPowerData, batteryStateOfChargeData, batteryPowerData, gridPowerData, gridVoltageData] = await Promise.all([
            queryInfluxDB(`${mqttTopicPrefix}/total/load_energy/state`),
            queryInfluxDB(`${mqttTopicPrefix}/total/pv_energy/state`),
            queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_in/state`),
            queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_out/state`),
            queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_in/state`),
            queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_out/state`)
          ]);
  
          if (!isCached) {
            historyData = await fetchCarbonIntensityHistory(selectedZone);
            carbonIntensityCacheByZone.set(cacheKey, { data: historyData, timestamp: Date.now() });
            isLoading = false;
          }
        } catch (e) {
          console.error('Error fetching data:', e);
          error = 'Error fetching data. Please try again later.';
          isLoading = false;
        }
      }
  
      const currentDate = moment().format('YYYY-MM-DD');
  
      // Use the updated emissions calculation function
      const emissionsData = calculateEmissionsForPeriod(historyData, loadPowerData, pvPowerData, batteryStateOfChargeData, batteryPowerData, gridPowerData, gridVoltageData);
  
      if (emissionsData.length > 0) {
        emissionsData[emissionsData.length - 1].date = currentDate;
      }
  
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
  
      const periods = {
        today: [todayData],
        week: emissionsData.slice(-7),
        month: emissionsData.slice(-30),
        quarter: emissionsData.slice(-90),
        year: emissionsData
      };
  
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
      console.error('Server error:', error);
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
      
      // Get Tibber configuration and status
      const config = tibberService.config;
      const status = tibberService.getStatus();
      const aiStatus = aiChargingEngine.getStatus();
      
      res.render('settings', { 
        settings,
        ingress_path: process.env.INGRESS_PATH || '',
        zones: zonesResponse.zones,
        message: req.query.message,
        error: zonesResponse.error,
        // Tibber data - using names that match the EJS template
        config: { 
          ...config, 
          apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : '' 
        },
        status,
        aiStatus
      });
    } catch (error) {
      res.status(500).render('error', { error: 'Error loading settings' });
    }
  });
  
  app.post('/settings', async (req, res) => {
    try {
      const { timezone, apiKey, selectedZone } = req.body;
      
      let currentSettings = {};
      try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        currentSettings = JSON.parse(settingsData);
      } catch (err) {
        currentSettings = {
          apiKey: '',
          selectedZone: '',
          timezone: ''
        };
      }
      
      const settings = {
        apiKey: apiKey !== undefined ? apiKey : currentSettings.apiKey,
        selectedZone: selectedZone !== undefined ? selectedZone : currentSettings.selectedZone,
        timezone: timezone !== undefined ? timezone : currentSettings.timezone
      };
  
      if (!settings.selectedZone && !settings.apiKey) {
        return res.status(400).json({
          success: false,
          error: 'At least one of API key or zone must be provided'
        });
      }
  
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  
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
    const grafanaHost = getGrafanaHost(req);
    
    console.log(`Chart route - grafanaHost: ${grafanaHost}`);
    
    res.render('chart', {
      ingress_path: process.env.INGRESS_PATH || '',
      grafanaHost: grafanaHost,
    });
  });

  app.get('/api/hassio_ingress/:token/chart', (req, res) => {
    // Redirect to simplified handler
    req.url = '/chart';
    app._router.handle(req, res);
  });
  
  app.get('/hassio_ingress/:token/chart', (req, res) => {
    // Redirect to simplified handler
    req.url = '/chart';
    app._router.handle(req, res);
  });

  // AI Dashboard route
  app.get('/ai-dashboard', async (req, res) => {
    try {
      res.render('ai-dashboard', {
        ingress_path: process.env.INGRESS_PATH || '',
        user_id: USER_ID,
        learner_active: learnerModeActive,
        db_connected: dbConnected,
        mqtt_connected: mqttClient ? mqttClient.connected : false,
        system_state: currentSystemState,
        ai_status: aiChargingEngine.getStatus(),
        tibber_status: tibberService.getStatus()
      });
    } catch (error) {
      console.error('Error rendering AI dashboard:', error);
      res.status(500).send('Error loading AI dashboard');
    }
  });

  app.get('/api/hassio_ingress/:token/ai-dashboard', (req, res) => {
    req.url = '/ai-dashboard';
    app._router.handle(req, res);
  });
  
  app.get('/hassio_ingress/:token/ai-dashboard', (req, res) => {
    req.url = '/ai-dashboard';
    app._router.handle(req, res);
  });


  app.get('/api/carbon-intensity/:zone', async (req, res) => {
    try {
      const { zone } = req.params;
      if (!zone) {
        return res.status(400).json({ error: 'Zone parameter is required' });
      }
      
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
      
      res.json({ 
        status: 'fetching',
        message: 'Data is being fetched. Please try again in a moment.'
      });
      
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

  // AI Dashboard API endpoints
  app.get('/api/ai/status', (req, res) => {
    try {
      const aiStatus = aiChargingEngine.getStatus();
      const tibberStatus = tibberService.getStatus();
      
      res.json({
        success: true,
        ai: aiStatus,
        tibber: tibberStatus,
        learner_mode: learnerModeActive,
        system_state: currentSystemState
      });
    } catch (error) {
      console.error('Error getting AI status:', error);
      res.status(500).json({ error: 'Failed to get AI status' });
    }
  });

  app.get('/api/ai/decisions', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const decisions = aiChargingEngine.getDecisionHistory(limit);
      
      res.json({
        success: true,
        decisions: decisions
      });
    } catch (error) {
      console.error('Error getting AI decisions:', error);
      res.status(500).json({ error: 'Failed to get AI decisions' });
    }
  });

  app.get('/api/ai/predictions', (req, res) => {
    try {
      const predictions = aiChargingEngine.getPredictedChargeWindows();
      
      res.json({
        success: true,
        predictions: predictions
      });
    } catch (error) {
      console.error('Error getting AI predictions:', error);
      res.status(500).json({ error: 'Failed to get AI predictions' });
    }
  });

  app.get('/api/ai/commands', (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const commands = aiChargingEngine.getCommandHistory(limit);
      
      res.json({
        success: true,
        commands: commands
      });
    } catch (error) {
      console.error('Error getting AI commands:', error);
      res.status(500).json({ error: 'Failed to get AI commands' });
    }
  });

  app.get('/api/tibber/current', (req, res) => {
    try {
      const tibberData = tibberService.getCachedData();
      
      res.json({
        success: true,
        data: tibberData
      });
    } catch (error) {
      console.error('Error getting Tibber data:', error);
      res.status(500).json({ error: 'Failed to get Tibber data' });
    }
  });

  app.post('/api/tibber/refresh', async (req, res) => {
    try {
      const success = await tibberService.refreshData();
      
      res.json({
        success: success,
        message: success ? 'Price data refreshed successfully' : 'Failed to refresh price data',
        data: success ? tibberService.getCachedData() : null
      });
    } catch (error) {
      console.error('Error refreshing Tibber data:', error);
      res.status(500).json({ error: 'Failed to refresh price data' });
    }
  });

  // AI Engine Control Endpoints
  app.post('/api/ai/start', (req, res) => {
    try {
      if (!aiChargingEngine) {
        return res.status(500).json({ error: 'AI Charging Engine not available' });
      }
      
      aiChargingEngine.start();
      
      res.json({
        success: true,
        message: 'AI Charging Engine started successfully',
        status: aiChargingEngine.getStatus()
      });
    } catch (error) {
      console.error('Error starting AI engine:', error);
      res.status(500).json({ error: 'Failed to start AI engine' });
    }
  });

  app.post('/api/ai/stop', (req, res) => {
    try {
      if (!aiChargingEngine) {
        return res.status(500).json({ error: 'AI Charging Engine not available' });
      }
      
      aiChargingEngine.stop();
      
      res.json({
        success: true,
        message: 'AI Charging Engine stopped successfully',
        status: aiChargingEngine.getStatus()
      });
    } catch (error) {
      console.error('Error stopping AI engine:', error);
      res.status(500).json({ error: 'Failed to stop AI engine' });
    }
  });

  app.post('/api/ai/toggle', (req, res) => {
    try {
      if (!aiChargingEngine) {
        return res.status(500).json({ error: 'AI Charging Engine not available' });
      }
      
      const currentStatus = aiChargingEngine.getStatus();
      
      if (currentStatus.running) {
        aiChargingEngine.stop();
      } else {
        aiChargingEngine.start();
      }
      
      const newStatus = aiChargingEngine.getStatus();
      
      res.json({
        success: true,
        message: `AI Charging Engine ${newStatus.running ? 'started' : 'stopped'} successfully`,
        status: newStatus
      });
    } catch (error) {
      console.error('Error toggling AI engine:', error);
      res.status(500).json({ error: 'Failed to toggle AI engine' });
    }
  });
  
  // ================ CARBON INTENSITY ================
  
  const carbonIntensityCacheByZone = new Map();
  
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
    
    const batchSize = 30;
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
              return { history: [] };
            })
        );
      }
  
      try {
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach((data, index) => {
          if (data.history && data.history.length > 0) {
            historyData.push({
              date: m.clone().add(index, 'days').format('YYYY-MM-DD'),
              carbonIntensity: data.history[0].carbonIntensity
            });
          }
        });
        
        if (m.clone().add(batchSize, 'days').isBefore(today)) {
          await delay(500);
        }
      } catch (error) {
        console.error('Error fetching batch data:', error);
      }
    }
  
    console.timeEnd('Carbon intensity data fetch');
  
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
  
  function calculateEmissionsForPeriod(
    historyData,
    loadPowerData,
    pvPowerData, 
    batteryStateOfChargeData,
    batteryPowerData,
    gridPowerData,
    gridVoltageData
  ) {
    if (!historyData || !historyData.length || !gridPowerData || !pvPowerData) {
      console.log("Missing required data arrays for emissions calculation");
      return [];
    }
  
    console.log(`History data length: ${historyData.length}, Grid data length: ${gridPowerData.length}, PV data length: ${pvPowerData.length}`);
  
    return historyData.map((dayData, index) => {
      const carbonIntensity = dayData.carbonIntensity || 0;
      const currentGridVoltage = gridVoltageData[index]?.value || 0;
  
      const historyDate = new Date(dayData.date).toISOString().split('T')[0];
  
      // Find the exact same index as analytics table uses
      let dataIndex = -1;
      for (let i = 0; i < loadPowerData.length; i++) {
        const entryDate = new Date(loadPowerData[i].time).toISOString().split('T')[0];
        if (entryDate === historyDate) {
          dataIndex = i;
          break;
        }
      }
  
      if (dataIndex === -1 || dataIndex === 0) {
        // No data found or first entry, use current values
        return {
          date: dayData.date,
          carbonIntensity: carbonIntensity,
          gridVoltage: currentGridVoltage,
          gridEnergy: gridPowerData[index]?.value || 0,
          solarEnergy: pvPowerData[index]?.value || 0,
          unavoidableEmissions: ((gridPowerData[index]?.value || 0) * carbonIntensity) / 1000,
          avoidedEmissions: ((pvPowerData[index]?.value || 0) * carbonIntensity) / 1000,
          selfSufficiencyScore: 0,
        };
      }
  
      // Apply the EXACT same logic as analytics table
      const i = dataIndex;
      
      // Get current and previous day values (same variable names as analytics)
      const currentLoadPower = parseFloat(loadPowerData[i]?.value || '0.0');
      const previousLoadPower = parseFloat(loadPowerData[i - 1]?.value || '0.0');
      
      const currentPvPower = parseFloat(pvPowerData[i]?.value || '0.0');
      const previousPvPower = parseFloat(pvPowerData[i - 1]?.value || '0.0');
      
      const currentBatteryCharged = parseFloat(batteryStateOfChargeData[i]?.value || '0.0');
      const previousBatteryCharged = parseFloat(batteryStateOfChargeData[i - 1]?.value || '0.0');
      
      const currentBatteryDischarged = parseFloat(batteryPowerData[i]?.value || '0.0');
      const previousBatteryDischarged = parseFloat(batteryPowerData[i - 1]?.value || '0.0');
      
      const currentGridUsed = parseFloat(gridPowerData[i]?.value || '0.0');
      const previousGridUsed = parseFloat(gridPowerData[i - 1]?.value || '0.0');
      
      const currentGridExported = parseFloat(gridVoltageData[i]?.value || '0.0');
      const previousGridExported = parseFloat(gridVoltageData[i - 1]?.value || '0.0');
      
      // Check if all current values are greater than previous values
      // AND also check if all previous values are not zero (EXACT same condition as analytics)
      const allGreaterThanPrevious = 
          previousLoadPower > 0 && currentLoadPower > previousLoadPower &&
          previousPvPower > 0 && currentPvPower > previousPvPower &&
          previousBatteryCharged > 0 && currentBatteryCharged > previousBatteryCharged &&
          previousBatteryDischarged > 0 && currentBatteryDischarged > previousBatteryDischarged &&
          previousGridUsed > 0 && currentGridUsed > previousGridUsed &&
          previousGridExported > 0 && currentGridExported > previousGridExported;
      
      // Calculate values based on the condition (EXACT same logic as analytics)
      let dailyLoadPower, dailyPvPower, dailyBatteryCharged, 
          dailyBatteryDischarged, dailyGridUsed, dailyGridExported;
      
      if (allGreaterThanPrevious) {
          // If all metrics increased, calculate differences
          dailyLoadPower = currentLoadPower - previousLoadPower;
          dailyPvPower = currentPvPower - previousPvPower;
          dailyBatteryCharged = currentBatteryCharged - previousBatteryCharged;
          dailyBatteryDischarged = currentBatteryDischarged - previousBatteryDischarged;
          dailyGridUsed = currentGridUsed - previousGridUsed;
          dailyGridExported = currentGridExported - previousGridExported;
      } else {
          // Otherwise, use current values as is
          dailyLoadPower = currentLoadPower;
          dailyPvPower = currentPvPower;
          dailyBatteryCharged = currentBatteryCharged;
          dailyBatteryDischarged = currentBatteryDischarged;
          dailyGridUsed = currentGridUsed;
          dailyGridExported = currentGridExported;
      }
  
      // Calculate emissions using the same daily values as analytics
      const unavoidableEmissions = (dailyGridUsed * carbonIntensity) / 1000;
      const avoidedEmissions = (dailyPvPower * carbonIntensity) / 1000;
      const totalEnergy = dailyGridUsed + dailyPvPower;
      const selfSufficiencyScore = totalEnergy > 0 ? (dailyPvPower / totalEnergy) * 100 : 0;
  
      return {
        date: dayData.date,
        carbonIntensity: carbonIntensity,
        gridVoltage: currentGridVoltage,
        gridEnergy: dailyGridUsed,
        solarEnergy: dailyPvPower,
        unavoidableEmissions: unavoidableEmissions,
        avoidedEmissions: avoidedEmissions,
        selfSufficiencyScore: selfSufficiencyScore,
      };
    });
  }
  
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
  
  let heartbeatInterval = null;
  
  const connectToWebSocketBroker = async () => {
    let wsClient = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const reconnectTimeout = 5000;
  
    const startHeartbeat = (client) => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      
      heartbeatInterval = setInterval(() => {
        if (client && client.readyState === WebSocket.OPEN) {
          try {
            client.send(JSON.stringify({ type: 'ping' }));
          } catch (error) {
            console.error('Error sending heartbeat:', error.message);
            stopHeartbeat();
          }
        } else {
          stopHeartbeat();
        }
      }, 30000);
    };
  
    const stopHeartbeat = () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    };
  
    const connect = async () => {
      if (reconnectAttempts >= maxReconnectAttempts) {
        console.log(`Reached maximum reconnection attempts (${maxReconnectAttempts}). Disabling WebSocket broker.`);
        return;
      }
      
      reconnectAttempts++;
      
      const currentReconnectTimeout = reconnectAttempts > 3 ? 
        reconnectTimeout * Math.pow(2, Math.min(reconnectAttempts - 3, 5)) : 
        reconnectTimeout;
      
        if (wsClient) {
          try {
            stopHeartbeat();
            
            // Set ready state to closing to prevent new messages
            if (wsClient.readyState === WebSocket.OPEN) {
              wsClient.close(1000, 'Normal closure');
            }
            
            // Remove all listeners
            wsClient.removeAllListeners();
            
            // Give it a moment to close gracefully, then terminate
            setTimeout(() => {
              if (wsClient.readyState !== WebSocket.CLOSED) {
                wsClient.terminate();
              }
            }, 1000);
            
            wsClient = null;
          } catch (e) {
            console.error('Error cleaning up WebSocket connection:', e);
          }
        }
      
      try {
        console.log(`Attempting WebSocket connection (attempt ${reconnectAttempts}/${maxReconnectAttempts})...`);
        
        const brokerServerUrl = `wss://broker.carbonoz.com:8000`;
        
        wsClient = new WebSocket(brokerServerUrl);
  
        const connectionTimeout = setTimeout(() => {
          if (wsClient && wsClient.readyState !== WebSocket.OPEN) {
            console.log('WebSocket connection timeout. Closing and retrying...');
            try {
              wsClient.terminate();
            } catch (e) {
              console.log('Error terminating timed-out connection:', e.message);
            }
          }
        }, 15000);
        
        wsClient.on('open', async () => {
          console.log('Connected to WebSocket broker');
          clearTimeout(connectionTimeout);
          
          reconnectAttempts = 0;
          
          try {
            const isUser = await AuthenticateUser(options);
            console.log('Authentication Result:', { isUser });
  
            if (isUser) {
              startHeartbeat(wsClient);
  
              mqttClient.on('message', (topic, message) => {
                if (wsClient.readyState === WebSocket.OPEN) {
                  try {
                    const messageStr = message.toString();
                    const maxSize = 10000;
                    const truncatedMessage = messageStr.length > maxSize ? 
                      messageStr.substring(0, maxSize) + '...[truncated]' : 
                      messageStr;
                    
                    wsClient.send(
                      JSON.stringify({
                        mqttTopicPrefix,
                        topic,
                        message: truncatedMessage,
                        userId: isUser,
                        timestamp: new Date().toISOString()
                      })
                    );
                  } catch (sendError) {
                    console.error('Error sending message to WebSocket:', sendError);
                  }
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
          clearTimeout(connectionTimeout);
          console.error('WebSocket Error:', error.message);
          stopHeartbeat();
        });
  
        wsClient.on('close', (code, reason) => {
          clearTimeout(connectionTimeout);
          console.log(`WebSocket closed with code ${code}: ${reason || 'No reason provided'}. Reconnecting...`);
          stopHeartbeat();
          
          setTimeout(connect, currentReconnectTimeout);
        });
  
      } catch (error) {
        console.error('Connection setup error:', error.message);
        setTimeout(connect, currentReconnectTimeout);
      }
    };
  
    connect();
    
    return {
      resetConnectionAttempts: () => {
        reconnectAttempts = 0;
        console.log('WebSocket broker connection attempts reset');
      }
    };
  };
  
  // ================ AUTOMATION RULES ENGINE ================
  
  let _cachedTimeCheck = null;
  
  function isWithinTimeRange(startTime, endTime) {
    if (!startTime || !endTime) return true;
    
    if (!_cachedTimeCheck) {
      _cachedTimeCheck = {
        time: moment().tz(currentTimezone),
        lastUpdated: Date.now()
      };
    } else if (Date.now() - _cachedTimeCheck.lastUpdated > 1000) {
      _cachedTimeCheck = {
        time: moment().tz(currentTimezone),
        lastUpdated: Date.now()
      };
    }
    
    const currentTime = _cachedTimeCheck.time;
    const start = moment.tz(startTime, 'HH:mm', currentTimezone);
    const end = moment.tz(endTime, 'HH:mm', currentTimezone);
    
    if (end.isBefore(start)) {
      return currentTime.isAfter(start) || currentTime.isBefore(end);
    }
    
    return currentTime.isBetween(start, end, null, '[]');
  }
  
  function isAllowedDay(allowedDays) {
    if (!allowedDays || allowedDays.length === 0) return true;
    
    const currentDay = moment().tz(currentTimezone).format('dddd').toLowerCase();
    return allowedDays.includes(currentDay);
  }
  
  function evaluateCondition(condition) {
    const { parameter, operator, value } = condition;
    let currentValue;
    
    switch (parameter) {
      case 'battery_soc':
        currentValue = currentSystemState.battery_soc;
        break;
      case 'pv_power':
        currentValue = currentSystemState.pv_power;
        break;
      case 'load':
        currentValue = currentSystemState.load;
        break;
      case 'grid_voltage':
        currentValue = currentSystemState.grid_voltage;
        break;
      case 'grid_power':
        currentValue = currentSystemState.grid_power;
        break;
      case 'battery_power':  // Add this case
        currentValue = currentSystemState.battery_power;
        break;
      default:
        return false;
    }
    
    if (currentValue === null || currentValue === undefined) {
      return false;
    }
    
    switch (operator) {
      case 'gt':
        return currentValue > value;
      case 'lt':
        return currentValue < value;
      case 'eq':
        return currentValue === value;
      case 'gte':
        return currentValue >= value;
      case 'lte':
        return currentValue <= value;
      default:
        return false;
    }
  }
  
  // ================ ENHANCED RULE APPLICATION WITH INVERTER TYPE DETECTION ================
  
  function applyAction(action) {
    if (!learnerModeActive) {
      return false;
    }
  
    const { setting, value, inverter } = action;
    const inverters = [];
    
    if (inverter === 'all') {
      for (let i = 1; i <= inverterNumber; i++) {
        inverters.push(`inverter_${i}`);
      }
    } else {
      inverters.push(inverter);
    }
    
    // Apply the action to each inverter based on its type
    for (const inv of inverters) {
      const inverterType = getInverterType(inv);
      let topic, mqttValue;
      
      // Handle energy pattern setting
      if (setting === 'energy_pattern') {
        if (inverterType === 'new' || inverterType === 'hybrid') {
          // Use new output_source_priority for new inverters
          const mappedValue = mapEnergyPatternToOutputSourcePriority(value);
          topic = `${mqttTopicPrefix}/${inv}/output_source_priority/set`;
          mqttValue = mappedValue;
          console.log(`Mapping legacy energy_pattern "${value}" to output_source_priority "${mappedValue}" for ${inv} (type: ${inverterType})`);
        } else {
          // Use legacy energy_pattern for legacy inverters
          topic = `${mqttTopicPrefix}/${inv}/energy_pattern/set`;
          mqttValue = value;
        }
      }
      
      // Handle grid charge setting
      else if (setting === 'grid_charge') {
        if (inverterType === 'new' || inverterType === 'hybrid') {
          // Use new charger_source_priority for new inverters
          const mappedValue = mapGridChargeToChargerSourcePriority(value);
          topic = `${mqttTopicPrefix}/${inv}/charger_source_priority/set`;
          mqttValue = mappedValue;
          console.log(`Mapping legacy grid_charge "${value}" to charger_source_priority "${mappedValue}" for ${inv} (type: ${inverterType})`);
        } else {
          // Use legacy grid_charge for legacy inverters
          topic = `${mqttTopicPrefix}/${inv}/grid_charge/set`;
          mqttValue = value;
        }
      }
      
      // Handle new inverter settings directly
      else if (setting === 'charger_source_priority') {
        if (inverterType === 'new' || inverterType === 'hybrid' || inverterType === 'unknown') {
          topic = `${mqttTopicPrefix}/${inv}/charger_source_priority/set`;
          mqttValue = value;
        } else {
          // Map to legacy grid_charge for legacy inverters
          const mappedValue = mapChargerSourcePriorityToGridCharge(value);
          topic = `${mqttTopicPrefix}/${inv}/grid_charge/set`;
          mqttValue = mappedValue;
          console.log(`Mapping charger_source_priority "${value}" to legacy grid_charge "${mappedValue}" for ${inv} (type: ${inverterType})`);
        }
      }
      
      else if (setting === 'output_source_priority') {
        if (inverterType === 'new' || inverterType === 'hybrid' || inverterType === 'unknown') {
          topic = `${mqttTopicPrefix}/${inv}/output_source_priority/set`;
          mqttValue = value;
        } else {
          // Map to legacy energy_pattern for legacy inverters
          const mappedValue = mapOutputSourcePriorityToEnergyPattern(value);
          topic = `${mqttTopicPrefix}/${inv}/energy_pattern/set`;
          mqttValue = mappedValue;
          console.log(`Mapping output_source_priority "${value}" to legacy energy_pattern "${mappedValue}" for ${inv} (type: ${inverterType})`);
        }
      }
      
      // Handle all other existing settings (these work for both inverter types)
      else {
        switch (setting) {
          case 'max_discharge_current':
          case 'max_charge_current':
          case 'max_grid_charge_current':
          case 'max_generator_charge_current':
          case 'battery_float_charge_voltage':
          case 'battery_absorption_charge_voltage':
          case 'battery_equalization_charge_voltage':
          case 'remote_switch':
          case 'generator_charge':
          case 'force_generator_on':
          case 'output_shutdown_voltage':
          case 'stop_battery_discharge_voltage':
          case 'start_battery_discharge_voltage':
          case 'start_grid_charge_voltage':
          case 'work_mode':
          case 'solar_export_when_battery_full':
          case 'max_sell_power':
          case 'max_solar_power':
          case 'grid_trickle_feed':
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
            return false;
        }
      }
      
      // Send the command via MQTT
      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false });
        console.log(`Action applied: ${topic} = ${mqttValue} (inverter type: ${inverterType})`);
      }
    }
    
    return true;
  }
  
  async function processRules() {
    if (!dbConnected) return;
    
    try {
      _cachedTimeCheck = null;
      
      if (Object.keys(currentSystemState).every(key => 
        currentSystemState[key] === null || currentSystemState[key] === undefined)) {
        return;
      }
      
      const triggeredWarnings = warningService.checkWarnings(currentSystemState);
      
      for (const warning of triggeredWarnings) {
        try {
          if (telegramService.shouldNotifyForWarning(warning.warningTypeId)) {
            const message = telegramService.formatWarningMessage(warning, currentSystemState);
            await telegramService.broadcastMessage(message);
            console.log(`User-configured warning notification sent: ${warning.title}`);
          }
        } catch (notifyError) {
          console.error(`Error sending user-configured warning notification for ${warning.title}:`, notifyError);
        }
      }
      
      const rules = await getAllRules(USER_ID, { active: true });
      console.log(`Processing ${rules.length} active rules`);
      
      const rulesToUpdate = [];
      
      const now = moment().tz(currentTimezone);
      const currentDay = now.format('dddd').toLowerCase();
      
      for (const rule of rules) {
        if (rule.active !== true) {
          continue;
        }
        
        if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
          const { days, startTime, endTime } = rule.timeRestrictions;
          
          if (days && days.length > 0 && !days.includes(currentDay)) {
            continue;
          }
          
          if (startTime && endTime && !isWithinTimeRange(startTime, endTime)) {
            continue;
          }
          
          if (rule.timeRestrictions.specificDates && 
              rule.timeRestrictions.specificDates.length > 0) {
            const today = now.format('YYYY-MM-DD');
            if (!rule.timeRestrictions.specificDates.includes(today)) {
              continue;
            }
          }
        }
        
        let allConditionsMet = true;
        
        if (rule.conditions && rule.conditions.length > 0) {
          for (const condition of rule.conditions) {
            if (!evaluateCondition(condition)) {
              allConditionsMet = false;
              break;
            }
          }
        }
        
        if (allConditionsMet) {
          console.log(`Rule "${rule.name}" conditions met, applying actions`);
          
          if (learnerModeActive && rule.actions && rule.actions.length > 0) {
            for (const action of rule.actions) {
              applyAction(action);
            }
          }
          
          rule.lastTriggered = new Date();
          rule.triggerCount = (rule.triggerCount || 0) + 1;
          rulesToUpdate.push(rule);
          
          try {
            if (telegramService.shouldNotifyForRule(rule.id)) {
              const message = telegramService.formatRuleTriggerMessage(rule, currentSystemState);
              await telegramService.broadcastMessage(message);
              console.log(`User-configured rule notification sent: ${rule.name}`);
            }
          } catch (notifyError) {
            console.error(`Error sending user-configured rule notification for ${rule.name}:`, notifyError);
          }
        }
      }
      
      if (rulesToUpdate.length > 0) {
        console.log(`Updating statistics for ${rulesToUpdate.length} triggered rules`);
        await batchUpdateRules(rulesToUpdate);
      }
    } catch (error) {
      console.error('Error processing rules:', error);
    }
  }
  
  function pruneOldSettingsChanges() {
    if (!dbConnected || !jsonStorage) return;
    
    try {
      // JSON storage handles its own cleanup, no manual pruning needed
      console.log('JSON storage handles automatic cleanup');
    } catch (error) {
      console.error('Error in settings cleanup:', error.message);
    }
  }
  


// ================ DYNAMIC RULE CREATION BASED ON INVERTER TYPES ================

function createDefaultRules() {
  if (!dbConnected || !jsonStorage) return;
  
  try {
    const count = countRules(USER_ID);
    
    if (count === 0) {
      console.log('Creating dynamic default rules based on detected inverter types...');
      
      const detectedTypes = analyzeInverterTypes();
      console.log(`Detected inverter environment: ${detectedTypes.summary}`);
      
      const rules = [];
      
      // Rule 1: Adaptive Low Load Management
      if (detectedTypes.hasAny) {
        rules.push({
          name: 'Adaptive Low Load Management',
          description: `When load < 5000W, optimize energy usage (supports ${detectedTypes.summary})`,
          active: false,
          conditions: [{
            parameter: 'load',
            operator: 'lt',
            value: 5000
          }],
          actions: generateAdaptiveActions('energy_optimization', 'Battery first', detectedTypes),
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        });
      }
      
      // Rule 2: Smart Battery Protection
      rules.push({
        name: 'Smart Battery Protection',
        description: `Enable charging when SOC < 20% (auto-adapts to ${detectedTypes.summary})`,
        active: false,
        conditions: [{
          parameter: 'battery_soc',
          operator: 'lt',
          value: 20
        }],
        actions: generateAdaptiveActions('charging', 'Enabled', detectedTypes),
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // Save all rules
      for (const rule of rules) {
        saveRule(rule);
        console.log(`Created rule: ${rule.name}`);
      }
      
      console.log(`Created ${rules.length} dynamic default rules for ${detectedTypes.summary}`);
    }
  } catch (error) {
    console.error('Error creating dynamic default rules:', error.message);
  }
}

function createExtendedAutomationRules() {
  if (!dbConnected || !jsonStorage) return;
  
  try {
    const rules = jsonStorage.getAllRules(USER_ID);
    const count = { count: rules.filter(rule => rule.name.includes('Extended')).length };
    
    if (count.count === 0) {
      console.log('Creating extended automation rules based on inverter types...');
      
      const detectedTypes = analyzeInverterTypes();
      const rules = [];
      
      // Time-based optimization rules
      if (detectedTypes.hasLegacy || detectedTypes.hasHybrid) {
        // Morning optimization for legacy systems
        rules.push({
          name: 'Extended - Morning Energy Optimization',
          description: 'Optimize morning energy usage (legacy compatible)',
          active: false,
          timeRestrictions: {
            startTime: '06:00',
            endTime: '10:00',
            enabled: true
          },
          conditions: [{
            parameter: 'battery_soc',
            operator: 'gt',
            value: 40
          }],
          actions: [{
            setting: 'energy_pattern',
            value: 'Load first',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        });
      }
      
      if (detectedTypes.hasNew || detectedTypes.hasHybrid) {
        // Advanced charging strategies for new inverters
        rules.push({
          name: 'Extended - Smart Charging Strategy',
          description: 'Advanced charging control for new inverters',
          active: false,
          conditions: [
            {
              parameter: 'battery_soc',
              operator: 'lt',
              value: 60
            },
            {
              parameter: 'pv_power',
              operator: 'gt',
              value: 4000
            }
          ],
          actions: [{
            setting: 'charger_source_priority',
            value: 'Solar and utility simultaneously',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        });
        
        // Evening optimization for new inverters
        rules.push({
          name: 'Extended - Evening Battery Priority',
          description: 'Optimize evening energy usage (new inverters)',
          active: false,
          timeRestrictions: {
            startTime: '18:00',
            endTime: '22:00',
            enabled: true
          },
          conditions: [{
            parameter: 'battery_soc',
            operator: 'gt',
            value: 50
          }],
          actions: [{
            setting: 'output_source_priority',
            value: 'Solar/Battery/Utility',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        });
      }
      
      // Universal battery protection
      rules.push({
        name: 'Extended - Deep Discharge Protection',
        description: 'Protect battery from deep discharge (all types)',
        active: false,
        conditions: [{
          parameter: 'battery_soc',
          operator: 'lt',
          value: 25
        }],
        actions: [
          {
            setting: 'max_discharge_current',
            value: '20',
            inverter: 'all'
          },
          ...generateAdaptiveActions('emergency_charge', 'Enabled', detectedTypes)
        ],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // Save all extended rules
      for (const rule of rules) {
        saveRule(rule);
        console.log(`Created extended rule: ${rule.name}`);
      }
      
      console.log(`Created ${rules.length} extended automation rules for ${detectedTypes.summary}`);
    }
  } catch (error) {
    console.error('Error creating extended automation rules:', error.message);
  }
}

function createNightChargingRule() {
  if (!dbConnected || !jsonStorage) return;
  
  try {
    const detectedTypes = analyzeInverterTypes();
    
    // Check if night charging rule exists
    const rules = jsonStorage.getAllRules(USER_ID);
    const existingRule = rules.find(rule => rule.name.startsWith('Night Charging'));
    
    if (!existingRule) {
      const nightRule = {
        name: `Night Charging Strategy (${detectedTypes.primary})`,
        description: `Intelligent night charging for ${detectedTypes.summary}`,
        active: false,
        conditions: [{
          parameter: 'battery_soc',
          operator: 'lt',
          value: 85
        }],
        timeRestrictions: {
          startTime: '23:00',
          endTime: '05:00',
          enabled: true,
          days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        },
        actions: [],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      // Add appropriate actions based on inverter types
      if (detectedTypes.hasNew) {
        nightRule.actions.push({
          setting: 'charger_source_priority',
          value: 'Utility first',
          inverter: 'all'
        });
        nightRule.actions.push({
          setting: 'max_grid_charge_current',
          value: '80',
          inverter: 'all'
        });
      } else {
        nightRule.actions.push({
          setting: 'grid_charge',
          value: 'Enabled',
          inverter: 'all'
        });
      }
      
      saveRule(nightRule);
      console.log('Created dynamic night charging rule');
      
      // Create complementary daytime rule
      const daytimeRule = {
        name: `Daytime Solar Priority (${detectedTypes.primary})`,
        description: `Disable grid charging during day for ${detectedTypes.summary}`,
        active: false,
        timeRestrictions: {
          startTime: '06:00',
          endTime: '22:00',
          enabled: true
        },
        conditions: [{
          parameter: 'pv_power',
          operator: 'gt',
          value: 1000
        }],
        actions: generateAdaptiveActions('solar_priority', 'Disabled', detectedTypes),
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      saveRule(daytimeRule);
      console.log('Created complementary daytime rule');
    }
  } catch (error) {
    console.error('Error creating night charging rules:', error.message);
  }
}

function createWeekendGridChargeRules() {
  if (!dbConnected || !jsonStorage) return;
  
  try {
    const detectedTypes = analyzeInverterTypes();
    
    // Check if weekend rules exist
    const rules = jsonStorage.getAllRules(USER_ID);
    const existingWeekendRule = rules.find(rule => rule.name.includes('Weekend'));
    
    if (!existingWeekendRule) {
      const weekendRules = [];
      
      // Weekend optimization rule
      weekendRules.push({
        name: `Weekend Solar Maximization (${detectedTypes.primary})`,
        description: `Maximize solar usage on weekends for ${detectedTypes.summary}`,
        active: false,
        timeRestrictions: {
          days: ['saturday', 'sunday'],
          enabled: true
        },
        conditions: [{
          parameter: 'pv_power',
          operator: 'gt',
          value: 2000
        }],
        actions: [
          ...generateAdaptiveActions('weekend_solar', 'Disabled', detectedTypes),
          {
            setting: 'solar_export_when_battery_full',
            value: 'Enabled',
            inverter: 'all'
          }
        ],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      // Weekend battery preservation
      if (detectedTypes.hasAny) {
        weekendRules.push({
          name: `Weekend Battery Preservation (${detectedTypes.primary})`,
          description: 'Preserve battery on weekends when solar is available',
          active: false,
          timeRestrictions: {
            days: ['saturday', 'sunday'],
            startTime: '09:00',
            endTime: '17:00',
            enabled: true
          },
          conditions: [
            {
              parameter: 'battery_soc',
              operator: 'gt',
              value: 70
            },
            {
              parameter: 'pv_power',
              operator: 'gt',
              value: 5000
            }
          ],
          actions: generateAdaptiveActions('battery_preserve', 'Load first', detectedTypes),
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        });
      }
      
      // Save weekend rules
      for (const rule of weekendRules) {
        saveRule(rule);
        console.log(`Created weekend rule: ${rule.name}`);
      }
      
      console.log(`Created ${weekendRules.length} weekend rules for ${detectedTypes.summary}`);
    }
  } catch (error) {
    console.error('Error creating weekend rules:', error.message);
  }
}

// ================ HELPER FUNCTIONS FOR DYNAMIC RULE GENERATION ================

function analyzeInverterTypes() {
  const analysis = {
      hasLegacy: false,
      hasNew: false,
      hasHybrid: false,
      hasUnknown: false,
      hasAny: false,
      primary: 'unknown',
      summary: 'no inverters',
      counts: {
          legacy: 0,
          new: 0,
          hybrid: 0,
          unknown: 0
      }
  };
  
  if (!inverterTypes || Object.keys(inverterTypes).length === 0) {
      // If no types detected yet, assume we might have any type
      analysis.hasAny = true;
      analysis.hasLegacy = true;
      analysis.hasNew = true;
      analysis.primary = 'universal';
      analysis.summary = 'all types (detection pending)';
      return analysis;
  }
  
  // Count inverter types
  Object.values(inverterTypes).forEach(inv => {
      const type = inv.type || 'unknown';
      analysis.counts[type] = (analysis.counts[type] || 0) + 1;
      
      switch (type) {
          case 'legacy':
              analysis.hasLegacy = true;
              analysis.hasAny = true;
              break;
          case 'new':
              analysis.hasNew = true;
              analysis.hasAny = true;
              break;
          case 'hybrid':
              analysis.hasHybrid = true;
              analysis.hasAny = true;
              break;
          case 'unknown':
              analysis.hasUnknown = true;
              analysis.hasAny = true;
              break;
      }
  });
  
  // Determine primary type
  const types = Object.entries(analysis.counts)
      .filter(([_, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
  
  if (types.length > 0) {
      analysis.primary = types[0][0];
  }
  
  // Create summary
  const summaryParts = [];
  if (analysis.counts.legacy > 0) summaryParts.push(`${analysis.counts.legacy}x legacy`);
  if (analysis.counts.new > 0) summaryParts.push(`${analysis.counts.new}x new`);
  if (analysis.counts.hybrid > 0) summaryParts.push(`${analysis.counts.hybrid}x hybrid`);
  if (analysis.counts.unknown > 0) summaryParts.push(`${analysis.counts.unknown}x unknown`);
  
  analysis.summary = summaryParts.join(', ') || 'no inverters';
  
  return analysis;
}

function generateAdaptiveActions(actionType, value, detectedTypes) {
  const actions = [];
  
  switch (actionType) {
      case 'charging':
          if (detectedTypes.hasLegacy || detectedTypes.hasUnknown) {
              actions.push({
                  setting: 'grid_charge',
                  value: value,
                  inverter: 'all'
              });
          }
          if (detectedTypes.hasNew) {
              const mappedValue = value === 'Enabled' ? 'Solar and utility simultaneously' : 'Solar first';
              actions.push({
                  setting: 'charger_source_priority',
                  value: mappedValue,
                  inverter: 'all'
              });
          }
          break;
          
      case 'energy_optimization':
          if (detectedTypes.hasLegacy || detectedTypes.hasUnknown) {
              actions.push({
                  setting: 'energy_pattern',
                  value: value,
                  inverter: 'all'
              });
          }
          if (detectedTypes.hasNew) {
              const mappedValue = mapEnergyPatternToOutputSourcePriority(value);
              actions.push({
                  setting: 'output_source_priority',
                  value: mappedValue,
                  inverter: 'all'
              });
          }
          break;
          
      case 'weekend_solar':
      case 'solar_priority':
          if (detectedTypes.hasLegacy || detectedTypes.hasUnknown) {
              actions.push({
                  setting: 'grid_charge',
                  value: value,
                  inverter: 'all'
              });
          }
          if (detectedTypes.hasNew) {
              actions.push({
                  setting: 'charger_source_priority',
                  value: 'Solar only',
                  inverter: 'all'
              });
          }
          break;
          
      case 'battery_preserve':
          if (detectedTypes.hasLegacy) {
              actions.push({
                  setting: 'energy_pattern',
                  value: value,
                  inverter: 'all'
              });
          }
          if (detectedTypes.hasNew) {
              actions.push({
                  setting: 'output_source_priority',
                  value: 'Solar first',
                  inverter: 'all'
              });
          }
          break;
          
      case 'emergency_charge':
          if (detectedTypes.hasLegacy || detectedTypes.hasUnknown) {
              actions.push({
                  setting: 'grid_charge',
                  value: 'Enabled',
                  inverter: 'all'
              });
          }
          if (detectedTypes.hasNew) {
              actions.push({
                  setting: 'charger_source_priority',
                  value: 'Utility first',
                  inverter: 'all'
              });
          }
          break;
          
      case 'high_load':
          if (detectedTypes.hasLegacy) {
              actions.push({
                  setting: 'energy_pattern',
                  value: value,
                  inverter: 'all'
              });
          }
          if (detectedTypes.hasNew) {
              actions.push({
                  setting: 'output_source_priority',
                  value: 'Utility first',
                  inverter: 'all'
              });
          }
          break;
  }
  
  // Remove duplicates
  const uniqueActions = [];
  const seen = new Set();
  
  actions.forEach(action => {
      const key = `${action.setting}-${action.value}`;
      if (!seen.has(key)) {
          seen.add(key);
          uniqueActions.push(action);
      }
  });
  
  return uniqueActions.length > 0 ? uniqueActions : [{
      setting: 'remote_switch',
      value: 'Enabled',
      inverter: 'all'
  }];
}
  

  
  function generateInitialSampleData(timezone = 'Europe/Berlin') {
    const prices = [];
    
    const now = new Date();
    const nowInTimezone = new Date(now.toLocaleString("en-US", {timeZone: timezone}));
    
    const startHour = new Date(nowInTimezone);
    startHour.setMinutes(0, 0, 0);
    
    for (let i = 0; i < 48; i++) {
      const timestamp = new Date(startHour);
      timestamp.setHours(timestamp.getHours() + i);
      
      const hour = timestamp.getHours();
      const dayOfWeek = timestamp.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      
      let basePrice = 0.10;
      
      if (hour >= 7 && hour <= 9) {
        basePrice = 0.18;
      } else if (hour >= 17 && hour <= 21) {
        basePrice = 0.20;
      } else if (hour >= 1 && hour <= 5) {
        basePrice = 0.06;
      } else if (hour >= 11 && hour <= 14) {
        basePrice = 0.08;
      }
      
      if (isWeekend) {
        basePrice *= 0.85;
      }
      
      const randomFactor = 0.85 + (Math.random() * 0.3);
      const price = basePrice * randomFactor;
      
      prices.push({
        timestamp: timestamp.toISOString(),
        price: parseFloat(price.toFixed(4)),
        currency: 'EUR',
        unit: 'kWh',
        timezone: timezone,
        localHour: hour
      });
    }
    
    return prices;
  }
  
  function refreshPricingData() {
    try {
      console.log('Running scheduled pricing data refresh...');
      
      // Refresh Tibber data automatically
      if (tibberService && tibberService.config.enabled) {
        tibberService.refreshData().then(success => {
          if (success) {
            console.log('✅ Tibber price data refreshed automatically');
          } else {
            console.log('⚠️  Tibber refresh failed');
          }
        }).catch(error => {
          console.error('❌ Error refreshing Tibber data:', error);
        });
      }
      
      console.log('✅ Scheduled data refresh completed');
    } catch (error) {
      console.error('❌ Error in scheduled pricing data refresh:', error);
    }
  }
  
  // ================ ENHANCED API ROUTES WITH INVERTER TYPE SUPPORT ================
  
  // Enhanced battery charging settings API with new inverter support
  app.post('/api/battery-charging/set', (req, res) => {
    try {
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' });
      }
      
      const { inverter, setting, value } = req.body;
      
      if (!inverter || !setting || value === undefined) {
        return res.status(400).json({ error: 'Missing inverter, setting, or value' });
      }
      
      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ error: 'MQTT client not connected' });
      }
      
      const allowedSettings = [
        'max_discharge_current',
        'max_charge_current',
        'max_grid_charge_current',
        'max_generator_charge_current',
        'battery_float_charge_voltage',
        'battery_absorption_charge_voltage',
        'battery_equalization_charge_voltage'
      ];
      
      if (!allowedSettings.includes(setting)) {
        return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` });
      }
      
      const inverterID = inverter.replace('inverter_', '');
      if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
        return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` });
      }
      
      let isValid = true;
      let validationError = '';
      
      switch (setting) {
        case 'max_discharge_current':
        case 'max_charge_current':
        case 'max_grid_charge_current':
        case 'max_generator_charge_current':
          if (parseFloat(value) < 0 || parseFloat(value) > 100) {
            isValid = false;
            validationError = `${setting} must be between 0 and 100 A`;
          }
          break;
        case 'battery_float_charge_voltage':
        case 'battery_absorption_charge_voltage':
        case 'battery_equalization_charge_voltage':
          if (parseFloat(value) < 40 || parseFloat(value) > 60) {
            isValid = false;
            validationError = `${setting} must be between 40 and 60 V`;
          }
          break;
      }
      
      if (!isValid) {
        return res.status(400).json({ error: validationError });
      }
      
      const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`;
      
      mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
          return res.status(500).json({ error: err.message });
        }
        
        console.log(`Battery Charging command sent: ${topic} = ${value}`);
        res.json({ success: true, message: `Command sent: ${topic} = ${value}` });
      });
    } catch (error) {
      console.error('Error sending battery charging command:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Enhanced work mode settings API with new inverter support
  app.post('/api/work-mode/set', (req, res) => {
    try {
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' });
      }
      
      const { inverter, setting, value } = req.body;
      
      if (!inverter || !setting || value === undefined) {
        return res.status(400).json({ error: 'Missing inverter, setting, or value' });
      }
      
      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ error: 'MQTT client not connected' });
      }
      
      // Enhanced allowed settings including new inverter types
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
        'grid_trickle_feed',
        // New inverter settings
        'charger_source_priority',
        'output_source_priority',
        // Legacy settings
        'energy_pattern',
        'grid_charge'
      ];
      
      if (!allowedSettings.includes(setting)) {
        return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` });
      }
      
      const inverterID = inverter.replace('inverter_', '');
      if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
        return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` });
      }
      
      let isValid = true;
      let validationError = '';
      
      // Enhanced validation for new inverter settings
      switch (setting) {
        case 'remote_switch':
        case 'generator_charge':
        case 'force_generator_on':
        case 'solar_export_when_battery_full':
        case 'grid_charge':
          if (value !== 'Enabled' && value !== 'Disabled' && value !== 'true' && value !== 'false' && value !== '1' && value !== '0') {
            isValid = false;
            validationError = `${setting} must be one of: Enabled, Disabled, true, false, 1, 0`;
          }
          break;
        case 'work_mode':
          const validWorkModes = ['Battery first', 'Grid first', 'Solar first', 'Solar + Battery', 'Solar + Grid'];
          if (!validWorkModes.includes(value)) {
            isValid = false;
            validationError = `${setting} must be one of: ${validWorkModes.join(', ')}`;
          }
          break;
        case 'energy_pattern':
          const validEnergyPatterns = ['Battery first', 'Load first', 'Grid first', 'Solar first'];
          if (!validEnergyPatterns.includes(value)) {
            isValid = false;
            validationError = `${setting} must be one of: ${validEnergyPatterns.join(', ')}`;
          }
          break;
        case 'charger_source_priority':
          const validChargerPriorities = ['Solar first', 'Solar and utility simultaneously', 'Solar only', 'Utility first'];
          if (!validChargerPriorities.includes(value)) {
            isValid = false;
            validationError = `${setting} must be one of: ${validChargerPriorities.join(', ')}`;
          }
          break;
        case 'output_source_priority':
          const validOutputPriorities = ['Solar/Battery/Utility', 'Solar first', 'Utility first', 'Solar/Utility/Battery'];
          if (!validOutputPriorities.includes(value)) {
            isValid = false;
            validationError = `${setting} must be one of: ${validOutputPriorities.join(', ')}`;
          }
          break;
        case 'output_shutdown_voltage':
        case 'stop_battery_discharge_voltage':
        case 'start_battery_discharge_voltage':
        case 'start_grid_charge_voltage':
          if (parseFloat(value) < 40 || parseFloat(value) > 60) {
            isValid = false;
            validationError = `${setting} must be between 40 and 60 V`;
          }
          break;
        case 'max_sell_power':
        case 'max_solar_power':
          if (parseFloat(value) < 0 || parseFloat(value) > 15000) {
            isValid = false;
            validationError = `${setting} must be between 0 and 15000 W`;
          }
          break;
        case 'grid_trickle_feed':
          if (parseFloat(value) < 0 || parseFloat(value) > 100) {
            isValid = false;
            validationError = `${setting} must be between 0 and 100`;
          }
          break;
      }
      
      if (!isValid) {
        return res.status(400).json({ error: validationError });
      }
      
      // Get inverter type and apply auto-mapping if needed
      const inverterType = getInverterType(inverter);
      let topic, mqttValue;
      
      // Apply intelligent mapping based on inverter type
      if (setting === 'energy_pattern') {
        if (inverterType === 'new' || inverterType === 'hybrid') {
          const mappedValue = mapEnergyPatternToOutputSourcePriority(value);
          topic = `${mqttTopicPrefix}/${inverter}/output_source_priority/set`;
          mqttValue = mappedValue;
          console.log(`API: Mapping energy_pattern "${value}" to output_source_priority "${mappedValue}" for ${inverter} (type: ${inverterType})`);
        } else {
          topic = `${mqttTopicPrefix}/${inverter}/energy_pattern/set`;
          mqttValue = value;
        }
      } else if (setting === 'grid_charge') {
        if (inverterType === 'new' || inverterType === 'hybrid') {
          const mappedValue = mapGridChargeToChargerSourcePriority(value);
          topic = `${mqttTopicPrefix}/${inverter}/charger_source_priority/set`;
          mqttValue = mappedValue;
          console.log(`API: Mapping grid_charge "${value}" to charger_source_priority "${mappedValue}" for ${inverter} (type: ${inverterType})`);
        } else {
          topic = `${mqttTopicPrefix}/${inverter}/grid_charge/set`;
          mqttValue = value;
        }
      } else if (setting === 'charger_source_priority') {
        if (inverterType === 'legacy') {
          const mappedValue = mapChargerSourcePriorityToGridCharge(value);
          topic = `${mqttTopicPrefix}/${inverter}/grid_charge/set`;
          mqttValue = mappedValue;
          console.log(`API: Mapping charger_source_priority "${value}" to grid_charge "${mappedValue}" for ${inverter} (type: ${inverterType})`);
        } else {
          topic = `${mqttTopicPrefix}/${inverter}/charger_source_priority/set`;
          mqttValue = value;
        }
      } else if (setting === 'output_source_priority') {
        if (inverterType === 'legacy') {
          const mappedValue = mapOutputSourcePriorityToEnergyPattern(value);
          topic = `${mqttTopicPrefix}/${inverter}/energy_pattern/set`;
          mqttValue = mappedValue;
          console.log(`API: Mapping output_source_priority "${value}" to energy_pattern "${mappedValue}" for ${inverter} (type: ${inverterType})`);
        } else {
          topic = `${mqttTopicPrefix}/${inverter}/output_source_priority/set`;
          mqttValue = value;
        }
      } else {
        // All other settings work the same for both inverter types
        topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`;
        mqttValue = value;
      }
      
      mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
          return res.status(500).json({ error: err.message });
        }
        
        console.log(`Work Mode command sent: ${topic} = ${mqttValue}`);
        res.json({ success: true, message: `Command sent: ${topic} = ${mqttValue}` });
      });
    } catch (error) {
      console.error('Error sending work mode command:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Enhanced current settings API with inverter type information
  app.get('/api/current-settings', (req, res) => {
    try {
      // Include inverter type information in the response
      const settingsWithTypes = {
        ...currentSettingsState,
        inverterTypes: inverterTypes
      };
      
      res.json({
        success: true,
        currentSettings: settingsWithTypes,
        inverterCount: inverterNumber,
        batteryCount: batteryNumber,
        timestamp: new Date(),
        systemState: currentSystemState
      });
    } catch (error) {
      console.error('Error retrieving current settings:', error);
      res.status(500).json({ error: 'Failed to retrieve current settings' });
    }
  });
  
  // Enhanced API to get inverter type information
  app.get('/api/inverter-types', (req, res) => {
    try {
      res.json({
        success: true,
        inverterTypes: inverterTypes,
        totalInverters: inverterNumber,
        detectionCriteria: {
          legacy: 'Supports energy_pattern and grid_charge settings',
          new: 'Supports charger_source_priority and output_source_priority settings',
          hybrid: 'Supports both legacy and new settings',
          unknown: 'No settings detected yet'
        }
      });
    } catch (error) {
      console.error('Error retrieving inverter types:', error);
      res.status(500).json({ error: 'Failed to retrieve inverter type information' });
    }
  });
  
  // Add notification routes
  app.use('/api/notifications', notificationRoutes);
  
  global.processRules = processRules;

  // ================ ENHANCED INVERTER SETTINGS PAGE ================

  app.get('/inverter-settings', (req, res) => {
    try {
      let settingsCount = 0;
      if (dbConnected && jsonStorage) {
        try {
          const result = jsonStorage.getSettingsChanges(USER_ID);
          settingsCount = result.pagination.total || 0;
        } catch (dbError) {
          console.error('Error getting settings count:', dbError);
        }
      }
  
      const systemState = {
        battery_soc: currentSystemState.battery_soc || null,
        pv_power: currentSystemState.pv_power || null,
        load: currentSystemState.load || null,
        grid_voltage: currentSystemState.grid_voltage || null,
        grid_power: currentSystemState.grid_power || null,
        inverter_state: currentSystemState.inverter_state || null,
        timestamp: currentSystemState.timestamp || new Date().toISOString()
      };
  
      // Enhanced settings with both legacy and new inverter support
      const settings = {
        // Legacy settings
        grid_charge: currentSettingsState.grid_charge || {},
        energy_pattern: currentSettingsState.energy_pattern || {},
        
        // New inverter settings
        charger_source_priority: currentSettingsState.charger_source_priority || {},
        output_source_priority: currentSettingsState.output_source_priority || {},
        
        // Common settings
        voltage_point: currentSettingsState.voltage_point || {},
        work_mode: currentSettingsState.work_mode || {},
        remote_switch: currentSettingsState.remote_switch || {},
        generator_charge: currentSettingsState.generator_charge || {},
        force_generator_on: currentSettingsState.force_generator_on || {},
        output_shutdown_voltage: currentSettingsState.output_shutdown_voltage || {},
        stop_battery_discharge_voltage: currentSettingsState.stop_battery_discharge_voltage || {},
        start_battery_discharge_voltage: currentSettingsState.start_battery_discharge_voltage || {},
        start_grid_charge_voltage: currentSettingsState.start_grid_charge_voltage || {},
        solar_export_when_battery_full: currentSettingsState.solar_export_when_battery_full || {},
        max_sell_power: currentSettingsState.max_sell_power || {},
        max_solar_power: currentSettingsState.max_solar_power || {},
        grid_trickle_feed: currentSettingsState.grid_trickle_feed || {},
        
        // Battery charging settings
        max_discharge_current: currentSettingsState.max_discharge_current || {},
        max_charge_current: currentSettingsState.max_charge_current || {},
        max_grid_charge_current: currentSettingsState.max_grid_charge_current || {},
        max_generator_charge_current: currentSettingsState.max_generator_charge_current || {},
        battery_float_charge_voltage: currentSettingsState.battery_float_charge_voltage || {},
        battery_absorption_charge_voltage: currentSettingsState.battery_absorption_charge_voltage || {},
        battery_equalization_charge_voltage: currentSettingsState.battery_equalization_charge_voltage || {},
        
        // Additional inverter info
        serial_number: currentSettingsState.serial_number || {},
        power_saving: currentSettingsState.power_saving || {},
        firmware_version: currentSettingsState.firmware_version || {},
        
        lastUpdated: currentSettingsState.lastUpdated
      };
  
      const config = {
        inverterNumber: inverterNumber || 1,
        batteryNumber: batteryNumber || 1,
        mqttTopicPrefix: options.mqtt_topic_prefix || 'energy',
        mqttHost: options.mqtt_host || 'localhost',
        mqttUsername: options.mqtt_username || 'User'
      };
  
      const expectedInverters = parseInt(options.inverter_number) || 1;
      const inverterWarning = checkInverterMessages(incomingMessages, expectedInverters);
      const batteryWarning = checkBatteryInformation(incomingMessages);
  
      res.render('inverter-settings', { 
        active: learnerModeActive,
        db_connected: dbConnected,
        currentSystemState: systemState,
        currentSettings: settings,
        inverterTypes: inverterTypes,
        numInverters: config.inverterNumber,
        numBatteries: config.batteryNumber,
        mqtt_topic_prefix: config.mqttTopicPrefix,
        mqtt_host: config.mqttHost,
        mqtt_username: config.mqttUsername,
        user_id: USER_ID,
        settings_count: settingsCount,
        inverterWarning: inverterWarning,
        batteryWarning: batteryWarning,
        ingress_path: process.env.INGRESS_PATH || '',
        timestamp: new Date(),
        serverPort: port,
        useInMemorySettings: true,
        realTimeUpdates: true,
        mqttConnected: mqttClient ? mqttClient.connected : false,
        recentMessages: incomingMessages.slice(-10),
        dynamicPricingEnabled: false,
        supportsLegacySettings: true,
        supportsNewSettings: true,
        autoDetection: true
      });
  
    } catch (error) {
      console.error('Error rendering inverter-settings page:', error);
      
      try {
        res.status(500).render('error', { 
          error: 'Error loading inverter settings page',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined,
          ingress_path: process.env.INGRESS_PATH || ''
        });
      } catch (renderError) {
        res.status(500).send(`
          <h1>Error Loading Inverter Settings</h1>
          <p>An error occurred while loading the inverter settings page.</p>
          <p><a href="/">Return to Home</a></p>
        `);
      }
    }
  });
  
  // ================ ENHANCED API ROUTES ================
  
  // Enhanced current settings API with inverter type mapping
  app.get('/api/grid-charge-changes', (req, res) => {
    try {
      // Combine both legacy and new settings for compatibility
      const gridChargeSettings = {
        grid_charge: currentSettingsState.grid_charge,
        charger_source_priority: currentSettingsState.charger_source_priority, // Include new setting
        max_grid_charge_current: currentSettingsState.max_grid_charge_current
      };
      
      res.json({
        success: true,
        currentSettings: gridChargeSettings,
        inverterCount: inverterNumber,
        timestamp: new Date(),
        fromMemory: true,
        inverterTypes: inverterTypes // Include inverter type info
      });
    } catch (error) {
      console.error('Error retrieving grid charge settings:', error);
      res.status(500).json({ error: 'Failed to retrieve grid charge settings' });
    }
  });
  
  app.get('/api/energy-pattern-changes', (req, res) => {
    try {
      // Combine both legacy and new settings for compatibility
      const energyPatternSettings = {
        energy_pattern: currentSettingsState.energy_pattern,
        output_source_priority: currentSettingsState.output_source_priority // Include new setting
      };
      
      res.json({
        success: true,
        currentSettings: energyPatternSettings,
        inverterCount: inverterNumber,
        timestamp: new Date(),
        fromMemory: true,
        inverterTypes: inverterTypes // Include inverter type info
      });
    } catch (error) {
      console.error('Error retrieving energy pattern settings:', error);
      res.status(500).json({ error: 'Failed to retrieve energy pattern settings' });
    }
  });
  
  app.get('/api/voltage-point-changes', (req, res) => {
    try {
      res.json({
        success: true,
        currentSettings: {
          voltage_point: currentSettingsState.voltage_point
        },
        inverterCount: inverterNumber,
        timestamp: new Date(),
        fromMemory: true,
        inverterTypes: inverterTypes
      });
    } catch (error) {
      console.error('Error retrieving voltage point settings:', error);
      res.status(500).json({ error: 'Failed to retrieve voltage point settings' });
    }
  });
  
  app.get('/api/work-mode-changes', (req, res) => {
    try {
      const workModeSettings = {
        work_mode: currentSettingsState.work_mode,
        remote_switch: currentSettingsState.remote_switch,
        generator_charge: currentSettingsState.generator_charge,
        force_generator_on: currentSettingsState.force_generator_on,
        output_shutdown_voltage: currentSettingsState.output_shutdown_voltage,
        stop_battery_discharge_voltage: currentSettingsState.stop_battery_discharge_voltage,
        start_battery_discharge_voltage: currentSettingsState.start_battery_discharge_voltage,
        start_grid_charge_voltage: currentSettingsState.start_grid_charge_voltage,
        solar_export_when_battery_full: currentSettingsState.solar_export_when_battery_full,
        max_sell_power: currentSettingsState.max_sell_power,
        max_solar_power: currentSettingsState.max_solar_power,
        grid_trickle_feed: currentSettingsState.grid_trickle_feed
      };
      
      res.json({
        success: true,
        currentSettings: workModeSettings,
        inverterCount: inverterNumber,
        timestamp: new Date(),
        fromMemory: true,
        inverterTypes: inverterTypes
      });
    } catch (error) {
      console.error('Error retrieving work mode settings:', error);
      res.status(500).json({ error: 'Failed to retrieve work mode settings' });
    }
  });
  
  app.get('/api/battery-charging-changes', (req, res) => {
    try {
      const batteryChargingSettings = {
        max_discharge_current: currentSettingsState.max_discharge_current,
        max_charge_current: currentSettingsState.max_charge_current,
        max_grid_charge_current: currentSettingsState.max_grid_charge_current,
        max_generator_charge_current: currentSettingsState.max_generator_charge_current,
        battery_float_charge_voltage: currentSettingsState.battery_float_charge_voltage,
        battery_absorption_charge_voltage: currentSettingsState.battery_absorption_charge_voltage,
        battery_equalization_charge_voltage: currentSettingsState.battery_equalization_charge_voltage
      };
      
      res.json({
        success: true,
        currentSettings: batteryChargingSettings,
        inverterCount: inverterNumber,
        timestamp: new Date(),
        fromMemory: true,
        inverterTypes: inverterTypes
      });
    } catch (error) {
      console.error('Error retrieving battery charging settings:', error);
      res.status(500).json({ error: 'Failed to retrieve battery charging settings' });
    }
  });
  
  app.get('/notifications', async (req, res) => {
    try {
      res.render('notifications', {
        ingress_path: process.env.INGRESS_PATH || '',
        user_id: USER_ID
      });
    } catch (error) {
      console.error('Error rendering notifications page:', error);
      res.status(500).send('Error loading notifications page');
    }
  });
  
  app.get('/api/settings-history/:setting', apiRateLimiter, async (req, res) => {
    try {
      const setting = req.params.setting;
      const days = parseInt(req.query.days) || 7;
      
      const query = `
        SELECT * FROM settings_changes 
        WHERE user_id = '${USER_ID}'
        AND change_type = '${setting}'
        AND time >= now() - ${days}d
        ORDER BY time DESC
      `;
      
      const result = await influx.query(query);
      
      const formattedData = result.map(change => ({
        timestamp: change.time,
        value: change.new_value,
        old_value: change.old_value,
        system_state: JSON.parse(change.system_state || '{}')
      }));
      
      res.json({
        success: true,
        setting,
        data: formattedData,
        count: formattedData.length
      });
    } catch (error) {
      console.error(`Error retrieving ${req.params.setting} history from InfluxDB:`, error);
      res.status(500).json({ error: 'Failed to retrieve setting history' });
    }
  });
  
  
  // ================ RULES MANAGEMENT API ================
  
  app.get('/wizard', async (req, res) => {
    try {
        const editParam = req.query.edit;
        
        // Get enhanced system state
        const systemState = { ...currentSystemState };
        
        // Get detailed inverter information
        const detailedInverterTypes = {};
        Object.entries(inverterTypes).forEach(([inverterId, info]) => {
            detailedInverterTypes[inverterId] = {
                ...info,
                capabilities: getInverterCapabilities(info.type),
                supportedSettings: getSupportedSettings(info.type),
                lastSeen: getLastSeenTimestamp(inverterId),
                confidenceScore: calculateConfidenceScore(info),
                mappingInfo: getMappingInfo(info.type)
            };
        });
        
        res.render('wizard', { 
            editParam,
            systemState,
            numInverters: inverterNumber,
            db_connected: dbConnected,
            ingress_path: process.env.INGRESS_PATH || '',
            user_id: USER_ID,
            
            // Enhanced wizard data
            inverterTypes: detailedInverterTypes,
            inverterTypesJson: JSON.stringify(detailedInverterTypes),
            totalInverters: inverterNumber,
            detectionSummary: {
                legacy: Object.values(detailedInverterTypes).filter(inv => inv.type === 'legacy').length,
                new: Object.values(detailedInverterTypes).filter(inv => inv.type === 'new').length,
                hybrid: Object.values(detailedInverterTypes).filter(inv => inv.type === 'hybrid').length,
                unknown: Object.values(detailedInverterTypes).filter(inv => inv.type === 'unknown').length
            },
            
            // Feature flags
            supportsLegacySettings: true,
            supportsNewSettings: true,
            autoMapping: true,
            smartTemplates: true,
            
            // Available settings based on detected inverters
            availableSettings: getAllAvailableSettings(),
            
            // Smart rule templates
            ruleTemplates: generateSmartRuleTemplates()
        });
    } catch (error) {
        console.error('Error rendering dynamic wizard page:', error);
        res.status(500).send('Error loading dynamic wizard page');
    }
});
  
app.put('/api/rules/:id', (req, res) => {
  try {
    const ruleId = req.params.id;
    
    console.log(`Attempting to update rule with ID: ${ruleId}`);
    console.log('Request body:', req.body);
    
    if (!dbConnected || !jsonStorage) {
      console.log('Storage not connected, cannot update rule');
      return res.status(503).json({ 
        success: false, 
        error: 'Storage not connected', 
        status: 'disconnected' 
      });
    }
    
    // Validate request body exists
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Request body must be a valid JSON object'
      });
    }
    
    // Validate and sanitize the rule data for Home Assistant compatibility
    let sanitizedRule;
    try {
      sanitizedRule = validateAndSanitizeRuleData(req.body);
      console.log('Sanitized update data:', JSON.stringify(sanitizedRule, null, 2));
    } catch (validationError) {
      console.error('❌ Update validation error:', validationError.message);
      return res.status(400).json({ 
        success: false, 
        error: validationError.message
      });
    }
    
    // Additional validation
    if (sanitizedRule.actions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one valid action is required' 
      });
    }
    
    const rule = getRuleById(ruleId, USER_ID);
    
    if (!rule) {
      console.log(`Rule with ID ${ruleId} not found or does not belong to user ${USER_ID}`);
      return res.status(404).json({ 
        success: false, 
        error: 'Rule not found' 
      });
    }
    
    const updatedRule = {
      ...rule,
      ...sanitizedRule,
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    console.log(`Updating rule "${rule.name}" with active status:`, updatedRule.active);
    
    const success = updateRule(ruleId, updatedRule);
    
    if (!success) {
      console.log(`Failed to update rule with ID ${ruleId}`);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to update rule in storage' 
      });
    }
    
    console.log(`✅ Successfully updated rule with ID ${ruleId}`);
    return res.status(200).json({
      success: true,
      message: 'Rule updated successfully',
      rule: updatedRule
    });
  } catch (error) {
    console.error('❌ Error in update rule endpoint:', error);
    
    // Provide more specific error messages for Home Assistant
    let errorMessage = error.message;
    if (error.message.includes('JSON')) {
      errorMessage = 'Invalid JSON format in rule data';
    } else if (error.message.includes('pattern')) {
      errorMessage = 'Rule contains invalid characters or format';
    }
    
    return res.status(500).json({ 
      success: false, 
      error: 'Server error: ' + errorMessage
    });
  }
});
  
  app.post('/api/rules/:id/duplicate', async (req, res) => {
    try {
      const ruleId = req.params.id;
      
      console.log(`Attempting to duplicate rule with ID: ${ruleId}`);
      
      if (!dbConnected) {
        console.log('Storage not connected, cannot duplicate rule');
        return res.status(503).json({ 
          success: false, 
          error: 'Storage not connected', 
          status: 'disconnected' 
        });
      }
      
      const originalRule = await getRuleById(ruleId, USER_ID);
      
      if (!originalRule) {
        console.log(`Rule with ID ${ruleId} not found or does not belong to user ${USER_ID}`);
        return res.status(404).json({ 
          success: false, 
          error: 'Rule not found' 
        });
      }
      
      const newRule = {
        name: `Copy of ${originalRule.name}`,
        description: originalRule.description,
        active: originalRule.active,
        conditions: originalRule.conditions,
        timeRestrictions: originalRule.timeRestrictions,
        actions: originalRule.actions,
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      console.log(`Duplicating rule "${originalRule.name}"`, newRule);
      
      const savedRule = await saveRule(newRule);
      
      if (!savedRule) {
        console.log(`Failed to duplicate rule with ID ${ruleId}`);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to duplicate rule' 
        });
      }
      
      console.log(`Successfully duplicated rule with ID ${ruleId} to new rule ID ${savedRule.id}`);
      return res.status(201).json({
        success: true,
        message: `Rule "${originalRule.name}" duplicated successfully`,
        rule: savedRule
      });
    } catch (error) {
      console.error('Error in duplicate rule endpoint:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Server error: ' + error.message 
      });
    }
  });
  
  app.get('/rule-history', async (req, res) => {
    try {
      let ruleHistory = [];
      let systemState = { ...currentSystemState };
      
      if (dbConnected && jsonStorage) {
        const rules = jsonStorage.getAllRules(USER_ID);
        
        ruleHistory = rules
          .filter(rule => rule.lastTriggered)
          .sort((a, b) => new Date(b.lastTriggered) - new Date(a.lastTriggered));
      }
      
      res.render('rule-history', {
        ruleHistory,
        db_connected: dbConnected,
        system_state: systemState,
        ingress_path: process.env.INGRESS_PATH || '',
        user_id: USER_ID
      });
    } catch (error) {
      console.error('Error rendering rule history page:', error);
      res.status(500).send('Error loading rule history page');
    }
  });
  
  app.get('/api/rules/history', async (req, res) => {
    try {
      if (!dbConnected || !jsonStorage) {
        return res.status(503).json({ error: 'Storage not connected', status: 'disconnected' });
      }
      
      const limit = parseInt(req.query.limit) || 50;
      const skip = parseInt(req.query.skip) || 0;
      const sortBy = req.query.sortBy || 'last_triggered';
      const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
      
      const allRules = jsonStorage.getAllRules(USER_ID);
      const triggeredRules = allRules.filter(rule => rule.lastTriggered);
      
      // Sort rules
      triggeredRules.sort((a, b) => {
        const aVal = a[sortBy];
        const bVal = b[sortBy];
        if (sortOrder === 'DESC') {
          return bVal > aVal ? 1 : -1;
        }
        return aVal > bVal ? 1 : -1;
      });
      
      const totalCount = triggeredRules.length;
      const ruleHistory = triggeredRules.slice(skip, skip + limit);
      const formattedRules = ruleHistory;
      
      res.json({
        rules: formattedRules,
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
      
      const allRules = jsonStorage.getAllRules(USER_ID);
      const totalRulesResult = { count: allRules.length };
      
      const totalExecutionsResult = { 
        total: allRules.reduce((sum, rule) => sum + (rule.triggerCount || 0), 0) 
      };
      
      const rulesWithTriggers = allRules.filter(rule => (rule.triggerCount || 0) > 0);
      rulesWithTriggers.sort((a, b) => (b.triggerCount || 0) - (a.triggerCount || 0));
      const mostActiveRuleResult = rulesWithTriggers.length > 0 ? rulesWithTriggers[0] : null;
      
      const now = new Date();
      const oneDayAgo = new Date(now);
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const last24HoursResult = {
        count: allRules.filter(rule => 
          rule.lastTriggered && new Date(rule.lastTriggered) >= oneDayAgo
        ).length
      };
      
      res.json({
        totalRules: totalRulesResult.count || 0,
        totalExecutions: totalExecutionsResult.total || 0,
        last24Hours: last24HoursResult.count || 0,
        mostActiveRule: mostActiveRuleResult ? mostActiveRuleResult.name : 'None'
      });
    } catch (error) {
      console.error('Error fetching rule statistics:', error);
      res.json({
        totalRules: 0,
        totalExecutions: 0,
        last24Hours: 0,
        mostActiveRule: 'None'
      });
    }
  });
  
  app.get('/api/rules/:id/execution-history', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Storage not connected', status: 'disconnected' });
      }
      
      const rule = await getRuleById(req.params.id, USER_ID);
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      if (!rule.lastTriggered) {
        return res.json({
          rule: {
            id: rule.id,
            name: rule.name,
            description: rule.description,
            active: rule.active
          },
          executionHistory: []
        });
      }
      
      const ruleDetails = {
        id: rule.id,
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
        return res.status(503).json({ error: 'Storage not connected', status: 'disconnected' });
      }
      
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot execute rules.' });
      }
      
      const rule = await getRuleById(req.params.id, USER_ID);
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
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
      
      rule.lastTriggered = new Date();
      rule.triggerCount = (rule.triggerCount || 0) + 1;
      await updateRule(rule.id, rule);
      
      res.json({ 
        message: `Rule "${rule.name}" executed successfully`, 
        execution: {
          ruleId: rule.id,
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
  
  app.get('/rules', (req, res) => {
    try {
      let rulesCount = 0;
      let activeRulesCount = 0;
      let systemState = { ...currentSystemState };
      let recentlyTriggered = [];
      
      if (dbConnected && jsonStorage) {
        try {
          const allRules = jsonStorage.getAllRules(USER_ID);
          rulesCount = allRules.length;
          
          activeRulesCount = allRules.filter(rule => rule.active).length;
          
          const triggeredRules = allRules
            .filter(rule => rule.lastTriggered)
            .sort((a, b) => new Date(b.lastTriggered) - new Date(a.lastTriggered))
            .slice(0, 5);
          
          recentlyTriggered = triggeredRules.map(rule => ({
            id: rule.id,
            name: rule.name,
            lastTriggered: rule.lastTriggered
          }));
        } catch (dbError) {
          console.error('Error getting rules data:', dbError);
        }
      }
      
      res.render('rules', { 
        db_connected: dbConnected,
        rules_count: rulesCount,
        active_rules_count: activeRulesCount,
        system_state: systemState,
        recently_triggered: recentlyTriggered,
        ingress_path: process.env.INGRESS_PATH || '',
        user_id: USER_ID,
        inverterTypes: inverterTypes,
        supportsLegacySettings: true,
        supportsNewSettings: true,
        autoMapping: true
      });
    } catch (error) {
      console.error('Error rendering rules page:', error);
      res.status(500).send('Error loading page data');
    }
  });
    
  app.get('/api/rules', (req, res) => {
    try {
      if (!dbConnected || !jsonStorage) {
        return res.status(503).json({ error: 'Storage not connected', status: 'disconnected' });
      }
      
      const activeFilter = req.query.active;
      let queryOptions = { sort: { field: 'name', order: 'ASC' } };
      
      if (activeFilter !== undefined) {
        const activeBoolean = activeFilter === 'true' || activeFilter === '1';
        queryOptions.active = activeBoolean;
      }
      
      const rules = getAllRules(USER_ID, queryOptions);
      
      const rulesWithStatus = rules.map(rule => ({
        ...rule,
        active: rule.active === true,
        isActive: rule.active === true
      }));
      
      res.json(rulesWithStatus);
    } catch (error) {
      console.error('Error retrieving rules:', error);
      res.status(500).json({ error: 'Failed to retrieve rules' });
    }
  });
  
  app.delete('/api/rules/:id', (req, res) => {
    try {
      const ruleId = req.params.id;
      
      console.log(`Attempting to delete rule with ID: ${ruleId}`);
      
      if (!dbConnected || !jsonStorage) {
        console.log('Storage not connected, cannot delete rule');
        return res.status(503).json({ 
          success: false, 
          error: 'Storage not connected', 
          status: 'disconnected' 
        });
      }
      
      const rule = getRuleById(ruleId, USER_ID);
      
      if (!rule) {
        console.log(`Rule with ID ${ruleId} not found or does not belong to user ${USER_ID}`);
        return res.status(404).json({ 
          success: false, 
          error: 'Rule not found' 
        });
      }
      
      console.log(`Found rule "${rule.name}" with ID ${ruleId}, proceeding with deletion`);
      const success = deleteRule(ruleId, USER_ID);
      
      if (!success) {
        console.log(`Failed to delete rule with ID ${ruleId}`);
        return res.status(500).json({ 
          success: false, 
          error: 'Rule found but could not be deleted' 
        });
      }
      
      console.log(`Successfully deleted rule with ID ${ruleId}`);
      return res.status(200).json({ 
        success: true, 
        message: 'Rule deleted successfully' 
      });
    } catch (error) {
      console.error('Error in delete rule endpoint:', error);
      return res.status(500).json({ 
        success: false, 
        error: 'Server error: ' + error.message 
      });
    }
  });
  
  app.get('/api/rules/:id', (req, res) => {
    try {
      if (!dbConnected || !jsonStorage) {
        return res.status(503).json({ error: 'Storage not connected', status: 'disconnected' });
      }
      
      console.log(`Fetching rule with ID: ${req.params.id}`);
      const rule = getRuleById(req.params.id, USER_ID);
      
      if (!rule) {
        console.log(`Rule ${req.params.id} not found`);
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      if (rule.parseError) {
        console.log(`Rule ${req.params.id} has parse errors, returning cleaned version`);
      }
      
      res.json(rule);
    } catch (error) {
      console.error('Error retrieving rule:', error);
      res.status(500).json({ 
        error: 'Failed to retrieve rule',
        details: error.message
      });
    }
  });
  
  app.get('/api/system-state', (req, res) => {
    res.json({ 
      current_state: currentSystemState,
      timestamp: new Date()
    });
  });
  
  // New endpoint for historical system data
  app.get('/api/system-state/history', async (req, res) => {
    try {
      const hours = parseInt(req.query.hours) || 2;
      const limit = parseInt(req.query.limit) || 50;
      
      if (!dbConnected || !jsonStorage) {
        return res.json({
          success: false,
          error: 'Storage not connected',
          data: []
        });
      }
      
      const hoursAgo = new Date();
      hoursAgo.setHours(hoursAgo.getHours() - hours);
      
      const result = jsonStorage.getSettingsChanges(USER_ID, { limit });
      const changes = result.changes || [];
      
      // Filter by time and system state availability
      const filteredChanges = changes.filter(change => 
        new Date(change.timestamp) >= hoursAgo &&
        change.system_state && 
        change.system_state !== '{}'
      );
      
      const historyData = filteredChanges.map(change => {
        try {
          const systemState = JSON.parse(change.system_state || '{}');
          return {
            timestamp: change.timestamp,
            battery_soc: systemState.battery_soc || 0,
            pv_power: systemState.pv_power || 0,
            grid_power: systemState.grid_power || 0,
            load: systemState.load || 0,
            battery_power: systemState.battery_power || 0
          };
        } catch (e) {
          return null;
        }
      }).filter(item => item !== null).reverse();
      
      res.json({
        success: true,
        data: historyData,
        count: historyData.length
      });
    } catch (error) {
      console.error('Error fetching system state history:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch historical data',
        data: []
      });
    }
  });
  
  app.get('/api/settings-changes', apiRateLimiter, async (req, res) => {
    try {
      const changeType = req.query.type;
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const skip = parseInt(req.query.skip) || 0;
      
      let query = `
        SELECT * FROM settings_changes 
        WHERE user_id = '${USER_ID}'
      `;
      
      if (changeType) {
        query += ` AND change_type = '${changeType}'`;
      }
      
      query += ` ORDER BY time DESC LIMIT ${limit} OFFSET ${skip}`;
      
      const result = await influx.query(query);
      
      const formattedChanges = result.map(change => ({
        time: change.time,
        topic: change.topic,
        old_value: change.old_value,
        new_value: change.new_value,
        system_state: JSON.parse(change.system_state || '{}'),
        change_type: change.change_type,
        user_id: change.user_id,
        mqtt_username: change.mqtt_username
      }));
      
      res.json({
        changes: formattedChanges,
        pagination: {
          total: formattedChanges.length,
          limit,
          skip,
          hasMore: formattedChanges.length === limit
        }
      });
    } catch (error) {
      console.error('Error retrieving settings changes from InfluxDB:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });
  
  app.get('/api/learner/status', (req, res) => {
    res.json({ 
      active: learnerModeActive,
      change_detection: 'always',
      action_execution: learnerModeActive ? 'enabled' : 'disabled',
      monitored_settings: settingsToMonitor,
      current_system_state: currentSystemState,
      db_connected: dbConnected,
      // Enhanced learner status with inverter type info
      inverter_types: inverterTypes,
      supports_legacy: true,
      supports_new: true,
      auto_mapping: true
    });
  });
  
  app.post('/api/learner/toggle', (req, res) => {
    learnerModeActive = !learnerModeActive;
    
    global.learnerModeActive = learnerModeActive;
    
    console.log(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`);
    
    if (false) { // Dynamic pricing removed
      // Dynamic pricing integration removed
      const action = learnerModeActive 
        ? 'Commands now ENABLED (learner mode active)'
        : 'Commands now DISABLED (learner mode inactive)';
      console.log(action);
    }
    
    res.json({ 
      success: true, 
      active: learnerModeActive,
      message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`,
      note: "Commands will be intelligently mapped to appropriate inverter types.",
      inverter_types: inverterTypes
    });
  });
  
  app.get('/api/learner/changes', apiRateLimiter, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      
      const query = `
        SELECT * FROM settings_changes 
        WHERE user_id = '${USER_ID}'
        ORDER BY time DESC 
        LIMIT ${limit}
      `;
      
      const result = await influx.query(query);
      
      const formattedChanges = result.map(change => ({
        time: change.time,
        topic: change.topic,
        old_value: change.old_value,
        new_value: change.new_value,
        system_state: JSON.parse(change.system_state || '{}'),
        change_type: change.change_type,
        user_id: change.user_id,
        mqtt_username: change.mqtt_username
      }));
      
      res.json(formattedChanges);
    } catch (error) {
      console.error('Error retrieving learner changes from InfluxDB:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });
  
  app.get('/api/database/status', (req, res) => {
    res.json({
      connected: dbConnected,
      type: 'JSON',
      file: 'rules.json, settings_changes.json'
    });
  });
  
  app.get('/learner', async (req, res) => {
    try {
      let changesCount = 0;
      try {
        const query = `SELECT COUNT(*) FROM settings_changes WHERE user_id = '${USER_ID}'`;
        const result = await influx.query(query);
        changesCount = result[0] ? result[0].count : 0;
      } catch (dbError) {
        console.error('Error getting settings count from InfluxDB:', dbError);
      }
      
      res.render('learner', { 
        active: learnerModeActive,
        change_detection: 'always',
        monitored_settings: settingsToMonitor,
        changes_count: changesCount,
        db_connected: true,
        ingress_path: process.env.INGRESS_PATH || '',
        user_id: USER_ID,
        inverterTypes: inverterTypes,
        supportsLegacySettings: true,
        supportsNewSettings: true,
        autoMapping: true
      });
    } catch (error) {
      console.error('Error rendering learner page:', error);
      res.status(500).send('Error loading page data');
    }
  });
  
  // Enhanced command injection route with inverter type auto-mapping
  app.post('/api/command', (req, res) => {
    try {
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' });
      }
      
      const { topic, value } = req.body;
      
      if (!topic || !value) {
        return res.status(400).json({ error: 'Missing topic or value' });
      }
      
      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ error: 'MQTT client not connected' });
      }
      
      // Enhanced command processing with auto-mapping logic
      let finalTopic = topic;
      let finalValue = value;
      
      // Check if this is a legacy command that might need mapping
      const topicParts = topic.split('/');
      if (topicParts.length >= 3) {
        const inverterId = topicParts[1]; // e.g., inverter_1
        const setting = topicParts[2]; // e.g., energy_pattern
        
        if (inverterId && setting) {
          const inverterType = getInverterType(inverterId);
          
          // Apply auto-mapping if needed
          if (setting === 'energy_pattern' && (inverterType === 'new' || inverterType === 'hybrid')) {
            const mappedValue = mapEnergyPatternToOutputSourcePriority(value);
            finalTopic = topic.replace('/energy_pattern/', '/output_source_priority/');
            finalValue = mappedValue;
            console.log(`API Command: Auto-mapped energy_pattern "${value}" to output_source_priority "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
          } else if (setting === 'grid_charge' && (inverterType === 'new' || inverterType === 'hybrid')) {
            const mappedValue = mapGridChargeToChargerSourcePriority(value);
            finalTopic = topic.replace('/grid_charge/', '/charger_source_priority/');
            finalValue = mappedValue;
            console.log(`API Command: Auto-mapped grid_charge "${value}" to charger_source_priority "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
          } else if (setting === 'charger_source_priority' && inverterType === 'legacy') {
            const mappedValue = mapChargerSourcePriorityToGridCharge(value);
            finalTopic = topic.replace('/charger_source_priority/', '/grid_charge/');
            finalValue = mappedValue;
            console.log(`API Command: Auto-mapped charger_source_priority "${value}" to grid_charge "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
          } else if (setting === 'output_source_priority' && inverterType === 'legacy') {
            const mappedValue = mapOutputSourcePriorityToEnergyPattern(value);
            finalTopic = topic.replace('/output_source_priority/', '/energy_pattern/');
            finalValue = mappedValue;
            console.log(`API Command: Auto-mapped output_source_priority "${value}" to energy_pattern "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
          }
        }
      }
      
      mqttClient.publish(finalTopic, finalValue.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${finalTopic}: ${err.message}`);
          return res.status(500).json({ error: err.message });
        }
        
        console.log(`Command sent through API: ${finalTopic} = ${finalValue}`);
        res.json({ 
          success: true, 
          message: `Command sent: ${finalTopic} = ${finalValue}`,
          originalCommand: { topic, value },
          appliedCommand: { topic: finalTopic, value: finalValue },
          autoMapped: finalTopic !== topic || finalValue !== value
        });
      });
    } catch (error) {
      console.error('Error sending command:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  app.get('/api/inverter-info/:inverter', (req, res) => {
    try {
      const inverterId = req.params.inverter;
      
      const info = {
        serial_number: currentSettingsState.serial_number?.[inverterId]?.value,
        power_saving: currentSettingsState.power_saving?.[inverterId]?.value,
        firmware_version: currentSettingsState.firmware_version?.[inverterId]?.value
      };
      
      const filteredInfo = {};
      Object.keys(info).forEach(key => {
        const value = info[key];
        if (value !== undefined && 
            value !== null && 
            value !== 'N/A' && 
            value !== '' && 
            value !== 'Unknown' &&
            value !== 'Loading...' &&
            value !== '0' &&
            value !== 0) {
          filteredInfo[key] = value;
        }
      });
      
      res.json({ 
        success: Object.keys(filteredInfo).length > 0, 
        info: filteredInfo 
      });
    } catch (error) {
      console.error('Error getting inverter info:', error);
      res.status(500).json({ error: 'Failed to get inverter info' });
    }
  });
  
  app.get('/api/grid-settings/:inverter', (req, res) => {
    try {
      const inverterId = req.params.inverter;
      
      const settings = {
        grid_type: currentSettingsState.grid_type?.[inverterId]?.value,
        grid_voltage_high: currentSettingsState.grid_voltage_high?.[inverterId]?.value,
        grid_voltage_low: currentSettingsState.grid_voltage_low?.[inverterId]?.value,
        grid_frequency: currentSettingsState.grid_frequency?.[inverterId]?.value,
        grid_frequency_high: currentSettingsState.grid_frequency_high?.[inverterId]?.value,
        grid_frequency_low: currentSettingsState.grid_frequency_low?.[inverterId]?.value
      };
      
      const filteredSettings = {};
      Object.keys(settings).forEach(key => {
        const value = settings[key];
        if (value !== undefined && 
            value !== null && 
            value !== 'N/A' && 
            value !== '' && 
            value !== 'Unknown' &&
            value !== 'Loading...' &&
            value !== '0' &&
            value !== 0) {
          filteredSettings[key] = value;
        }
      });
      
      res.json({ 
        success: Object.keys(filteredSettings).length > 0, 
        settings: filteredSettings 
      });
    } catch (error) {
      console.error('Error getting grid settings:', error);
      res.status(500).json({ error: 'Failed to get grid settings' });
    }
  });
  
  app.get('/api/inverter-types/detailed', async (req, res) => {
    try {
        // Get current inverter types with additional metadata
        const detailedTypes = {};
        
        Object.entries(inverterTypes).forEach(([inverterId, info]) => {
            detailedTypes[inverterId] = {
                ...info,
                // Add capability information
                capabilities: getInverterCapabilities(info.type),
                // Add supported settings
                supportedSettings: getSupportedSettings(info.type),
                // Add last seen timestamp from current settings
                lastSeen: getLastSeenTimestamp(inverterId),
                // Add confidence score
                confidenceScore: calculateConfidenceScore(info),
                // Add mapping information
                mappingInfo: getMappingInfo(info.type)
            };
        });
        
        res.json({
            success: true,
            inverterTypes: detailedTypes,
            totalInverters: inverterNumber,
            detectionSummary: {
                legacy: Object.values(detailedTypes).filter(inv => inv.type === 'legacy').length,
                new: Object.values(detailedTypes).filter(inv => inv.type === 'new').length,
                hybrid: Object.values(detailedTypes).filter(inv => inv.type === 'hybrid').length,
                unknown: Object.values(detailedTypes).filter(inv => inv.type === 'unknown').length
            },
            recommendations: generateInverterRecommendations(detailedTypes)
        });
    } catch (error) {
        console.error('Error getting detailed inverter types:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to retrieve detailed inverter information',
            fallback: {
                inverterTypes: {},
                totalInverters: inverterNumber,
                detectionSummary: { legacy: 0, new: 0, hybrid: 0, unknown: inverterNumber }
            }
        });
    }
});

// Dynamic settings API based on inverter types
app.get('/api/settings/available/:inverterId?', async (req, res) => {
    try {
        const inverterId = req.params.inverterId;
        let availableSettings = {};
        
        if (inverterId && inverterTypes[inverterId]) {
            // Get settings for specific inverter
            availableSettings = getAvailableSettingsForInverter(inverterId);
        } else {
            // Get combined settings for all inverters
            availableSettings = getAllAvailableSettings();
        }
        
        res.json({
            success: true,
            settings: availableSettings,
            inverterId: inverterId || 'all',
            mappingInfo: getMappingInfoForSettings(availableSettings)
        });
    } catch (error) {
        console.error('Error getting available settings:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to retrieve available settings' 
        });
    }
});

// Smart rule templates API
app.get('/api/rules/templates', async (req, res) => {
    try {
        const templates = generateSmartRuleTemplates();
        
        res.json({
            success: true,
            templates: templates,
            categories: {
                'charging': templates.filter(t => t.category === 'charging'),
                'energy_management': templates.filter(t => t.category === 'energy_management'),
                'protection': templates.filter(t => t.category === 'protection'),
                'optimization': templates.filter(t => t.category === 'optimization')
            }
        });
    } catch (error) {
        console.error('Error getting rule templates:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to retrieve rule templates' 
        });
    }
});

// Rule validation API for dynamic wizard
app.post('/api/rules/validate', async (req, res) => {
    try {
        const { rule } = req.body;
        const validationResult = validateRuleForInverterTypes(rule);
        
        res.json({
            success: true,
            validation: validationResult,
            warnings: validationResult.warnings || [],
            suggestions: validationResult.suggestions || [],
            compatibility: validationResult.compatibility || {}
        });
    } catch (error) {
        console.error('Error validating rule:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to validate rule' 
        });
    }
});

// Enhanced rule preview API
app.post('/api/rules/preview', async (req, res) => {
    try {
        const { rule } = req.body;
        const preview = generateRulePreview(rule);
        
        res.json({
            success: true,
            preview: preview,
            mappingDetails: preview.mappingDetails,
            estimatedImpact: preview.estimatedImpact
        });
    } catch (error) {
        console.error('Error generating rule preview:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to generate rule preview' 
        });
    }
});

// Middleware specifically for rules endpoint
app.use('/api/rules', (req, res, next) => {
  if (req.method === 'POST') {
    console.log('📝 Rules middleware - checking request');
    
    // Check if body exists and is parsed
    if (req.body === undefined) {
      console.error('❌ No body found in request');
      return res.status(400).json({
        success: false,
        error: 'No request body found'
      });
    }
    
    // Check if body is empty
    if (Object.keys(req.body).length === 0) {
      console.error('❌ Empty body in request');
      return res.status(400).json({
        success: false,
        error: 'Empty request body'
      });
    }
    
    console.log('✅ Rules middleware - body looks good');
  }
  next();
});

// Enhanced validation function for Home Assistant compatibility
function validateAndSanitizeRuleData(ruleData) {
  const sanitized = {
    name: String(ruleData.name || '').trim(),
    description: String(ruleData.description || '').trim(),
    active: Boolean(ruleData.active),
    conditions: [],
    timeRestrictions: {},
    actions: []
  };

  // Validate name - remove special characters that might cause issues in Home Assistant
  if (!sanitized.name || sanitized.name.length === 0) {
    throw new Error('Rule name is required');
  }
  
  // Sanitize name - only allow alphanumeric, spaces, hyphens, underscores
  sanitized.name = sanitized.name.replace(/[^a-zA-Z0-9\s\-_]/g, '');
  
  if (sanitized.name.length > 100) {
    sanitized.name = sanitized.name.substring(0, 100);
  }

  // Validate and sanitize conditions
  if (Array.isArray(ruleData.conditions)) {
    ruleData.conditions.forEach(condition => {
      if (condition && typeof condition === 'object') {
        const sanitizedCondition = {
          parameter: String(condition.parameter || ''),
          operator: String(condition.operator || ''),
          value: parseFloat(condition.value) || 0
        };
        
        // Validate parameter values
        const validParameters = ['battery_soc', 'pv_power', 'load', 'grid_voltage', 'grid_power', 'battery_power'];
        if (validParameters.includes(sanitizedCondition.parameter)) {
          const validOperators = ['gt', 'lt', 'eq', 'gte', 'lte'];
          if (validOperators.includes(sanitizedCondition.operator)) {
            sanitized.conditions.push(sanitizedCondition);
          }
        }
      }
    });
  }

  // Validate and sanitize actions
  if (Array.isArray(ruleData.actions)) {
    ruleData.actions.forEach(action => {
      if (action && typeof action === 'object') {
        const sanitizedAction = {
          setting: String(action.setting || '').trim(),
          value: String(action.value || '').trim(),
          inverter: String(action.inverter || 'all').trim()
        };
        
        // Validate setting names - only allow known settings
        const validSettings = [
          'grid_charge', 'energy_pattern', 'charger_source_priority', 
          'output_source_priority', 'max_discharge_current', 'max_charge_current',
          'max_grid_charge_current', 'remote_switch', 'work_mode', 'voltage_point_1',
          'voltage_point_2', 'voltage_point_3', 'voltage_point_4', 'voltage_point_5',
          'voltage_point_6', 'solar_export_when_battery_full', 'max_sell_power'
        ];
        
        if (validSettings.includes(sanitizedAction.setting) && 
            sanitizedAction.value && sanitizedAction.inverter) {
          sanitized.actions.push(sanitizedAction);
        }
      }
    });
  }

  // Validate and sanitize time restrictions
  if (ruleData.timeRestrictions && typeof ruleData.timeRestrictions === 'object') {
    sanitized.timeRestrictions = {
      enabled: Boolean(ruleData.timeRestrictions.enabled)
    };
    
    if (sanitized.timeRestrictions.enabled) {
      // Validate time format (HH:MM)
      const timePattern = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      
      if (ruleData.timeRestrictions.startTime && 
          timePattern.test(ruleData.timeRestrictions.startTime)) {
        sanitized.timeRestrictions.startTime = ruleData.timeRestrictions.startTime;
      }
      
      if (ruleData.timeRestrictions.endTime && 
          timePattern.test(ruleData.timeRestrictions.endTime)) {
        sanitized.timeRestrictions.endTime = ruleData.timeRestrictions.endTime;
      }
      
      // Validate days
      if (Array.isArray(ruleData.timeRestrictions.days)) {
        const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        sanitized.timeRestrictions.days = ruleData.timeRestrictions.days.filter(day => 
          validDays.includes(String(day).toLowerCase())
        );
      }
    }
  } else {
    sanitized.timeRestrictions = { enabled: false };
  }

  return sanitized;
}

app.post('/api/rules', (req, res) => {
  console.log('📝 Rules POST request received');
  console.log('Content-Type:', req.get('Content-Type'));
  
  try {
    if (!dbConnected || !jsonStorage) {
      return res.status(503).json({ 
        success: false, 
        error: 'Storage not connected'
      });
    }
    
    // Validate request body exists
    if (!req.body || typeof req.body !== 'object') {
      console.error('❌ Invalid request body:', req.body);
      return res.status(400).json({
        success: false,
        error: 'Request body must be a valid JSON object'
      });
    }
    
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Raw request body:', JSON.stringify(req.body, null, 2));
    
    // Validate and sanitize the rule data for Home Assistant compatibility
    let sanitizedRule;
    try {
      sanitizedRule = validateAndSanitizeRuleData(req.body);
      console.log('Sanitized rule data:', JSON.stringify(sanitizedRule, null, 2));
    } catch (validationError) {
      console.error('❌ Validation error:', validationError.message);
      return res.status(400).json({ 
        success: false, 
        error: validationError.message
      });
    }
    
    // Additional validation
    if (sanitizedRule.actions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one valid action is required' 
      });
    }
    
    // Add user information
    const newRule = {
      ...sanitizedRule,
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    console.log('Final rule to save:', JSON.stringify(newRule, null, 2));
    
    const savedRule = saveRule(newRule);
    
    if (!savedRule) {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create rule in storage' 
      });
    }
    
    console.log('✅ Rule saved successfully with ID:', savedRule.id);
    
    res.status(201).json({
      success: true,
      message: 'Rule created successfully',
      rule: savedRule
    });
    
  } catch (error) {
    console.error('❌ Error creating rule:', error);
    
    // Provide more specific error messages for Home Assistant
    let errorMessage = error.message;
    if (error.message.includes('JSON')) {
      errorMessage = 'Invalid JSON format in rule data';
    } else if (error.message.includes('pattern')) {
      errorMessage = 'Rule contains invalid characters or format';
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Server error: ' + errorMessage
    });
  }
});

// ================ HELPER FUNCTIONS FOR DYNAMIC WIZARD ================

function getInverterCapabilities(inverterType) {
  const capabilities = {
      legacy: {
          gridCharging: true,
          energyPattern: true,
          voltagePoints: true,
          workMode: true,
          remoteSwitch: true,
          batterySettings: true,
          solarExport: true
      },
      new: {
          chargerSourcePriority: true,
          outputSourcePriority: true,
          voltagePoints: true,
          workMode: true,
          remoteSwitch: true,
          batterySettings: true,
          solarExport: true,
          advancedControl: true
      },
      hybrid: {
          gridCharging: true,
          energyPattern: true,
          chargerSourcePriority: true,
          outputSourcePriority: true,
          voltagePoints: true,
          workMode: true,
          remoteSwitch: true,
          batterySettings: true,
          solarExport: true,
          advancedControl: true,
          dualMode: true
      },
      unknown: {
          basicControl: true,
          batterySettings: true,
          remoteSwitch: true
      }
  };
  
  return capabilities[inverterType] || capabilities.unknown;
}

function getSupportedSettings(inverterType) {
  const settingsMap = {
      legacy: [
          'grid_charge',
          'energy_pattern',
          'work_mode',
          'remote_switch',
          'generator_charge',
          'voltage_point_1',
          'voltage_point_2',
          'voltage_point_3',
          'voltage_point_4',
          'voltage_point_5',
          'voltage_point_6',
          'max_discharge_current',
          'max_charge_current',
          'max_grid_charge_current',
          'solar_export_when_battery_full',
          'max_sell_power'
      ],
      new: [
          'charger_source_priority',
          'output_source_priority',
          'work_mode',
          'remote_switch',
          'generator_charge',
          'voltage_point_1',
          'voltage_point_2',
          'voltage_point_3',
          'voltage_point_4',
          'voltage_point_5',
          'voltage_point_6',
          'max_discharge_current',
          'max_charge_current',
          'max_grid_charge_current',
          'solar_export_when_battery_full',
          'max_sell_power'
      ],
      hybrid: [
          'grid_charge',
          'energy_pattern',
          'charger_source_priority',
          'output_source_priority',
          'work_mode',
          'remote_switch',
          'generator_charge',
          'voltage_point_1',
          'voltage_point_2',
          'voltage_point_3',
          'voltage_point_4',
          'voltage_point_5',
          'voltage_point_6',
          'max_discharge_current',
          'max_charge_current',
          'max_grid_charge_current',
          'solar_export_when_battery_full',
          'max_sell_power'
      ],
      unknown: [
          'work_mode',
          'remote_switch',
          'max_discharge_current',
          'max_charge_current'
      ]
  };
  
  return settingsMap[inverterType] || settingsMap.unknown;
}

function getLastSeenTimestamp(inverterId) {
  let lastSeen = null;
  
  // Check all setting categories for the most recent timestamp
  Object.keys(currentSettingsState).forEach(category => {
      if (typeof currentSettingsState[category] === 'object' && 
          currentSettingsState[category][inverterId] &&
          currentSettingsState[category][inverterId].lastUpdated) {
          
          const timestamp = new Date(currentSettingsState[category][inverterId].lastUpdated);
          if (!lastSeen || timestamp > lastSeen) {
              lastSeen = timestamp;
          }
      }
  });
  
  return lastSeen;
}

function calculateConfidenceScore(inverterInfo) {
  let score = inverterInfo.detectionConfidence || 0;
  
  // Boost confidence for consistent detection
  if (inverterInfo.type !== 'unknown') {
      score += 20;
  }
  
  // Boost for hybrid detection (requires seeing both types)
  if (inverterInfo.type === 'hybrid') {
      score += 10;
  }
  
  return Math.min(score, 100);
}

function getMappingInfo(inverterType) {
  const mappingInfo = {
      legacy: {
          canReceive: ['charger_source_priority', 'output_source_priority'],
          canSend: ['grid_charge', 'energy_pattern'],
          autoMapping: true,
          mappingRules: {
              'charger_source_priority': 'Maps to grid_charge with intelligent translation',
              'output_source_priority': 'Maps to energy_pattern with intelligent translation'
          }
      },
      new: {
          canReceive: ['grid_charge', 'energy_pattern'],
          canSend: ['charger_source_priority', 'output_source_priority'],
          autoMapping: true,
          mappingRules: {
              'grid_charge': 'Maps to charger_source_priority with intelligent translation',
              'energy_pattern': 'Maps to output_source_priority with intelligent translation'
          }
      },
      hybrid: {
          canReceive: ['grid_charge', 'energy_pattern', 'charger_source_priority', 'output_source_priority'],
          canSend: ['grid_charge', 'energy_pattern', 'charger_source_priority', 'output_source_priority'],
          autoMapping: true,
          nativeSupport: true,
          mappingRules: {
              'grid_charge': 'Native support with fallback to charger_source_priority',
              'energy_pattern': 'Native support with fallback to output_source_priority',
              'charger_source_priority': 'Native support with fallback to grid_charge',
              'output_source_priority': 'Native support with fallback to energy_pattern'
          }
      },
      unknown: {
          canReceive: ['work_mode', 'remote_switch'],
          canSend: ['work_mode', 'remote_switch'],
          autoMapping: false,
          limitedSupport: true,
          mappingRules: {}
      }
  };
  
  return mappingInfo[inverterType] || mappingInfo.unknown;
}

function generateInverterRecommendations(detailedTypes) {
  const recommendations = [];
  
  // Check for mixed environments
  const types = Object.values(detailedTypes).map(inv => inv.type);
  const uniqueTypes = [...new Set(types)];
  
  if (uniqueTypes.length > 1 && uniqueTypes.includes('legacy') && uniqueTypes.includes('new')) {
      recommendations.push({
          type: 'compatibility',
          level: 'info',
          title: 'Mixed Inverter Environment Detected',
          message: 'You have both legacy and new inverters. Commands will be automatically translated for compatibility.',
          action: 'Use universal settings when possible for consistent behavior.'
      });
  }
  
  // Check for unknown types
  const unknownCount = types.filter(t => t === 'unknown').length;
  if (unknownCount > 0) {
      recommendations.push({
          type: 'detection',
          level: 'warning',
          title: `${unknownCount} Inverter(s) Not Yet Detected`,
          message: 'Some inverters haven\'t been fully identified yet. Detection improves with MQTT activity.',
          action: 'Monitor system activity or manually send test commands to improve detection.'
      });
  }
  
  // Check for low confidence
  const lowConfidence = Object.values(detailedTypes)
      .filter(inv => inv.confidenceScore < 50).length;
  
  if (lowConfidence > 0) {
      recommendations.push({
          type: 'confidence',
          level: 'info',
          title: 'Low Detection Confidence',
          message: `${lowConfidence} inverter(s) have low detection confidence.`,
          action: 'Increase MQTT activity or verify inverter responses to improve confidence.'
      });
  }
  
  return recommendations;
}

function getAvailableSettingsForInverter(inverterId) {
  const inverterInfo = inverterTypes[inverterId];
  if (!inverterInfo) {
      return getDefaultAvailableSettings();
  }
  
  const supportedSettings = getSupportedSettings(inverterInfo.type);
  const capabilities = getInverterCapabilities(inverterInfo.type);
  const mappingInfo = getMappingInfo(inverterInfo.type);
  
  return {
      supported: supportedSettings,
      capabilities: capabilities,
      mapping: mappingInfo,
      type: inverterInfo.type,
      confidence: calculateConfidenceScore(inverterInfo)
  };
}

function getAllAvailableSettings() {
  const allSettings = {
      universal: [],
      legacy: [],
      new: [],
      mapping: {}
  };
  
  // Collect all unique settings from all inverters
  Object.entries(inverterTypes).forEach(([inverterId, info]) => {
      const supported = getSupportedSettings(info.type);
      
      supported.forEach(setting => {
          if (info.type === 'legacy' && !allSettings.legacy.includes(setting)) {
              allSettings.legacy.push(setting);
          } else if (info.type === 'new' && !allSettings.new.includes(setting)) {
              allSettings.new.push(setting);
          }
          
          // Add to universal if supported by multiple types
          if (!allSettings.universal.includes(setting)) {
              const supportCount = Object.values(inverterTypes)
                  .filter(inv => getSupportedSettings(inv.type).includes(setting)).length;
              
              if (supportCount >= Object.keys(inverterTypes).length * 0.5) {
                  allSettings.universal.push(setting);
              }
          }
      });
      
      // Add mapping information
      const mappingInfo = getMappingInfo(info.type);
      allSettings.mapping[inverterId] = mappingInfo;
  });
  
  return allSettings;
}

function getDefaultAvailableSettings() {
  return {
      supported: [
          'work_mode',
          'remote_switch',
          'max_discharge_current',
          'max_charge_current',
          'max_grid_charge_current'
      ],
      capabilities: getInverterCapabilities('unknown'),
      mapping: getMappingInfo('unknown'),
      type: 'unknown',
      confidence: 0
  };
}

function getMappingInfoForSettings(availableSettings) {
  const mappingInfo = {};
  
  if (availableSettings.mapping) {
      Object.entries(availableSettings.mapping).forEach(([inverterId, info]) => {
          mappingInfo[inverterId] = {
              autoMapping: info.autoMapping,
              mappingRules: info.mappingRules,
              canReceive: info.canReceive,
              canSend: info.canSend
          };
      });
  }
  
  return mappingInfo;
}

function generateSmartRuleTemplates() {
  const templates = [
      // Charging Templates
      {
          id: 'nighttime_grid_charging',
          name: 'Nighttime Grid Charging',
          description: 'Enable grid charging during off-peak hours (10PM-6AM)',
          category: 'charging',
          inverterCompatibility: ['all'],
          conditions: [
              { parameter: 'battery_soc', operator: 'lt', value: 80 }
          ],
          timeRestrictions: {
              enabled: true,
              startTime: '22:00',
              endTime: '06:00',
              days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
          },
          actions: [
              { setting: 'grid_charge', value: 'Enabled', inverter: 'all' }
          ]
      },
      {
          id: 'solar_priority_charging',
          name: 'Solar Priority Charging',
          description: 'Prioritize solar charging when PV production is high',
          category: 'charging',
          inverterCompatibility: ['new', 'hybrid'],
          conditions: [
              { parameter: 'pv_power', operator: 'gt', value: 5000 },
              { parameter: 'battery_soc', operator: 'lt', value: 90 }
          ],
          actions: [
              { setting: 'charger_source_priority', value: 'Solar first', inverter: 'all' }
          ],
          fallbackActions: [
              { setting: 'grid_charge', value: 'Disabled', inverter: 'all' }
          ]
      },
      
      // Energy Management Templates
      {
          id: 'load_first_pattern',
          name: 'Load First Energy Pattern',
          description: 'Prioritize direct solar consumption during peak production',
          category: 'energy_management',
          inverterCompatibility: ['legacy', 'hybrid'],
          conditions: [
              { parameter: 'pv_power', operator: 'gt', value: 8000 },
              { parameter: 'battery_soc', operator: 'gt', value: 60 }
          ],
          timeRestrictions: {
              enabled: true,
              startTime: '10:00',
              endTime: '16:00'
          },
          actions: [
              { setting: 'energy_pattern', value: 'Load first', inverter: 'all' }
          ],
          fallbackActions: [
              { setting: 'output_source_priority', value: 'Solar first', inverter: 'all' }
          ]
      },
      {
          id: 'battery_first_evening',
          name: 'Battery First Evening Mode',
          description: 'Use battery power during evening hours to save on grid costs',
          category: 'energy_management',
          inverterCompatibility: ['all'],
          conditions: [
              { parameter: 'battery_soc', operator: 'gt', value: 40 }
          ],
          timeRestrictions: {
              enabled: true,
              startTime: '18:00',
              endTime: '22:00'
          },
          actions: [
              { setting: 'energy_pattern', value: 'Battery first', inverter: 'all' }
          ],
          fallbackActions: [
              { setting: 'output_source_priority', value: 'Solar/Battery/Utility', inverter: 'all' }
          ]
      },
      
      // Protection Templates
      {
          id: 'low_battery_protection',
          name: 'Low Battery Protection',
          description: 'Reduce discharge current when battery is low to extend life',
          category: 'protection',
          inverterCompatibility: ['all'],
          conditions: [
              { parameter: 'battery_soc', operator: 'lt', value: 30 }
          ],
          actions: [
              { setting: 'max_discharge_current', value: '30', inverter: 'all' }
          ]
      },
      {
          id: 'emergency_grid_charging',
          name: 'Emergency Grid Charging',
          description: 'Enable aggressive grid charging when battery is critically low',
          category: 'protection',
          inverterCompatibility: ['all'],
          conditions: [
              { parameter: 'battery_soc', operator: 'lt', value: 15 }
          ],
          actions: [
              { setting: 'grid_charge', value: 'Enabled', inverter: 'all' },
              { setting: 'max_grid_charge_current', value: '80', inverter: 'all' }
          ],
          fallbackActions: [
              { setting: 'charger_source_priority', value: 'Utility first', inverter: 'all' }
          ]
      },
      
      // Optimization Templates
      {
          id: 'high_load_optimization',
          name: 'High Load Optimization',
          description: 'Optimize energy distribution during high load periods',
          category: 'optimization',
          inverterCompatibility: ['all'],
          conditions: [
              { parameter: 'load', operator: 'gt', value: 12000 }
          ],
          actions: [
              { setting: 'max_sell_power', value: '0', inverter: 'all' },
              { setting: 'solar_export_when_battery_full', value: 'Disabled', inverter: 'all' }
          ]
      },
      {
          id: 'weekend_eco_mode',
          name: 'Weekend Eco Mode',
          description: 'Optimize for maximum solar utilization on weekends',
          category: 'optimization',
          inverterCompatibility: ['all'],
          timeRestrictions: {
              enabled: true,
              days: ['saturday', 'sunday']
          },
          actions: [
              { setting: 'solar_export_when_battery_full', value: 'Enabled', inverter: 'all' },
              { setting: 'max_charge_current', value: '100', inverter: 'all' }
          ]
      }
  ];
  
  // Filter templates based on current inverter types
  return templates.map(template => {
      // Add compatibility information
      template.compatibleInverters = getCompatibleInverters(template.inverterCompatibility);
      template.mappingRequired = checkMappingRequired(template.actions);
      template.estimatedEffectiveness = calculateTemplateEffectiveness(template);
      
      return template;
  });
}

function getCompatibleInverters(compatibility) {
  const compatibleList = [];
  
  Object.entries(inverterTypes).forEach(([inverterId, info]) => {
      if (compatibility.includes('all') || 
          compatibility.includes(info.type)) {
          compatibleList.push({
              id: inverterId,
              type: info.type,
              confidence: calculateConfidenceScore(info)
          });
      }
  });
  
  return compatibleList;
}

function checkMappingRequired(actions) {
  const mappingRequired = {};
  
  actions.forEach(action => {
      if (action.inverter === 'all') {
          Object.entries(inverterTypes).forEach(([inverterId, info]) => {
              const needsMapping = willRequireMapping(action.setting, info.type);
              if (needsMapping) {
                  mappingRequired[inverterId] = {
                      from: action.setting,
                      to: getMappedSetting(action.setting, info.type),
                      type: info.type
                  };
              }
          });
      } else {
          const inverterInfo = inverterTypes[action.inverter];
          if (inverterInfo) {
              const needsMapping = willRequireMapping(action.setting, inverterInfo.type);
              if (needsMapping) {
                  mappingRequired[action.inverter] = {
                      from: action.setting,
                      to: getMappedSetting(action.setting, inverterInfo.type),
                      type: inverterInfo.type
                  };
              }
          }
      }
  });
  
  return Object.keys(mappingRequired).length > 0 ? mappingRequired : null;
}

function willRequireMapping(setting, inverterType) {
  const legacySettings = ['grid_charge', 'energy_pattern'];
  const newSettings = ['charger_source_priority', 'output_source_priority'];
  
  return (legacySettings.includes(setting) && (inverterType === 'new')) ||
         (newSettings.includes(setting) && (inverterType === 'legacy'));
}

function getMappedSetting(setting, inverterType) {
  const mappings = {
      'grid_charge': {
          'new': 'charger_source_priority',
          'hybrid': 'charger_source_priority'
      },
      'energy_pattern': {
          'new': 'output_source_priority', 
          'hybrid': 'output_source_priority'
      },
      'charger_source_priority': {
          'legacy': 'grid_charge'
      },
      'output_source_priority': {
          'legacy': 'energy_pattern'
      }
  };
  
  return mappings[setting] && mappings[setting][inverterType] || setting;
}

function calculateTemplateEffectiveness(template) {
  let score = 50; // Base score
  
  // Boost for time restrictions (more targeted)
  if (template.timeRestrictions && template.timeRestrictions.enabled) {
      score += 20;
  }
  
  // Boost for multiple conditions (more precise)
  if (template.conditions && template.conditions.length > 1) {
      score += 15;
  }
  
  // Boost for universal compatibility
  if (template.inverterCompatibility.includes('all')) {
      score += 10;
  }
  
  // Reduce for mapping requirements (slight overhead)
  if (template.mappingRequired) {
      score -= 5;
  }
  
  return Math.min(Math.max(score, 0), 100);
}

function validateRuleForInverterTypes(rule) {
  const validation = {
      valid: true,
      warnings: [],
      suggestions: [],
      compatibility: {},
      mappingInfo: {}
  };
  
  // Validate actions against inverter types
  rule.actions.forEach((action, index) => {
      const actionValidation = validateActionForInverters(action);
      
      if (!actionValidation.valid) {
          validation.valid = false;
          validation.warnings.push(`Action ${index + 1}: ${actionValidation.error}`);
      }
      
      if (actionValidation.mappingRequired) {
          validation.mappingInfo[`action_${index}`] = actionValidation.mappingRequired;
      }
      
      if (actionValidation.suggestions) {
          validation.suggestions.push(...actionValidation.suggestions);
      }
  });
  
  // Check compatibility across all targeted inverters
  const compatibilityCheck = checkRuleCompatibility(rule);
  validation.compatibility = compatibilityCheck;
  
  return validation;
}

function validateActionForInverters(action) {
  const validation = {
      valid: true,
      warnings: [],
      suggestions: [],
      mappingRequired: null
  };
  
  const targetInverters = action.inverter === 'all' ? 
      Object.keys(inverterTypes) : [action.inverter];
  
  targetInverters.forEach(inverterId => {
      const inverterInfo = inverterTypes[inverterId];
      if (!inverterInfo) {
          validation.warnings.push(`Inverter ${inverterId} not found`);
          return;
      }
      
      const supportedSettings = getSupportedSettings(inverterInfo.type);
      
      if (!supportedSettings.includes(action.setting)) {
          // Check if mapping is possible
          const mappedSetting = getMappedSetting(action.setting, inverterInfo.type);
          
          if (supportedSettings.includes(mappedSetting)) {
              if (!validation.mappingRequired) {
                  validation.mappingRequired = {};
              }
              validation.mappingRequired[inverterId] = {
                  from: action.setting,
                  to: mappedSetting,
                  inverterType: inverterInfo.type
              };
          } else {
              validation.valid = false;
              validation.warnings.push(`Setting ${action.setting} not supported by ${inverterId} (${inverterInfo.type})`);
          }
      }
  });
  
  return validation;
}

function checkRuleCompatibility(rule) {
  const compatibility = {
      universal: true,
      inverterSpecific: {},
      mixedEnvironment: false,
      recommendedApproach: 'universal'
  };
  
  const detectedTypes = [...new Set(Object.values(inverterTypes).map(inv => inv.type))];
  compatibility.mixedEnvironment = detectedTypes.length > 1;
  
  if (compatibility.mixedEnvironment) {
      compatibility.recommendedApproach = 'adaptive';
      compatibility.universal = false;
  }
  
  // Check each inverter's compatibility
  Object.entries(inverterTypes).forEach(([inverterId, info]) => {
      const inverterCompatibility = {
          supported: true,
          mappingRequired: false,
          confidence: calculateConfidenceScore(info),
          recommendations: []
      };
      
      rule.actions.forEach(action => {
          if (action.inverter === 'all' || action.inverter === inverterId) {
              const supportedSettings = getSupportedSettings(info.type);
              
              if (!supportedSettings.includes(action.setting)) {
                  const mappedSetting = getMappedSetting(action.setting, info.type);
                  
                  if (supportedSettings.includes(mappedSetting)) {
                      inverterCompatibility.mappingRequired = true;
                      inverterCompatibility.recommendations.push(
                          `${action.setting} will be mapped to ${mappedSetting}`
                      );
                  } else {
                      inverterCompatibility.supported = false;
                      inverterCompatibility.recommendations.push(
                          `${action.setting} is not supported by this inverter type`
                      );
                  }
              }
          }
      });
      
      compatibility.inverterSpecific[inverterId] = inverterCompatibility;
  });
  
  return compatibility;
}

function generateRulePreview(rule) {
  const preview = {
      summary: generateRuleSummary(rule),
      mappingDetails: generateMappingDetails(rule),
      estimatedImpact: estimateRuleImpact(rule),
      executionFlow: generateExecutionFlow(rule),
      compatibility: checkRuleCompatibility(rule)
  };
  
  return preview;
}

function generateRuleSummary(rule) {
  return {
      name: rule.name,
      description: rule.description,
      active: rule.active,
      conditionCount: rule.conditions ? rule.conditions.length : 0,
      actionCount: rule.actions ? rule.actions.length : 0,
      hasTimeRestrictions: rule.timeRestrictions && rule.timeRestrictions.enabled,
      targetInverters: getTargetInverters(rule.actions),
      complexity: calculateRuleComplexity(rule)
  };
}

function generateMappingDetails(rule) {
  const mappingDetails = {};
  
  rule.actions.forEach((action, index) => {
      const targetInverters = action.inverter === 'all' ? 
          Object.keys(inverterTypes) : [action.inverter];
      
      targetInverters.forEach(inverterId => {
          const inverterInfo = inverterTypes[inverterId];
          if (inverterInfo && willRequireMapping(action.setting, inverterInfo.type)) {
              if (!mappingDetails[inverterId]) {
                  mappingDetails[inverterId] = [];
              }
              
              mappingDetails[inverterId].push({
                  actionIndex: index,
                  originalSetting: action.setting,
                  mappedSetting: getMappedSetting(action.setting, inverterInfo.type),
                  inverterType: inverterInfo.type,
                  confidence: calculateConfidenceScore(inverterInfo)
              });
          }
      });
  });
  
  return mappingDetails;
}

function estimateRuleImpact(rule) {
  return {
      energyImpact: estimateEnergyImpact(rule),
      systemLoad: estimateSystemLoad(rule),
      batteryImpact: estimateBatteryImpact(rule),
      costImpact: estimateCostImpact(rule)
  };
}

function generateExecutionFlow(rule) {
  const flow = [];
  
  // Add condition evaluation
  if (rule.conditions && rule.conditions.length > 0) {
      flow.push({
          step: 'condition_evaluation',
          description: `Evaluate ${rule.conditions.length} condition(s)`,
          conditions: rule.conditions
      });
  }
  
  // Add time restriction check
  if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
      flow.push({
          step: 'time_check',
          description: 'Check time restrictions',
          restrictions: rule.timeRestrictions
      });
  }
  
  // Add action execution
  rule.actions.forEach((action, index) => {
      flow.push({
          step: 'action_execution',
          description: `Execute action ${index + 1}: Set ${action.setting} to ${action.value}`,
          action: action,
          targetInverters: action.inverter === 'all' ? 
              Object.keys(inverterTypes) : [action.inverter]
      });
  });
  
  return flow;
}

function getTargetInverters(actions) {
  const targets = new Set();
  
  actions.forEach(action => {
      if (action.inverter === 'all') {
          Object.keys(inverterTypes).forEach(id => targets.add(id));
      } else {
          targets.add(action.inverter);
      }
  });
  
  return Array.from(targets);
}

function calculateRuleComplexity(rule) {
  let complexity = 0;
  
  // Conditions add complexity
  complexity += (rule.conditions || []).length * 2;
  
  // Actions add complexity
  complexity += (rule.actions || []).length * 3;
  
  // Time restrictions add complexity
  if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
      complexity += 5;
  }
  
  // Multiple target inverters add complexity
  const targetCount = getTargetInverters(rule.actions).length;
  complexity += targetCount * 1;
  
  return Math.min(complexity, 100);
}

function estimateEnergyImpact(rule) {
  // Simplified energy impact estimation
  const impacts = [];
  
  rule.actions.forEach(action => {
      switch (action.setting) {
          case 'grid_charge':
          case 'charger_source_priority':
              impacts.push(action.value.includes('Enabled') || action.value.includes('first') ? 'medium_increase' : 'medium_decrease');
              break;
          case 'energy_pattern':
          case 'output_source_priority':
              impacts.push('medium_change');
              break;
          case 'max_charge_current':
          case 'max_discharge_current':
              impacts.push('low_change');
              break;
          default:
              impacts.push('minimal_change');
      }
  });
  
  return {
      level: impacts.includes('medium_increase') ? 'medium' : 'low',
      description: 'Estimated based on action types',
      factors: impacts
  };
}

function estimateSystemLoad(rule) {
  const actionCount = rule.actions ? rule.actions.length : 0;
  const conditionCount = rule.conditions ? rule.conditions.length : 0;
  
  let load = 'low';
  if (actionCount > 3 || conditionCount > 5) {
      load = 'medium';
  }
  if (actionCount > 6 || conditionCount > 10) {
      load = 'high';
  }
  
  return {
      level: load,
      description: `Based on ${actionCount} actions and ${conditionCount} conditions`
  };
}

function estimateBatteryImpact(rule) {
  const batteryActions = rule.actions.filter(action => 
      action.setting.includes('charge') || 
      action.setting.includes('battery') ||
      action.setting.includes('discharge')
  );
  
  return {
      level: batteryActions.length > 0 ? 'medium' : 'low',
      description: `${batteryActions.length} battery-related actions`,
      affectedSettings: batteryActions.map(a => a.setting)
  };
}

function estimateCostImpact(rule) {
  const costImpactActions = rule.actions.filter(action => 
      action.setting === 'grid_charge' ||
      action.setting === 'charger_source_priority' ||
      action.setting.includes('sell')
  );
  
  return {
      level: costImpactActions.length > 0 ? 'medium' : 'low',
      description: `${costImpactActions.length} cost-affecting actions`,
      potentialSavings: costImpactActions.length > 0 ? 'possible' : 'minimal'
  };
}


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
  
mqttClient.on('connect', async () => {
      try {
        console.log('✅ Connected to MQTT broker')
        await new Promise((resolve, reject) => {
          mqttClient.subscribe(`${mqttTopicPrefix}/#`, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        console.log(`📡 Subscribed to ${mqttTopicPrefix}/#`);
        
        // Initialize AI Charging Engine after MQTT is ready
        console.log('🤖 Scheduling AI Engine initialization...');
        setTimeout(initializeAIEngine, 3000); // Wait 3 seconds for system to stabilize
        
      } catch (error) {
        console.error('Error subscribing to topics:', error.message);
      }
    })
  
    mqttClient.on('message', (topic, message) => {
      const formattedMessage = `${topic}: ${message.toString()}`
      incomingMessages.push(formattedMessage)
      if (incomingMessages.length > MAX_MESSAGES) {
        incomingMessages.shift()
      }
      
      // Call the enhanced MQTT message handler with inverter type detection
      handleMqttMessage(topic, message)
      
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



// AI CHARGING ENGINE INITIALIZATION
// ============================================================================

function initializeAIEngine() {
  if (aiEngineInitialized) {
    console.log('⚠️  AI Engine already initialized');
    return;
  }
  
  if (!mqttClient || !mqttClient.connected) {
    console.log('⚠️  Cannot initialize AI Engine: MQTT not connected');
    return;
  }
  
  if (!currentSystemState) {
    console.log('⚠️  Cannot initialize AI Engine: No system state available');
    return;
  }
  
  try {
    console.log('🤖 Initializing AI Charging Engine...');
    aiChargingEngine.initialize(mqttClient, currentSystemState);
    aiEngineInitialized = true;
    console.log('✅ AI Charging Engine initialized successfully');
    
    // Auto-start if Tibber is configured
    if (tibberService.config.enabled && 
        tibberService.config.apiKey && 
        tibberService.config.homeId) {
      console.log('🔋 Auto-starting AI Charging Engine...');
      aiChargingEngine.start();
    }
  } catch (error) {
    console.error('❌ Error initializing AI Engine:', error.message);
  }
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
  
// Enhanced periodic rule evaluation with inverter type awareness
cron.schedule('*/5 * * * *', () => {
  console.log('Running scheduled rule evaluation...')
  processRules()
})
  
  // Weekend rules scheduling
  cron.schedule('0 0 * * 6', () => {
    console.log('Saturday: Weekend settings may apply based on rules')
  })
  
  cron.schedule('0 0 * * 1', () => {
    console.log('Monday: Weekday settings may apply based on rules')
  })
  
  // Run database maintenance once per day
  cron.schedule('0 0 * * *', async () => {
    console.log('Running scheduled database maintenance...');
    if (dbConnected) {
      await pruneOldSettingsChanges();
    }
  });
  
  // Clean up stale settings state every 4 hours
  cron.schedule('0 */4 * * *', cleanupCurrentSettingsState);
  
  // Enhanced inverter type detection cleanup - every 6 hours
  cron.schedule('0 */6 * * *', () => {
    console.log('Running inverter type detection cleanup...');
    
    // Clean up inverter types that haven't been seen in 24 hours
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    
    Object.keys(inverterTypes).forEach(inverterId => {
      const inverterData = inverterTypes[inverterId];
      
      // Check if this inverter has recent activity in current settings
      let hasRecentActivity = false;
      Object.keys(currentSettingsState).forEach(category => {
        if (typeof currentSettingsState[category] === 'object' && 
            currentSettingsState[category][inverterId] &&
            currentSettingsState[category][inverterId].lastUpdated) {
          const lastUpdated = new Date(currentSettingsState[category][inverterId].lastUpdated).getTime();
          if (lastUpdated > oneDayAgo) {
            hasRecentActivity = true;
          }
        }
      });
      
      // Remove inverter type data if no recent activity
      if (!hasRecentActivity && inverterData.detectionConfidence < 20) {
        delete inverterTypes[inverterId];
        console.log(`Removed stale inverter type data for ${inverterId}`);
      }
    });
  });
  
  
// ================ COMPLETE ENHANCED INITIALIZATION FUNCTION ================

async function initializeConnections() {
  // Create required directories
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  // Connect to MQTT broker
  connectToMqtt();
  
  // Connect to WebSocket broker
  connectToWebSocketBroker();
  
  // Initialize warning service
  const warningService = require('./services/warningService');
  console.log('✅ Warning service initialized');
  
  // Initialize Telegram service
  const telegramService = require('./services/telegramService');
  console.log('✅ Telegram notification service initialized');
  
  // Initialize data
  await initializeData();
  
  // Setup global variables
  try {
    global.mqttClient = mqttClient;
    global.currentSystemState = currentSystemState;
    global.inverterTypes = inverterTypes;
    
    console.log('✅ Global variables initialized with intelligent inverter type support');
  } catch (error) {
    console.error('❌ Error initializing global variables:', error);
  }
  
  // Connect to database with error handling
  try {
    await initializeDatabase();
    
    if (dbConnected) {
      // Initialize automation rules after database is ready
      await initializeAutomationRules();
    } else {
      console.warn('⚠️  Database not connected, will retry in 10 seconds');
      setTimeout(retryDatabaseConnection, 10000);
    }
  } catch (err) {
    console.error('❌ Initial database connection failed:', err);
    setTimeout(retryDatabaseConnection, 10000);
  }
  
  console.log('✅ System initialization complete with intelligent inverter type auto-detection support');
}

  // ================ ENHANCED DYNAMIC PRICING DATA INITIALIZATION ================

  async function initializeData() {
    try {
      console.log('Initializing data with inverter type support...');
      
      const DYNAMIC_PRICING_CONFIG_FILE = path.join(__dirname, 'data', 'dynamic_pricing_config.json');
      
      let config = null;
      if (fs.existsSync(DYNAMIC_PRICING_CONFIG_FILE)) {
        const configData = fs.readFileSync(DYNAMIC_PRICING_CONFIG_FILE, 'utf8');
        config = JSON.parse(configData);
      }
      
      if (!config) {
        console.log('No config found, creating default with inverter type support...');
        config = {
          enabled: false,
          country: 'DE',
          market: 'DE', 
          apiKey: '',
          priceBasedCharging: {
            enabled: true,
            maxPriceThreshold: 0.25,
            useTibberLevels: true,
            lowPriceLevels: ['VERY_CHEAP', 'CHEAP']
          },
          battery: {
            targetSoC: 80,
            minimumSoC: 20,
            emergencySoC: 10,
            maxSoC: 95
          },
          conditions: {
            weather: {
              enabled: false,
              chargeOnCloudyDays: true,
              chargeBeforeStorm: true,
              weatherApiKey: '',
              location: { lat: 52.5200, lon: 13.4050 }
            },
            time: {
              enabled: true,
              preferNightCharging: false,
              nightStart: '22:00',
              nightEnd: '06:00',
              avoidPeakHours: true,
              peakStart: '17:00',
              peakEnd: '21:00'
            },
            power: {
              load: { enabled: false, maxLoadForCharging: 8000, minLoadForCharging: 0 },
              pv: { enabled: false, minPvForCharging: 5000, maxPvForCharging: 50000, pvPriority: true },
              battery: { enabled: false, maxBatteryPowerForCharging: 3000, preferLowBatteryPower: true }
            }
          },
          cooldown: {
            enabled: true,
            chargingCooldownMinutes: 30,
            errorCooldownMinutes: 60,
            maxChargingCyclesPerDay: 6
          },
          scheduledCharging: false,
          chargingHours: [],
          lastUpdate: null,
          pricingData: [],
          timezone: 'Europe/Berlin',
          currency: 'EUR',
          // Features
          inverterSupport: true,
          autoCommandMapping: true,
          intelligentCurrentAdjustment: true,
          supportedInverterTypes: ['legacy', 'new', 'hybrid']
        };
      } else {
        // Ensure features are present in existing config
        if (!config.inverterSupport) {
          config.inverterSupport = true;
          config.autoCommandMapping = true;
          config.intelligentCurrentAdjustment = true;
          config.supportedInverterTypes = ['legacy', 'new', 'hybrid'];
          console.log('✅ Added inverter type support to existing configuration');
        }
      }
      
      const hasData = config.pricingData && config.pricingData.length > 0;
      const isRecent = config.lastUpdate && 
        (Date.now() - new Date(config.lastUpdate).getTime()) < (6 * 60 * 60 * 1000);
      
      if (!hasData || !isRecent) {
        console.log('Generating initial pricing data with inverter type awareness...');
        
        config.pricingData = generateInitialSampleData(config.timezone || 'Europe/Berlin');
        config.lastUpdate = new Date().toISOString();
        
        const configDir = path.dirname(DYNAMIC_PRICING_CONFIG_FILE);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        
        fs.writeFileSync(DYNAMIC_PRICING_CONFIG_FILE, JSON.stringify(config, null, 2));
        
        console.log(`✅ Initial pricing data generated: ${config.pricingData.length} data points with inverter type support`);
      } else {
        console.log('✅ Existing pricing data is recent, no generation needed');
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error initializing data:', error);
      return false;
    }
  }
  


// ================ ENHANCED NOTIFICATION SYSTEM INITIALIZATION ================

async function initializeNotificationSystem() {
  try {
    ensureTelegramConfigExists();
    setupWarningChecks();
    global.processRules = processRules;
    
    console.log('✅ Enhanced user-controlled notification system initialized with inverter type support');
    return true;
  } catch (error) {
    console.error('❌ Error initializing enhanced notification system:', error);
    return false;
  }
}

function ensureTelegramConfigExists() {
  const configDir = path.dirname(TELEGRAM_CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) {
    const defaultConfig = {
      enabled: false,
      botToken: '',
      chatIds: [],
      notificationRules: [],
      enhancedFeatures: true,
      inverterTypeSupport: true
    };
    
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    console.log('Created default enhanced Telegram configuration file with inverter type support (no automatic notifications)');
  }
}
  

// ================ ENHANCED WARNING CHECKS WITH INVERTER TYPE SUPPORT ================

function setupWarningChecks() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      console.log('Running scheduled enhanced warning check with inverter type awareness...');
      
      const triggeredWarnings = warningService.checkWarnings(currentSystemState);
      
      if (triggeredWarnings.length > 0) {
        console.log(`Found ${triggeredWarnings.length} warning(s) to process with enhanced features`);
      }
      
      for (const warning of triggeredWarnings) {
        try {
          if (telegramService.shouldNotifyForWarning(warning.warningTypeId)) {
            const message = telegramService.formatWarningMessage(warning, currentSystemState);
            const sent = await telegramService.broadcastMessage(message);
            
            if (sent) {
              console.log(`Enhanced user-configured warning notification sent: ${warning.title}`);
            } else {
              console.error(`Failed to send enhanced user-configured notification for warning: ${warning.title}`);
            }
          } else {
            console.log(`Skipping notification for warning (${warning.title}) - not configured by user`);
          }
        } catch (notifyError) {
          console.error(`Error in enhanced user-configured warning notification process:`, notifyError);
        }
      }
    } catch (error) {
      console.error('Error checking for enhanced warnings:', error);
    }
  });
  
  console.log('✅ Enhanced warning check scheduler initialized with inverter type support (user-controlled notifications)');
}

// ================ ENHANCED AUTOMATION RULES INITIALIZATION ================

function initializeAutomationRules() {
  try {
    console.log('🔧 Initializing dynamic automation rules based on inverter types...');
    
    // Wait a bit for initial inverter type detection
    setTimeout(() => {
      // Analyze current inverter environment
      const detectedTypes = analyzeInverterTypes();
      console.log(`📊 Inverter environment: ${detectedTypes.summary}`);
      
      // Create rules dynamically based on detected types
      createDefaultRules();
      createExtendedAutomationRules();
      createNightChargingRule();
      createWeekendGridChargeRules();
      
      console.log('✅ Dynamic automation rules initialized successfully');
      console.log(`📋 Rules created for: ${detectedTypes.summary}`);
      
      if (detectedTypes.hasLegacy && detectedTypes.hasNew) {
        console.log('🔄 Mixed environment detected - rules will use auto-mapping');
      }
    }, 2000);
  } catch (error) {
    console.error('Error initializing dynamic automation rules:', error.message);
  }
}
  
  
// ================ ENHANCED DIRECTORY CREATION ================

function ensureDirectoriesExist() {
  const directories = [
    path.join(__dirname, 'data'),
    path.join(__dirname, 'logs'),
    path.join(__dirname, 'grafana', 'provisioning', 'dashboards')
  ];
  
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created enhanced directory: ${dir}`);
    }
  });
}

ensureDirectoriesExist();
  
  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error('Enhanced system error:', err.stack);
    
    // Log enhanced error information
    if (err.message && err.message.includes('pricing')) {
      console.error('Enhanced Dynamic Pricing Error:', {
        message: err.message,
        inverterTypes: global.inverterTypes ? Object.keys(global.inverterTypes).length : 0,
        dynamicPricingEnabled: false
      });
    }
    
    res.status(500).json({ 
      error: 'Enhanced system error occurred',
      enhanced: true,
      timestamp: new Date().toISOString()
    });
  });
  

  
  // Refresh pricing data every 6 hours
  cron.schedule('0 */6 * * *', () => {
    refreshPricingData();
  });
  
  // Refresh pricing data every hour during peak hours (7-9 AM and 5-9 PM)
  cron.schedule('0 7-9,17-21 * * *', () => {
    console.log('Running peak-hour pricing data refresh...');
    refreshPricingData();
  });
  
  // Clean up stale settings state every 4 hours
  cron.schedule('0 */4 * * *', cleanupCurrentSettingsState);
  
  console.log('✅ Dynamic pricing cron jobs initialized');

  // ================ ENHANCED PERIODIC STATUS REPORTING ================

// Enhanced status reporting every 30 minutes
cron.schedule('0,30 * * * *', () => {
  try {
    console.log('📋 Enhanced System Status Report:');
    
    // Report inverter type detection status
    if (global.inverterTypes && Object.keys(global.inverterTypes).length > 0) {
      const typesSummary = {};
      Object.values(global.inverterTypes).forEach(inverter => {
        const type = inverter.type || 'unknown';
        typesSummary[type] = (typesSummary[type] || 0) + 1;
      });
      
      const summary = Object.entries(typesSummary)
        .map(([type, count]) => `${count}x${type}`)
        .join(', ');
      
      console.log(`🔍 Current Inverter Types: ${summary}`);
    } else {
      console.log('🔍 Inverter Type Detection: Still waiting for MQTT messages');
    }
    

    if (global.enhancedDynamicPricing) {
      const status = global.enhancedDynamicPricing.getEnhancedStatus();
      if (status.enabled && status.ready) {
        console.log(`🔋 Enhanced Dynamic Pricing: Active with ${status.totalInverters} inverter(s) under intelligent control`);
      } else if (status.enabled) {
        console.log(`🔋 Enhanced Dynamic Pricing: Enabled but waiting for configuration/data`);
      } else {
        console.log(`🔋 Enhanced Dynamic Pricing: Disabled`);
      }
    }
    
    // Report system health
    const healthStatus = {
      database: dbConnected ? '✅' : '❌',
      mqtt: mqttClient && mqttClient.connected ? '✅' : '❌',
      learnerMode: learnerModeActive ? '✅' : '❌'
    };
    
    console.log(`💊 System Health: DB ${healthStatus.database} | MQTT ${healthStatus.mqtt} | Learner ${healthStatus.learnerMode}`);
    
  } catch (error) {
    console.error('Error in enhanced status reporting:', error);
  }
});
  

// Initialize enhanced connections when server starts
initializeConnections();

// Enhanced server startup with additional status reporting
app.listen(port, () => {
  console.log(`🚀 CARBONOZ SolarAutopilot Server running on port ${port}`);
  console.log(`📊 Monitoring ${inverterNumber} inverter(s) and ${batteryNumber} battery(ies)`);
  console.log(`📡 MQTT Topic Prefix: ${mqttTopicPrefix}`);
  console.log(`🔍 Inverter Type Detection: ACTIVE (auto-detects legacy, new, and hybrid)`);
  console.log(`🔄 Auto-Setting Mapping: ENABLED (intelligent command translation)`);
  console.log(`💡 Learner Mode: ${learnerModeActive ? 'ACTIVE' : 'INACTIVE'}`);
  console.log('🔋 Enhanced System: READY');
  
  // Enhanced status check after 5 seconds
  setTimeout(() => {
    console.log('\n📋 ========== ENHANCED SYSTEM STATUS CHECK ==========');
    
    // Check inverter type detection status
    if (global.inverterTypes && Object.keys(global.inverterTypes).length > 0) {
      const typesSummary = {};
      Object.values(global.inverterTypes).forEach(inverter => {
        const type = inverter.type || 'unknown';
        typesSummary[type] = (typesSummary[type] || 0) + 1;
      });
      
      const summary = Object.entries(typesSummary)
        .map(([type, count]) => `${count}x ${type}`)
        .join(', ');
      
      console.log(`🔍 Detected Inverter Types: ${summary}`);
    } else {
      console.log('🔍 Inverter Type Detection: Waiting for MQTT messages...');
    }
    

    if (global.enhancedDynamicPricing) {
      const status = global.enhancedDynamicPricing.getEnhancedStatus();
      console.log(`🔋 Enhanced Dynamic Pricing Status:`);
      console.log(`   • Enabled: ${status.enabled ? '✅' : '❌'}`);
      console.log(`   • Ready: ${status.ready ? '✅' : '❌'}`);
      console.log(`   • Inverter Type Support: ${status.supportsInverterTypes ? '✅' : '❌'}`);
      console.log(`   • Auto Command Mapping: ${status.autoCommandMapping ? '✅' : '❌'}`);
      console.log(`   • Total Inverters: ${status.totalInverters || 0}`);
      console.log(`   • Detection Status: ${status.inverterDetectionStatus || 'unknown'}`);
      
      if (status.configuration) {
        console.log(`   • Country: ${status.configuration.country || 'not set'}`);
        console.log(`   • Has API Key: ${status.configuration.hasApiKey ? '✅' : '❌'}`);
        console.log(`   • Data Points: ${status.configuration.dataPoints || 0}`);
      }
    }
    
    // Check database connection
    console.log(`🗄️  Database Connection: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}`);
    
    // Check MQTT connection
    console.log(`📡 MQTT Connection: ${mqttClient && mqttClient.connected ? '✅ Connected' : '❌ Disconnected'}`);
    
    console.log('======================================================\n');
    
    console.log('🎯 Enhanced System Ready!');
    console.log('   • Auto-detects and manages both legacy and new inverter types');
    console.log('   • Intelligently maps commands to appropriate MQTT topics');

    console.log('   • Maintains backward compatibility with existing systems');
    console.log('   • Delivers enhanced monitoring and control capabilities\n');
  }, 5000);
  
  console.log('\n🎯 Enhanced system ready to auto-detect and manage all inverter types!');
});
  
 // ================ ENHANCED DYNAMIC PRICING WITH COMPLETE INVERTER TYPE MAPPING ================


// Dynamic pricing command override removed
function sendGridChargeCommand(enable) {
    if (!learnerModeActive) {
      console.log('Dynamic pricing: Would send grid charge command with intelligent inverter type detection, but learner mode is not active');
      return false;
    }
    
    if (!mqttClient || !mqttClient.connected) {
      console.error('MQTT client is not connected, cannot send grid charge command with inverter type support');
      return false;
    }
    
    try {
      const commandValue = enable ? 'Enabled' : 'Disabled';
      let commandsSent = 0;
      let totalInverters = 0;
      let inverterTypesSummary = {
        legacy: 0,
        new: 0,
        hybrid: 0,
        unknown: 0
      };
      
      console.log(`🔋 Dynamic Pricing: Processing grid charging ${enable ? 'enable' : 'disable'} command for ${inverterNumber} inverter(s) with intelligent type auto-detection`);
      
      // Apply to each inverter with type-aware mapping
      for (let i = 1; i <= inverterNumber; i++) {
        const inverterId = `inverter_${i}`;
        const inverterType = getInverterType(inverterId);
        
        // Track inverter types for summary
        inverterTypesSummary[inverterType] = (inverterTypesSummary[inverterType] || 0) + 1;
        
        let topic, mqttValue;
        
        if (inverterType === 'new' || inverterType === 'hybrid') {
          // Use new charger_source_priority for new inverters
          const mappedValue = mapGridChargeToChargerSourcePriority(commandValue);
          topic = `${mqttTopicPrefix}/${inverterId}/charger_source_priority/set`;
          mqttValue = mappedValue;
          console.log(`🔄 Dynamic Pricing: Auto-mapped grid_charge "${commandValue}" to charger_source_priority "${mappedValue}" for ${inverterId} (type: ${inverterType})`);
        } else {
          // Use legacy grid_charge for legacy inverters or unknown types (safer fallback)
          topic = `${mqttTopicPrefix}/${inverterId}/grid_charge/set`;
          mqttValue = commandValue;
          console.log(`🔄 Dynamic Pricing: Using legacy grid_charge "${commandValue}" for ${inverterId} (type: ${inverterType})`);
        }
        
        mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
          if (err) {
            console.error(`❌ Error publishing to ${topic}: ${err.message}`);
          } else {
            commandsSent++;
          }
        });
        
        totalInverters++;
      }
      
      // Generate summary of inverter types for logging
      const typesSummaryText = Object.entries(inverterTypesSummary)
        .filter(([type, count]) => count > 0)
        .map(([type, count]) => `${count}x${type}`)
        .join(', ');
      
      const action = enable ? 'enabled' : 'disabled';
      console.log(`🔋 Dynamic Pricing: Grid charging ${action} for ${totalInverters} inverter(s) with intelligent type detection (${typesSummaryText}) - Commands sent: ${commandsSent}/${totalInverters}`);
      
      // Logging with detailed inverter type information
      // Dynamic pricing integration removed
      console.log(`Grid charging ${action} for ${totalInverters} inverter(s) with intelligent type auto-detection (${typesSummaryText}) - command mapping applied`);
      
      return commandsSent > 0;
    } catch (error) {
      console.error('❌ Error in grid charge command with inverter type support:', error);
      return false;
    }
  }

// ================ ENHANCED GLOBAL FUNCTIONS FOR DYNAMIC PRICING ================

// Make enhanced functions available globally for other modules
global.dynamicPricing = {
  getInstance: () => null,
  getInverterTypeSummary: () => {
    try {
      if (!global.inverterTypes || Object.keys(global.inverterTypes).length === 0) {
        return '(inverter types: detection pending)';
      }
      
      const typesSummary = {};
      Object.values(global.inverterTypes).forEach(inverter => {
        const type = inverter.type || 'unknown';
        typesSummary[type] = (typesSummary[type] || 0) + 1;
      });
      
      const summary = Object.entries(typesSummary)
        .map(([type, count]) => `${count}x${type}`)
        .join(', ');
      
      return `(inverter types: ${summary})`;
    } catch (error) {
      return '(inverter types: error)';
    }
  },
  sendGridChargeCommand: (enable) => {
    // Dynamic pricing removed
    return false;
  },
  setBatteryParameter: (parameter, value) => {
    // Dynamic pricing removed
    return false;
  },
  setWorkMode: (workMode) => {
    // Dynamic pricing removed
    return false;
  },
  getStatus: () => {
    // Dynamic pricing removed
    return { enabled: false };
  }
};


// Test connection
app.post('/api/tibber/test', async (req, res) => {
  try {
    console.log('🔍 Testing Tibber API connection...');
    
    if (!tibberService.config.apiKey || tibberService.config.apiKey === '***') {
      return res.json({
        success: false,
        error: 'No API key configured or API key is masked. Please enter your API key.'
      });
    }
    
    const testResult = await tibberService.testConnection();
    
    if (testResult.success) {
      console.log('✅ Connection test passed');
    } else {
      console.error('❌ Connection test failed:', testResult.error);
    }
    
    res.json({ 
      success: testResult.success, 
      user: testResult.user,
      error: testResult.error,
      message: testResult.success ? 'Connection successful!' : 'Connection failed'
    });
  } catch (error) {
    console.error('❌ Error in connection test:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Run diagnostics
app.get('/api/tibber/diagnose', async (req, res) => {
  try {
    console.log('🩺 Running Tibber diagnostics...');
    
    const diagResults = {
      timestamp: new Date().toISOString(),
      config: {
        enabled: tibberService.config.enabled,
        hasApiKey: !!tibberService.config.apiKey,
        apiKeyMasked: tibberService.config.apiKey === '***',
        apiKeyLength: tibberService.config.apiKey && tibberService.config.apiKey !== '***' 
          ? tibberService.config.apiKey.length 
          : 0,
        hasHomeId: !!tibberService.config.homeId,
        homeId: tibberService.config.homeId || null,
        country: tibberService.config.country,
        timezone: tibberService.config.timezone,
        currency: tibberService.config.currency,
        targetSoC: tibberService.config.targetSoC,
        minimumSoC: tibberService.config.minimumSoC,
        usePriceLevels: tibberService.config.usePriceLevels,
        allowedPriceLevels: tibberService.config.allowedPriceLevels,
        configFileExists: require('fs').existsSync(tibberService.configFile)
      },
      cache: {
        cacheFileExists: require('fs').existsSync(tibberService.cacheFile),
        hasCurrentPrice: !!tibberService.cache.currentPrice,
        currentPrice: tibberService.cache.currentPrice?.total || null,
        priceLevel: tibberService.cache.currentPrice?.level || null,
        currency: tibberService.cache.currentPrice?.currency || null,
        forecastItems: tibberService.cache.forecast.length,
        lastUpdate: tibberService.lastUpdate,
        cacheTimestamp: tibberService.cache.timestamp,
        cacheAgeSeconds: tibberService.cache.timestamp 
          ? Math.floor((Date.now() - tibberService.cache.timestamp) / 1000)
          : null
      },
      status: tibberService.getStatus(),
      aiEngine: {
        initialized: aiEngineInitialized,
        ...aiChargingEngine.getStatus()
      },
      system: {
        mqttConnected: mqttClient?.connected || false,
        hasSystemState: !!currentSystemState,
        battery_soc: currentSystemState?.battery_soc || null,
        learnerModeActive: global.learnerModeActive || false
      }
    };

    // Test connection if API key is present and not masked
    if (tibberService.config.apiKey && tibberService.config.apiKey !== '***') {
      console.log('🔍 Testing API connection...');
      diagResults.connectionTest = await tibberService.testConnection();
    } else {
      diagResults.connectionTest = {
        success: false,
        error: 'No valid API key configured or API key is masked'
      };
    }

    console.log('✅ Diagnostics complete');
    res.json({ success: true, diagnostics: diagResults });
  } catch (error) {
    console.error('❌ Error running diagnostics:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Initialize AI Engine
app.post('/api/tibber/initialize', async (req, res) => {
  try {
    if (aiEngineInitialized) {
      return res.json({ 
        success: true, 
        message: 'Already initialized' 
      });
    }
    
    initializeAIEngine();
    
    res.json({ 
      success: aiEngineInitialized, 
      message: aiEngineInitialized ? 'Initialized' : 'Failed to initialize'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get config
app.get('/api/tibber/config', (req, res) => {
  try {
    const config = tibberService.config;
    const safeConfig = { 
      ...config, 
      apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : '' 
    };
    res.json({ success: true, config: safeConfig });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update Tibber configuration
app.post('/api/tibber/config', async (req, res) => {
  try {
    const { 
      enabled, 
      apiKey, 
      homeId, 
      targetSoC, 
      minimumSoC, 
      usePriceLevels, 
      allowedPriceLevels, 
      maxPriceThreshold,
      country,
      timezone,
      currency
    } = req.body;
    
    const updates = {};
    
    if (enabled !== undefined) updates.enabled = !!enabled;
    
    // CRITICAL: Don't save masked API key
    if (apiKey !== undefined && apiKey !== '***' && apiKey !== '******' && apiKey.trim() !== '') {
      updates.apiKey = apiKey.trim();
      console.log(`✅ Updating API key (length: ${apiKey.trim().length})`);
    } else if (apiKey === '***' || apiKey === '******') {
      console.log('ℹ️  Skipping masked API key - keeping existing key');
    }
    
    // homeId is optional now
    if (homeId !== undefined && homeId !== '') {
      updates.homeId = homeId;
      console.log('ℹ️  HomeId provided:', homeId);
    }
    
    if (targetSoC !== undefined) updates.targetSoC = parseInt(targetSoC);
    if (minimumSoC !== undefined) updates.minimumSoC = parseInt(minimumSoC);
    if (usePriceLevels !== undefined) updates.usePriceLevels = !!usePriceLevels;
    if (allowedPriceLevels !== undefined) updates.allowedPriceLevels = allowedPriceLevels;
    if (maxPriceThreshold !== undefined) updates.maxPriceThreshold = maxPriceThreshold;
    
    // CRITICAL: Handle null/undefined country codes
    if (country !== undefined && country !== null && country !== '') {
      updates.country = country;
    }
    if (timezone !== undefined && timezone !== null && timezone !== '') {
      updates.timezone = timezone;
    }
    if (currency !== undefined && currency !== null && currency !== '') {
      updates.currency = currency;
    }
    
    const config = tibberService.updateConfig(updates);
    
    // ALWAYS mask API key when sending to frontend
    const safeConfig = { 
      ...config, 
      apiKey: config.apiKey && config.apiKey.trim() !== '' ? '***' : '' 
    };
    
    console.log('✅ Tibber configuration updated successfully');
    
    res.json({ 
      success: true, 
      config: safeConfig, 
      message: 'Configuration updated successfully' 
    });
  } catch (error) {
    console.error('❌ Error updating Tibber config:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Enable/disable Tibber integration - FIXED: removed homeId check
app.post('/api/tibber/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    tibberService.updateConfig({ enabled: !!enabled });
    
    if (enabled) {
      console.log('🔄 Tibber enabled, refreshing data...');
      
      // Only check for API key (homeId is optional)
      if (tibberService.config.apiKey && 
          tibberService.config.apiKey !== '***') {
        await tibberService.refreshData();
      } else {
        console.log('⚠️  No valid API key, skipping data refresh');
      }
    } else {
      console.log('⏸️  Tibber disabled');
    }
    
    res.json({ 
      success: true, 
      enabled: !!enabled,
      message: `Tibber integration ${enabled ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    console.error('❌ Error toggling Tibber:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get current Tibber price data - FIXED: removed homeId requirement
app.get('/api/tibber/prices', async (req, res) => {
  try {
    const status = tibberService.getStatus();
    
    // Check if Tibber is configured (only API key required now)
    if (!status.configured) {
      return res.json({
        success: false,
        error: 'Tibber not configured. Please configure API key in settings.',
        data: null,
        status
      });
    }

    // If no cached data or data is stale, try to fetch fresh data
    if (!status.hasCachedData) {
      console.log('📊 No cached data, fetching from Tibber API...');
      const refreshed = await tibberService.refreshData();
      
      if (!refreshed) {
        return res.json({
          success: false,
          error: 'No cached data available and unable to fetch new data from Tibber API',
          data: null,
          status: tibberService.getStatus()
        });
      }
    }

    const data = tibberService.getCachedData();
    const updatedStatus = tibberService.getStatus();
    
    res.json({ 
      success: true, 
      data,
      status: updatedStatus
    });
  } catch (error) {
    console.error('❌ Error getting prices:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      data: null
    });
  }
});

// Refresh Tibber data - FIXED: removed homeId requirement
app.post('/api/tibber/refresh', async (req, res) => {
  try {
    console.log('🔄 Manual refresh requested');
    
    // Validate configuration - only API key required
    if (!tibberService.config.enabled) {
      return res.json({ 
        success: false, 
        error: 'Tibber integration is disabled. Enable it in settings first.' 
      });
    }

    if (!tibberService.config.apiKey || tibberService.config.apiKey === '***') {
      return res.json({ 
        success: false, 
        error: 'Tibber API key not configured or is masked. Please re-enter your API key.' 
      });
    }

    // homeId is now optional - will use first home automatically
    console.log('📊 Fetching Tibber data (homeId optional - will auto-select)...');

    // Attempt refresh
    const success = await tibberService.refreshData();
    
    if (success) {
      const data = tibberService.getCachedData();
      console.log('✅ Manual refresh successful');
      res.json({ 
        success: true, 
        message: 'Tibber data refreshed successfully',
        data
      });
    } else {
      console.warn('⚠️  Manual refresh returned false');
      res.json({ 
        success: false, 
        error: 'Failed to refresh data. Check logs for details.',
        suggestion: 'Check your API key, network connection, and run diagnostics.'
      });
    }
  } catch (error) {
    console.error('❌ Error in manual refresh:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get Tibber status
app.get('/api/tibber/status', (req, res) => {
  try {
    const status = tibberService.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    console.error('❌ Error getting Tibber status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Charging Engine Routes

// Get AI engine status
app.get('/api/ai/status', (req, res) => {
  try {
    const status = aiChargingEngine.getStatus();
    res.json({ 
      success: true, 
      status: {
        ...status,
        initialized: aiEngineInitialized
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start/stop AI engine - FIXED: removed homeId requirement
app.post('/api/ai/toggle', (req, res) => {
  try {
    const { enabled } = req.body;
    
    if (!aiEngineInitialized) {
      initializeAIEngine();
      if (!aiEngineInitialized) {
        return res.status(400).json({
          success: false,
          error: 'AI engine not initialized'
        });
      }
    }
    
    if (enabled) {
      // Only check for enabled and API key (homeId is optional)
      if (!tibberService.config.enabled || 
          !tibberService.config.apiKey ||
          tibberService.config.apiKey === '***') {
        return res.status(400).json({
          success: false,
          error: 'Tibber must be configured with valid API key first'
        });
      }
      aiChargingEngine.start();
    } else {
      aiChargingEngine.stop();
    }
    
    res.json({ 
      success: true, 
      enabled: !!enabled,
      message: `AI engine ${enabled ? 'started' : 'stopped'}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual AI evaluation
app.post('/api/ai/evaluate', async (req, res) => {
  try {
    if (!aiEngineInitialized) {
      return res.status(400).json({
        success: false,
        error: 'AI engine not initialized'
      });
    }
    
    const decision = await aiChargingEngine.evaluate();
    res.json({ success: true, decision });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get AI decision history
app.get('/api/ai/history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const history = aiChargingEngine.getDecisionHistory(limit);
    res.json({ success: true, history, count: history.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get predicted charge windows
app.get('/api/ai/predictions', (req, res) => {
  try {
    const predictions = aiChargingEngine.getPredictedChargeWindows();
    res.json({ success: true, predictions, count: predictions.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Charging status endpoint
app.get('/api/ai-charging/status', (req, res) => {
  try {
    const status = aiChargingEngine.getStatus();
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Charging decisions endpoint
app.get('/api/ai-charging/decisions', (req, res) => {
  try {
    const decisions = aiChargingEngine.getDecisionHistory(10);
    res.json({ success: true, decisions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DEPRECATED: Tibber settings have been merged into /settings page
// Keeping this route for backward compatibility - redirects to settings page
app.get('/tibber-settings', (req, res) => {
  res.redirect('/settings');
});

// AI Dashboard page
app.get('/ai-dashboard', (req, res) => {
  try {
    const tibberStatus = tibberService.getStatus();
    const aiStatus = aiChargingEngine.getStatus();
    
    res.render('ai-dashboard', {
      tibberStatus,
      aiStatus,
      ingress_path: process.env.INGRESS_PATH || ''
    });
  } catch (error) {
    console.error('Error rendering dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// Add auto-refresh for Tibber data every 5 minutes - FIXED: removed homeId check
cron.schedule('*/5 * * * *', async () => {
  // Only check for enabled and API key (homeId is optional)
  if (tibberService.config.enabled && 
      tibberService.config.apiKey &&
      tibberService.config.apiKey !== '***') {
    try {
      console.log('🔄 Auto-refresh (cron)...');
      const success = await tibberService.refreshData();
      if (success) {
        console.log('✅ Cron: Data refreshed');
      } else {
        console.warn('⚠️  Cron: Refresh failed');
      }
    } catch (error) {
      console.error('❌ Cron error:', error.message);
    }
  }
});

// Enhanced logging for startup
console.log('\n🔋 ========== ENHANCED DYNAMIC PRICING SYSTEM ==========');
console.log('🔧 Enhanced Features:');
console.log('   ✅ Intelligent Inverter Type Auto-Detection');
console.log('   ✅ Automatic Command Mapping (legacy ↔ new)');
console.log('   ✅ Enhanced Grid Charging Control');
console.log('   ✅ Smart Current Adjustment');
console.log('   ✅ Advanced Price Intelligence (Tibber)');
console.log('   ✅ Real-time Type Adaptation');
console.log('   ✅ Enhanced Logging & Status Reporting');
console.log('   ✅ Backward Compatibility');
console.log('============================================================\n');
console.log('\n🔋 ========== TIBBER & AI CHARGING ==========');
console.log('   ✅ Tibber Price Integration');
console.log('   ✅ AI Charging Decisions');
console.log('   ✅ Real-time Monitoring');
console.log('   ✅ Automatic Optimization');
console.log('==============================================\n');

// Run diagnostics after 10 seconds
setTimeout(async () => {
  console.log('\n🩺 === STARTUP DIAGNOSTICS ===');
  
  try {
    await tibberService.diagnose();
    
    if (tibberService.config.enabled && 
        tibberService.config.apiKey && 
        tibberService.config.homeId) {
      console.log('\n🔄 Loading initial data...');
      const success = await tibberService.refreshData();
      if (success) {
        console.log('✅ Initial data loaded');
        const data = tibberService.getCachedData();
        if (data.currentPrice) {
          console.log(`💰 Current: ${data.currentPrice.total.toFixed(2)} ${data.currentPrice.currency} (${data.currentPrice.level})`);
        }
      }
    } else {
      console.log('\nℹ️  Tibber not configured');
      console.log('   Configure at: /settings');
    }
    
    console.log('\n🤖 AI Engine:');
    console.log('   - Initialized:', aiEngineInitialized);
    console.log('   - MQTT:', mqttClient?.connected || false);
    console.log('   - System State:', !!currentSystemState);
    
  } catch (error) {
    console.error('❌ Startup error:', error.message);
  }
  
  console.log('\n======================================\n');
}, 10000);

// Test endpoint for JSON parsing
app.post('/api/test-json', (req, res) => {
  console.log('Test JSON endpoint hit');
  console.log('Body type:', typeof req.body);
  console.log('Body content:', req.body);
  
  res.json({
    success: true,
    received: req.body,
    type: typeof req.body
  });
});

app.get('/api/health', (req, res) => {
  try {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB'
      },
      services: {
        mqtt: {
          connected: mqttClient?.connected || false,
          reconnecting: mqttClient?.reconnecting || false,
          status: mqttClient?.connected ? 'healthy' : 'disconnected'
        },
        database: {
          connected: dbConnected || false,
          status: dbConnected ? 'healthy' : 'disconnected'
        },
        tibber: {
          enabled: tibberService?.config?.enabled || false,
          configured: tibberService?.getStatus()?.configured || false,
          hasCachedData: tibberService?.getStatus()?.hasCachedData || false,
          lastUpdate: tibberService?.getStatus()?.lastUpdate || null,
          status: (tibberService?.config?.enabled && tibberService?.getStatus()?.configured) ? 'healthy' : 'not-configured'
        },
        aiEngine: {
          enabled: aiChargingEngine?.enabled || false,
          running: aiChargingEngine?.getStatus()?.running || false,
          lastDecision: aiChargingEngine?.lastDecision?.timestamp || null,
          decisionCount: aiChargingEngine?.decisionHistory?.length || 0,
          status: aiChargingEngine?.getStatus()?.running ? 'running' : 'stopped'
        }
      },
      systemState: {
        battery_soc: currentSystemState?.battery_soc || null,
        pv_power: currentSystemState?.pv_power || null,
        load: currentSystemState?.load || null,
        grid_voltage: currentSystemState?.grid_voltage || null,
        grid_power: currentSystemState?.grid_power || null,
        timestamp: currentSystemState?.timestamp || null
      },
      learnerMode: {
        active: global.learnerModeActive || false
      }
    };
    
    // Determine overall health status
    const criticalServicesDown = !health.services.mqtt.connected || !health.services.database.connected;
    if (criticalServicesDown) {
      health.status = 'degraded';
    }
    
    res.json(health);
  } catch (error) {
    console.error('Error generating health check:', error);
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.use((req, res, next) => {
  // Log the 404 for debugging
  console.log(`⚠️  404 Not Found: ${req.method} ${req.path}`);
  
  // Return standardized 404 response
  res.status(404).json({
    error: "Route not found",
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
    availableEndpoints: [
      '/settings',
      '/ai-dashboard',
      '/api/tibber/prices',
      '/api/tibber/status',
      '/api/ai/status',
      '/api/ai/history',
      '/api/ai/predictions',
      '/api/health'
    ]
  });
});

function GracefulShutdown() {
  console.log('🔄 Starting enhanced graceful shutdown...');
  
  const forceExitTimeout = setTimeout(() => {
    console.error('❌ Forced exit after timeout during enhanced shutdown');
    process.exit(1);
  }, 15000); // Increased timeout for enhanced cleanup
  
  // Stop AI Charging Engine first
  if (aiChargingEngine) {
    console.log('🤖 Stopping AI Charging Engine');
    try {
      aiChargingEngine.stop();
      console.log('✅ AI Charging Engine stopped');
    } catch (error) {
      console.error('❌ Error stopping AI engine:', error.message);
    }
  }
  
  // Enhanced cleanup sequence
  if (jsonStorage) {
    console.log('🗄️  Closing JSON storage');
    try {
      // JSON storage doesn't need explicit closing, just log
      console.log('✅ JSON storage cleanup completed');
    } catch (err) {
      console.error('❌ Error during JSON storage cleanup:', err);
    }
  }
  
  if (mqttClient) {
    console.log('📡 Closing enhanced MQTT connection');
    mqttClient.end(true, () => {
      console.log('📡 Enhanced MQTT connection closed');
    });
  }
  
  if (heartbeatInterval) {
    console.log('💓 Clearing enhanced heartbeat interval');
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Enhanced cleanup
  incomingMessages = [];
  settingsChangesQueue.length = 0;
  
  // Clear enhanced global variables
  if (global.enhancedDynamicPricing) {
    delete global.enhancedDynamicPricing;
  }
  
  // Clear learner mode
  if (global.learnerModeActive !== undefined) {
    delete global.learnerModeActive;
  }
  
  
  console.log('✅ Enhanced cleanup completed');
  clearTimeout(forceExitTimeout);
  console.log('🔋 Enhanced Energy Monitoring System shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', GracefulShutdown);
process.on('SIGINT', GracefulShutdown);


process.on('SIGTERM', GracefulShutdown);
process.on('SIGINT', GracefulShutdown);
