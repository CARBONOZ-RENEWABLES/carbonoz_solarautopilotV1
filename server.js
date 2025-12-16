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
// SQLite removed - not needed for AI engine
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



const GRAFANA_URL = 'http://localhost:3001';
const BASE_PATH = process.env.INGRESS_PATH || '';



// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
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



// ================ ENHANCED STATIC FILE HANDLER ================

// Extract configuration values with defaults
const inverterNumber = options.inverter_number 
const batteryNumber = options.battery_number 
const mqttTopicPrefix = options.mqtt_topic_prefix 

// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json')

const CACHE_DURATION = 24 * 3600000 // 24 hours in milliseconds
// Database file removed - using InfluxDB only
const TELEGRAM_CONFIG_FILE = path.join(__dirname, 'data', 'telegram_config.json')
const WARNINGS_CONFIG_FILE = path.join(__dirname, 'data', 'warnings_config.json')

// Create data directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'))
}

// Database removed - AI engine uses InfluxDB only

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
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
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
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // Increased limit for dashboard requests
  
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
  
  // Skip rate limiting for health checks and dashboard endpoints
  skip: (req) => {
    const skipPaths = ['/health', '/api/health', '/status', '/api/system-state', '/api/ai/', '/api/tibber/'];
    return skipPaths.some(path => req.path.includes(path));
  },
  
  // Return JSON error response instead of HTML
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: Math.round(req.rateLimit.resetTime / 1000)
    });
  }
});

// Apply rate limiting more selectively
app.use('/api/settings', limiter);
app.use('/api/command', limiter);
// Skip rate limiting for dashboard endpoints that need frequent updates

const API_REQUEST_INTERVAL = 500; // 500ms between API requests for better responsiveness

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
  global.influx = influx
  console.log('InfluxDB client initialized')
  
  // IMPORTANT: Initialize Tibber cache from InfluxDB after global.influx is available
  setTimeout(async () => {
    console.log('🔄 Loading Tibber cache from InfluxDB...');
    try {
      await tibberService.initializeInfluxCache();
    } catch (error) {
      console.error('⚠️  Could not load Tibber cache from InfluxDB:', error.message);
    }
  }, 1000); // Small delay to ensure InfluxDB is fully ready
  
} catch (error) {
  console.error('Error initializing InfluxDB client:', error.message)
  influx = {
    writePoints: async () => {
      console.error('InfluxDB not available, data not saved')
      return Promise.resolve()
    }
  }
  global.influx = influx
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
const MAX_MESSAGES = 500

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

// Initialize AI engine after MQTT connection
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
    
    // Pass complete configuration to AI engine
    const aiConfig = {
      inverterNumber: inverterNumber,
      mqttTopicPrefix: mqttTopicPrefix,
      inverterTypes: inverterTypes
    };
    
    aiChargingEngine.initialize(mqttClient, currentSystemState, aiConfig);
    aiEngineInitialized = true;
    console.log('✅ AI Charging Engine initialized successfully');
    console.log(`   • Inverters: ${inverterNumber}`);
    console.log(`   • MQTT Prefix: ${mqttTopicPrefix}`);
    
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

function updateAIEngineConfig() {
  if (aiEngineInitialized && aiChargingEngine) {
    aiChargingEngine.updateConfig({
      inverterNumber: inverterNumber,
      mqttTopicPrefix: mqttTopicPrefix,
      inverterTypes: inverterTypes
    });
  }
}

// ================ DATABASE FUNCTIONS ================

// Database functions removed - AI engine uses InfluxDB only

function cleanupCurrentSettingsState() {
  try {
    const now = Date.now();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    
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

// Database retry removed - AI engine uses InfluxDB only

// ================ SETTINGS CHANGE FUNCTIONS ================

async function saveSettingsChange(changeData) {
  try {
    const oldValueStr = typeof changeData.old_value === 'object' ? 
      JSON.stringify(changeData.old_value) : 
      String(changeData.old_value || '');
    
    const newValueStr = typeof changeData.new_value === 'object' ? 
      JSON.stringify(changeData.new_value) : 
      String(changeData.new_value || '');
    
    const point = {
      measurement: 'settings_changes',
      tags: {
        topic: changeData.topic,
        change_type: changeData.change_type,
        user_id: changeData.user_id,
        mqtt_username: changeData.mqtt_username
      },
      fields: {
        old_value: oldValueStr,
        new_value: newValueStr,
        battery_soc: changeData.system_state?.battery_soc || 0,
        pv_power: changeData.system_state?.pv_power || 0,
        load: changeData.system_state?.load || 0,
        grid_power: changeData.system_state?.grid_power || 0,
        battery_power: changeData.system_state?.battery_power || 0,
        grid_voltage: changeData.system_state?.grid_voltage || 0
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
    
    try {
      await saveSettingsChange(changeData);
    } catch (error) {
      console.error('Error saving to InfluxDB:', error.message);
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
    
    try {
      await saveSettingsChange(changeData);
    } catch (error) {
      console.error('Error saving to InfluxDB:', error.message);
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
    
    try {
      await saveSettingsChange(changeData);
    } catch (error) {
      console.error('Error saving to InfluxDB:', error.message);
    }
    
    sendWorkModeNotification(changeData);
  }
}

// ================ AI ENGINE FUNCTIONS ================

// Rules functionality removed - AI engine only

async function getSettingsChanges(userId, options = {}) {
  try {
    const { changeType, topic, limit = 100 } = options;
    
    let whereClause = `"user_id" = '${userId}'`;
    
    if (changeType) {
      whereClause += ` AND "change_type" = '${changeType}'`;
    }
    
    if (topic) {
      whereClause += ` AND "topic" =~ /${topic}/`;
    }
    
    const query = `
      SELECT * FROM settings_changes 
      WHERE ${whereClause}
      ORDER BY time DESC 
      LIMIT ${limit}
    `;
    
    const result = await influx.query(query);
    
    const formattedChanges = result.map((row, index) => ({
      id: index + 1,
      timestamp: new Date(row.time),
      topic: row.topic,
      old_value: parseJsonOrValue(row.old_value),
      new_value: parseJsonOrValue(row.new_value),
      system_state: {
        battery_soc: row.battery_soc,
        pv_power: row.pv_power,
        load: row.load,
        grid_power: row.grid_power,
        battery_power: row.battery_power,
        grid_voltage: row.grid_voltage
      },
      change_type: row.change_type,
      user_id: row.user_id,
      mqtt_username: row.mqtt_username
    }));
    
    return {
      changes: formattedChanges,
      pagination: {
        total: formattedChanges.length,
        limit,
        skip: 0,
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
  const bufferSize = learnerModeActive ? Math.min(100, MAX_MESSAGES) : MAX_MESSAGES;
  
  const messageStr = message.toString();
  const maxMessageSize = 10000;
  
  const truncatedMessage = messageStr.length > maxMessageSize 
    ? messageStr.substring(0, maxMessageSize) + '... [truncated]' 
    : messageStr;
  
  const formattedMessage = `${topic}: ${truncatedMessage}`;
  
  incomingMessages.push(formattedMessage);
  if (incomingMessages.length > bufferSize) {
    const excess = incomingMessages.length - bufferSize;
    incomingMessages.splice(0, excess); // ✅ Remove multiple items at once
  }

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

  // Rules processing removed - AI engine only

  // Extract inverter ID from the topic
  let inverterId = "inverter_1";
  const inverterMatch = specificTopic.match(/inverter_(\d+)/);
  if (inverterMatch) {
    inverterId = `inverter_${inverterMatch[1]}`;
  }
  
  // Enhanced inverter type detection based on MQTT messages
  detectInverterType(inverterId, specificTopic, messageContent);

  if (aiEngineInitialized) {
  updateAIEngineConfig();
}

  // ========= UPDATE CURRENT SETTINGS STATE FOR AI ENGINE =========
  
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
    
    // Update AI engine system state
    if (aiChargingEngine && aiChargingEngine.updateSystemState) {
      aiChargingEngine.updateSystemState(currentSystemState);
    }
  } else if (specificTopic.match(/battery_\d+\/capacity\/state/)) {
    // Extract battery number dynamically
    const batteryMatch = specificTopic.match(/battery_(\d+)\/capacity\/state/);
    if (batteryMatch) {
      const batteryNum = batteryMatch[1];
      const capacityKey = `battery_${batteryNum}_capacity_ah`;
      currentSystemState[capacityKey] = parseFloat(messageContent);
      
      // Update AI engine with new battery data
      if (aiChargingEngine && aiChargingEngine.updateSystemState) {
        aiChargingEngine.updateSystemState(currentSystemState);
      }
    }
  } else if (specificTopic.includes('battery_voltage/state') || specificTopic.includes('inverter_1/battery_voltage')) {
    currentSystemState.battery_voltage = parseFloat(messageContent);
    // Update AI engine with voltage data
    if (aiChargingEngine && aiChargingEngine.updateSystemState) {
      aiChargingEngine.updateSystemState(currentSystemState);
    }
  } else if (specificTopic.includes('total/pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent);
  } else if (specificTopic.includes('total/load_power')) {
    currentSystemState.load = parseFloat(messageContent);
  } else if (specificTopic.includes('total/grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent);
  } else if (specificTopic.includes('total/grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent);
  } else if (specificTopic.includes('total/battery_power')) {
    currentSystemState.battery_power = parseFloat(messageContent);
  } else if (specificTopic.includes('total/bus_voltage')) {
    currentSystemState.total_battery_voltage = parseFloat(messageContent);
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent;
  } else if (specificTopic.match(/battery_\d+\/capacity\/state/)) {
    // Handle any battery number dynamically
    const batteryMatch = specificTopic.match(/battery_(\d+)\/capacity\/state/);
    if (batteryMatch) {
      const batteryNum = batteryMatch[1];
      const capacityKey = `battery_${batteryNum}_capacity_ah`;
      currentSystemState[capacityKey] = parseFloat(messageContent);
    }
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
    }
  } catch (error) {
    console.error('Error handling enhanced MQTT message with inverter type support:', error.message);
  }

  if (settingsChanges.length > 0) {
    try {
      queueSettingsChanges(settingsChanges);
    } catch (error) {
      console.error('Error queuing enhanced settings changes:', error.message);
    }
  }

  // AI engine handles all automation
}

// Create a settings changes queue with rate limiting
const settingsChangesQueue = [];
const MAX_QUEUE_SIZE = 500;
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

async function executeWithDbMutex(operation) {
  await dbMutex.acquire();
  try {
    return await operation();
  } finally {
    dbMutex.release();
  }
}

async function processSettingsChangesQueue() {
  if (settingsChangesQueue.length === 0) {
    processingQueue = false;
    return;
  }

  try {
    const batchSize = Math.min(50, settingsChangesQueue.length);
    const currentBatch = settingsChangesQueue.splice(0, batchSize);
    
    await batchSaveSettingsChanges(currentBatch);
    
    if (settingsChangesQueue.length > 0) {
      setTimeout(processSettingsChangesQueue, PROCESSING_INTERVAL);
    } else {
      processingQueue = false;
    }
  } catch (error) {
    console.error('Error processing settings changes queue:', error.message);
    processingQueue = false;
    setTimeout(() => {
      processSettingsChangesQueue();
    }, PROCESSING_INTERVAL * 2);
  }
}

async function batchSaveSettingsChanges(changes) {
  if (changes.length === 0) return;
  
  try {
    const points = changes.map(change => {
      const oldValueStr = typeof change.old_value === 'object' ? 
        JSON.stringify(change.old_value) : 
        String(change.old_value || '');
      
      const newValueStr = typeof change.new_value === 'object' ? 
        JSON.stringify(change.new_value) : 
        String(change.new_value || '');
      
      return {
        measurement: 'settings_changes',
        tags: {
          topic: change.topic,
          change_type: change.change_type,
          user_id: change.user_id,
          mqtt_username: change.mqtt_username
        },
        fields: {
          old_value: oldValueStr,
          new_value: newValueStr,
          battery_soc: change.system_state?.battery_soc || 0,
          pv_power: change.system_state?.pv_power || 0,
          load: change.system_state?.load || 0,
          grid_power: change.system_state?.grid_power || 0,
          battery_power: change.system_state?.battery_power || 0,
          grid_voltage: change.system_state?.grid_voltage || 0
        },
        timestamp: change.timestamp
      };
    });
    
    await influx.writePoints(points);
    return true;
  } catch (error) {
    console.error('Error batch saving settings changes to InfluxDB:', error.message);
    return false;
  }
}

const API_REQUEST_LIMIT = new Map();
const MAX_RATE_LIMIT_ENTRIES = 1000;

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
  
  // Allow dashboard endpoints more frequently
  const dashboardEndpoints = ['/api/system-state', '/api/ai/', '/api/tibber/'];
  const isDashboardEndpoint = dashboardEndpoints.some(path => endpoint.includes(path));
  const interval = isDashboardEndpoint ? 100 : API_REQUEST_INTERVAL; // 100ms for dashboard
  
  if (!API_REQUEST_LIMIT.has(key)) {
    API_REQUEST_LIMIT.set(key, now);
    return true;
  }
  
  const timeSinceLastRequest = now - API_REQUEST_LIMIT.get(key);
  if (timeSinceLastRequest < interval) {
    return false;
  }
  
  API_REQUEST_LIMIT.set(key, now);
  return true;
}

function apiRateLimiter(req, res, next) {
  const endpoint = req.originalUrl.split('?')[0];
  const userId = USER_ID;

    // Get client IP safely
    const clientIp = req.ip || 
    req.get('x-forwarded-for')?.split(',')[0]?.trim() || 
    req.get('x-real-ip') || 
    req.connection?.remoteAddress || 
    'unknown';
  
    if (!canMakeRequest(endpoint, userId, clientIp)) {
      console.warn(`API rate limit exceeded for ${clientIp} on ${endpoint}`);
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
        endpoint: endpoint
      });
  }
  
  next();
}

// Rules processing removed - AI engine handles all automation

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
      console.log(
        'Debug: No battery messages found. Current messages:',
        messages.filter((msg) => msg.toLowerCase().includes('battery'))
      )
      return 'Warning: No battery information found in recent messages.'
    }
  
    return null
  }
  
  function debugBatteryMessages(messages) {
    const batteryMessages = messages.filter((msg) =>
      msg.toLowerCase().includes('battery')
    )
    console.log('Current battery-related messages:', batteryMessages)
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

// Initial price data refresh on startup
setTimeout(() => {
  console.log('🚀 Initial price data refresh on startup...');
  refreshPricingData();
}, 5000);

// ================ ROUTERS ================



app.get('/', async (req, res) => {
  // Redirect to energy dashboard as main page
  res.redirect(`${process.env.INGRESS_PATH || ''}/energy-dashboard`);
});

app.get('/energy-dashboard', async (req, res) => {
  try {
    const grafanaHost = getGrafanaHost(req);
    const expectedInverters = parseInt(options.inverter_number) || 1;
    const inverterWarning = checkInverterMessages(incomingMessages, expectedInverters);
    const batteryWarning = checkBatteryInformation(incomingMessages);
    
    // Mock data for energy dashboard
    const todayData = {
      date: new Date().toLocaleDateString(),
      avoidedEmissions: 5.2,
      unavoidableEmissions: 2.1,
      selfSufficiencyScore: 78.5
    };
    
    const summaryData = {
      week: {
        avoidedEmissions: 4.8,
        unavoidableEmissions: 2.3,
        selfSufficiencyScore: 75.2
      },
      month: {
        avoidedEmissions: 18.5,
        unavoidableEmissions: 9.2
      }
    };
    
    res.render('energy-dashboard', {
      ingress_path: process.env.INGRESS_PATH || '',
      grafanaHost: grafanaHost,
      inverterWarning,
      batteryWarning,
      username: options.mqtt_username || 'User',
      todayData,
      summaryData,
      isLoading: false,
      selectedZone: 'DE'
    });
  } catch (error) {
    console.error('Error rendering energy dashboard:', error);
    res.status(500).send('Error loading energy dashboard');
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

  // AI Dashboard route - main dashboard
  app.get('/ai-dashboard', async (req, res) => {
    try {
      const grafanaHost = getGrafanaHost(req);
      const expectedInverters = parseInt(options.inverter_number) || 1;
      const inverterWarning = checkInverterMessages(incomingMessages, expectedInverters);
      const batteryWarning = checkBatteryInformation(incomingMessages);
      
      res.render('ai-dashboard', {
        ingress_path: process.env.INGRESS_PATH || '',
        user_id: USER_ID,
        learner_active: learnerModeActive,
        influx_connected: !!influx,
        mqtt_connected: mqttClient ? mqttClient.connected : false,
        system_state: currentSystemState,
        ai_status: aiChargingEngine.getStatus(),
        tibber_status: tibberService.getStatus(),
        grafanaHost: grafanaHost,
        inverterWarning,
        batteryWarning,
        username: options.mqtt_username || 'User'
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
        system_state: currentSystemState
      });
    } catch (error) {
      console.error('Error getting AI status:', error);
      res.status(500).json({ error: 'Failed to get AI status' });
    }
  });

  app.get('/api/ai/decisions', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const decisions = await aiChargingEngine.getDecisionHistory(limit);
      
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

  app.get('/api/ai/commands', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const commands = await aiChargingEngine.getCommandHistory(limit);
      
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
  app.post('/api/ai/start', async (req, res) => {
    try {
      if (!aiChargingEngine) {
        return res.status(500).json({ error: 'AI Charging Engine not available' });
      }
      
      const result = await aiChargingEngine.start();
      
      res.json({
        success: true,
        message: result?.message || 'AI Charging Engine started successfully',
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
      
      const result = aiChargingEngine.stop();
      
      res.json({
        success: true,
        message: result?.message || 'AI Charging Engine stopped successfully',
        status: aiChargingEngine.getStatus()
      });
    } catch (error) {
      console.error('Error stopping AI engine:', error);
      res.status(500).json({ error: 'Failed to stop AI engine' });
    }
  });

  app.post('/api/ai/toggle', async (req, res) => {
    try {
      if (!aiChargingEngine) {
        return res.status(500).json({ error: 'AI Charging Engine not available' });
      }
      
      const currentStatus = aiChargingEngine.getStatus();
      let result;
      
      if (currentStatus.enabled) {
        result = aiChargingEngine.stop();
      } else {
        result = await aiChargingEngine.start();
      }
      
      const newStatus = aiChargingEngine.getStatus();
      
      res.json({
        success: true,
        message: result?.message || `AI Charging Engine ${newStatus.enabled ? 'started' : 'stopped'} successfully`,
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
  
  // ================ AI CHARGING ENGINE ONLY ================
  
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
  
  // AI engine handles all automation
  
  // AI engine handles all automation
  
  // InfluxDB handles data retention automatically, no manual pruning needed
  


// Rules functionality removed - AI engine handles all automation

// Night charging rules removed - AI engine handles all automation

// Weekend rules removed - AI engine handles all automation

// Helper functions removed - AI engine handles all automation
  

  
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
      // AI engine can send commands directly
      
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
      // AI engine can send commands directly
      
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

  // ================ ENHANCED INVERTER SETTINGS PAGE ================

app.get('/inverter-settings', async (req, res) => {
    try {
      let settingsCount = 0;
      try {
        const result = await getSettingsChanges(USER_ID, { limit: 1 });
        settingsCount = result.changes.length > 0 ? 'Available' : 0;
      } catch (error) {
        console.error('Error getting settings count:', error);
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
        // Learner mode and system status
        active: learnerModeActive,
        influx_connected: !!influx,
        
        // Current system state (real-time data)
        currentSystemState: systemState,
        
        // Current inverter settings (enhanced with both types)
        currentSettings: settings,
        
        // Inverter type detection information
        inverterTypes: inverterTypes,
        
        // Configuration
        numInverters: config.inverterNumber,
        numBatteries: config.batteryNumber,
        mqtt_topic_prefix: config.mqttTopicPrefix,
        mqtt_host: config.mqttHost,
        mqtt_username: config.mqttUsername,
        
        // User identification
        user_id: USER_ID,
        
        // Settings statistics
        settings_count: settingsCount,
        
        // System warnings
        inverterWarning: inverterWarning,
        batteryWarning: batteryWarning,
        
        // Ingress path for Home Assistant add-on compatibility
        ingress_path: process.env.INGRESS_PATH || '',
        
        // Additional metadata
        timestamp: new Date(),
        serverPort: port,
        
        // Flags for frontend
        useInMemorySettings: true,
        realTimeUpdates: true,
        
        // MQTT connection status
        mqttConnected: mqttClient ? mqttClient.connected : false,
        
        // Recent messages sample for debugging (limited to last 10)
        recentMessages: incomingMessages.slice(-10),
        
        // Dynamic pricing status (if available)
        dynamicPricingEnabled: false,
        
        // Enhanced support flags
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
      
      const result = await getSettingsChanges(USER_ID, { 
        topic: setting, 
        changeType: setting,
        limit: 1000 
      });
      
      // Filter by days if needed
      const dateThreshold = new Date();
      dateThreshold.setDate(dateThreshold.getDate() - days);
      
      const filteredData = result.changes
        .filter(change => change.timestamp >= dateThreshold)
        .map(change => ({
          timestamp: change.timestamp,
          value: change.new_value,
          old_value: change.old_value,
          system_state: change.system_state
        }));
      
      res.json({
        success: true,
        setting,
        data: filteredData,
        count: filteredData.length
      });
    } catch (error) {
      console.error(`Error retrieving ${req.params.setting} history:`, error);
      res.status(500).json({ error: 'Failed to retrieve setting history' });
    }
  });
  
  // Dynamic pricing route removed
  
  
  // ================ RULES MANAGEMENT API ================
  
  // Wizard functionality removed - redirect to AI dashboard
  app.get('/wizard', (req, res) => {
    res.redirect(`${process.env.INGRESS_PATH || ''}/ai-dashboard`);
  });

  
  // Rule history removed - redirect to AI dashboard
  app.get('/rule-history', (req, res) => {
    res.redirect(`${process.env.INGRESS_PATH || ''}/ai-dashboard`);
  });

  
  // Rules functionality removed - redirect to AI dashboard
  app.get('/rules', (req, res) => {
    res.redirect(`${process.env.INGRESS_PATH || ''}/ai-dashboard`);
  });
  
  app.get('/api/system-state', (req, res) => {
    res.json({ 
      current_state: currentSystemState,
      timestamp: new Date()
    });
  });
  
  // New endpoint for historical system data from InfluxDB
  app.get('/api/system-state/history', async (req, res) => {
    try {
      const hours = parseInt(req.query.hours) || 2;
      const limit = parseInt(req.query.limit) || 50;
      
      const hoursAgo = new Date();
      hoursAgo.setHours(hoursAgo.getHours() - hours);
      
      try {
        // Query InfluxDB for settings changes with system state
        const query = `
          SELECT battery_soc, pv_power, grid_power, load, battery_power
          FROM settings_changes 
          WHERE "user_id" = '${USER_ID}'
          AND time >= '${hoursAgo.toISOString()}'
          ORDER BY time DESC 
          LIMIT ${limit}
        `;
        
        const result = await influx.query(query);
        
        const historyData = result.map(row => ({
          timestamp: new Date(row.time),
          battery_soc: row.battery_soc || 0,
          pv_power: row.pv_power || 0,
          grid_power: row.grid_power || 0,
          load: row.load || 0,
          battery_power: row.battery_power || 0
        })).reverse(); // Reverse to get chronological order
        
        res.json({
          success: true,
          data: historyData,
          count: historyData.length
        });
      } catch (influxError) {
        console.error('Error querying InfluxDB for system state history:', influxError);
        res.json({
          success: false,
          error: 'No historical data available',
          data: []
        });
      }
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
      
      const result = await getSettingsChanges(USER_ID, { changeType, limit });
      
      res.json({
        changes: result.changes,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error retrieving settings changes:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });
  
  // Learner mode status removed - AI engine is always active
  
  // Learner mode toggle removed - AI engine handles commands directly
  
  app.get('/api/learner/changes', apiRateLimiter, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      
      const result = await getSettingsChanges(USER_ID, { limit });
      
      res.json(result.changes);
    } catch (error) {
      console.error('Error retrieving learner changes:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });
  
  app.get('/api/database/status', (req, res) => {
    res.json({
      connected: !!influx,
      type: 'InfluxDB',
      status: influx ? 'connected' : 'disconnected'
    });
  });
  
  // Learner mode removed - redirect to AI dashboard
  app.get('/learner', (req, res) => {
    res.redirect(`${process.env.INGRESS_PATH || ''}/ai-dashboard`);
  });
  
  // Enhanced command injection route with inverter type auto-mapping
  app.post('/api/command', (req, res) => {
    try {
      // AI engine can send commands directly
      
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

// Rule templates removed - AI engine handles all automation

// Rule validation removed - AI engine handles all automation

// Rule preview removed - AI engine handles all automation

// Rule creation removed - AI engine handles all automation

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

// Rule templates removed - AI engine handles all automation

// Rule helper functions removed - AI engine handles all automation

// Rule validation functions removed - AI engine handles all automation

// Rule preview and summary functions removed - AI engine handles all automation

// Impact estimation functions removed - AI engine handles all automation


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
// Rule evaluation removed - AI engine handles all automation

  
  // Run database maintenance once per day
  // Database maintenance removed - using InfluxDB only
  
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

  if (global.influx) {
    console.log('🔄 Initializing Tibber cache from InfluxDB...');
    try {
      await tibberService.initializeInfluxCache();
    } catch (error) {
      console.error('⚠️  Could not initialize Tibber cache:', error.message);
    }
  } else {
    console.log('⚠️  InfluxDB not available - Tibber will use local cache only');
  }
  
  // Initialize data
  await initializeData();
  
  // Initialize data
  await initializeData();
  
  // Dynamic pricing integration removed
  try {
    // Removed dynamic pricing initialization
    
    global.mqttClient = mqttClient;
    global.currentSystemState = currentSystemState;
    global.inverterTypes = inverterTypes; // Make inverter types available globally
    
    console.log('✅ Dynamic pricing integration initialized with intelligent inverter type support and automatic command mapping');
  } catch (error) {
    console.error('❌ Error initializing:', error);
    
    // Dynamic pricing instance removed
  }
  
  try {
    // Database connection removed - using InfluxDB only
  } catch (err) {
    console.error('❌ Initial database connection failed:', err);
    // Database retry removed - using InfluxDB only
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
    // processRules removed - AI engine handles all automation
    
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

// Automation rules initialization removed - AI engine handles all automation
  
  
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
      influxdb: influx ? '✅' : '❌',
      mqtt: mqttClient && mqttClient.connected ? '✅' : '❌',
      learnerMode: learnerModeActive ? '✅' : '❌'
    };
    
    console.log(`💊 System Health: DB ${healthStatus.influxdb} | MQTT ${healthStatus.mqtt} | Learner ${healthStatus.learnerMode}`);
    
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
    console.log(`🗄️  InfluxDB Connection: ${influx ? '✅ Connected' : '❌ Disconnected'}`);
    
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
    // AI engine can send commands directly
    
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
          connected: !!influx,
          status: influx ? 'healthy' : 'disconnected'
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
  
  // Enhanced cleanup sequence - database removed
  
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
  
  // Dynamic pricing cleanup removed
  
  console.log('✅ Enhanced cleanup completed');
  clearTimeout(forceExitTimeout);
  console.log('🔋 Enhanced Energy Monitoring System shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', GracefulShutdown);
process.on('SIGINT', GracefulShutdown);


process.on('SIGTERM', GracefulShutdown);
process.on('SIGINT', GracefulShutdown);