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
const sqlite3 = require('sqlite3').verbose()
const { open } = require('sqlite')
const cron = require('node-cron')
const session = require('express-session');
const { startOfDay } = require('date-fns')
const { AuthenticateUser } = require('./utils/mongoService')

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



// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json')
const RULES_FILE = path.join(__dirname, 'data', 'rules.json')
const CACHE_DURATION = 24 * 3600000 // 24 hours in milliseconds
const DB_FILE = path.join(__dirname, 'data', 'energy_monitor.db')

// Create data directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'))
}

// SQLite database instance
let db;
let dbConnected = false;

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

// ================ DATABASE FUNCTIONS ================

// SQLite Database Schema Setup
async function initializeDatabase() {
  try {
    db = await open({
      filename: DB_FILE,
      driver: sqlite3.Database,
    });
    
    // Create settings_changes table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS settings_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        topic TEXT,
        old_value TEXT,
        new_value TEXT,
        system_state TEXT,
        change_type TEXT,
        user_id TEXT,
        mqtt_username TEXT
      )
    `);
    
    // Create rules table
    await db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        active INTEGER DEFAULT 1,
        conditions TEXT,
        time_restrictions TEXT,
        actions TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_triggered TEXT,
        trigger_count INTEGER DEFAULT 0,
        user_id TEXT,
        mqtt_username TEXT
      )
    `);
    
    // Create indexes for better performance
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_settings_changes_user_id ON settings_changes(user_id);
      CREATE INDEX IF NOT EXISTS idx_settings_changes_timestamp ON settings_changes(timestamp);
      CREATE INDEX IF NOT EXISTS idx_settings_changes_topic ON settings_changes(topic);
      CREATE INDEX IF NOT EXISTS idx_settings_changes_change_type ON settings_changes(change_type);
      
      CREATE INDEX IF NOT EXISTS idx_rules_user_id ON rules(user_id);
      CREATE INDEX IF NOT EXISTS idx_rules_active ON rules(active);
      CREATE INDEX IF NOT EXISTS idx_rules_last_triggered ON rules(last_triggered);
    `);
    
    console.log('SQLite database initialized');
    dbConnected = true;
    return true;
  } catch (error) {
    console.error('Error initializing SQLite database:', error.message);
    dbConnected = false;
    return false;
  }
}

// Connect to SQLite database
async function connectToDatabase() {
  try {
    if (!dbConnected) {
      await initializeDatabase();
    }
    return dbConnected;
  } catch (error) {
    console.error('SQLite connection error:', error.message);
    dbConnected = false;
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



// ================ SETTINGS CHANGE FUNCTIONS ================

// Function to save a settings change to SQLite
async function saveSettingsChange(changeData) {
  if (!dbConnected) return false;
  
  try {
    // Convert system_state object to JSON string
    const systemStateJson = JSON.stringify(changeData.system_state || {});
    
    // Convert values to strings for SQLite
    const oldValueStr = typeof changeData.old_value === 'object' ? 
      JSON.stringify(changeData.old_value) : 
      String(changeData.old_value || '');
    
    const newValueStr = typeof changeData.new_value === 'object' ? 
      JSON.stringify(changeData.new_value) : 
      String(changeData.new_value || '');
    
    // Insert into SQLite
    await db.run(`
      INSERT INTO settings_changes 
      (timestamp, topic, old_value, new_value, system_state, change_type, user_id, mqtt_username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      changeData.timestamp.toISOString(),
      changeData.topic,
      oldValueStr,
      newValueStr,
      systemStateJson,
      changeData.change_type,
      changeData.user_id,
      changeData.mqtt_username
    ]);
    
    return true;
  } catch (error) {
    console.error('Error saving settings change to SQLite:', error.message);
    return false;
  }
}

// Function to handle setting changes
async function handleSettingChange(specificTopic, messageContent, changeType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
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
    if (dbConnected) {
      try {
        await saveSettingsChange(changeData);
      } catch (error) {
        console.error('Error saving to database:', error.message);
        // Try to connect to database in background
        retryDatabaseConnection();
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
    if (dbConnected) {
      try {
        await saveSettingsChange(changeData);
      } catch (error) {
        console.error('Error saving to database:', error.message);
        // Try to connect to database in background
        retryDatabaseConnection();
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
    if (dbConnected) {
      try {
        await saveSettingsChange(changeData);
      } catch (error) {
        console.error('Error saving to database:', error.message);
        // Try to connect to database in background
        retryDatabaseConnection();
      }
    } else {
      // Try to connect to database in background
      retryDatabaseConnection();
    }
    
    // Send notification without logging
    sendWorkModeNotification(changeData);
  }
}



// ================ RULES FUNCTIONS ================


async function countRules(userId) {
  if (!dbConnected) return 0;
  
  try {
    const result = await db.get(`
      SELECT COUNT(*) as count FROM rules WHERE user_id = ?
    `, [userId]);
    
    return result.count;
  } catch (error) {
    console.error('Error counting rules:', error.message);
    return 0;
  }
}

async function batchUpdateRules(rules) {
  if (!dbConnected || rules.length === 0) return;
  
  // Use the mutex pattern for transaction control
  return executeWithDbMutex(async () => {
    let transactionStarted = false;
    
    try {
      // Begin a transaction
      await db.run('BEGIN TRANSACTION');
      transactionStarted = true;
      
      for (const rule of rules) {
        // Update in SQLite
        await db.run(`
          UPDATE rules 
          SET last_triggered = ?,
              trigger_count = ?
          WHERE id = ? AND user_id = ?
        `, [
          rule.lastTriggered.toISOString(),
          rule.triggerCount,
          rule.id,
          rule.user_id
        ]);
      }
      
      // Commit the transaction
      await db.run('COMMIT');
      transactionStarted = false;
      return true;
    } catch (error) {
      // Rollback on error, but only if we started a transaction
      if (transactionStarted) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackError) {
          // Only log the error if it's not "no transaction is active"
          if (!rollbackError.message.includes('no transaction is active')) {
            console.error('Error rolling back transaction:', rollbackError.message);
          }
        }
      }
      
      console.error('Error batch updating rules in SQLite:', error.message);
      return false;
    }
  });
}

// Function to save a rule to SQLite
async function saveRule(ruleData) {
  if (!dbConnected) return null;
  
  // Use the mutex pattern for transaction control
  return executeWithDbMutex(async () => {
    let transactionStarted = false;
    
    try {
      // Begin transaction
      await db.run('BEGIN TRANSACTION');
      transactionStarted = true;
      
      // Convert conditions, time restrictions, and actions to JSON strings
      const conditionsJson = JSON.stringify(ruleData.conditions || []);
      const timeRestrictionsJson = JSON.stringify(ruleData.timeRestrictions || {});
      const actionsJson = JSON.stringify(ruleData.actions || []);
      
      // Insert into SQLite
      const result = await db.run(`
        INSERT INTO rules 
        (name, description, active, conditions, time_restrictions, actions, 
         created_at, last_triggered, trigger_count, user_id, mqtt_username)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        ruleData.name,
        ruleData.description || '',
        ruleData.active ? 1 : 0,
        conditionsJson,
        timeRestrictionsJson,
        actionsJson,
        new Date().toISOString(),
        ruleData.lastTriggered ? ruleData.lastTriggered.toISOString() : null,
        ruleData.triggerCount || 0,
        ruleData.user_id,
        ruleData.mqtt_username
      ]);
      
      // Get the ID of the inserted rule
      const rule = await db.get('SELECT last_insert_rowid() as id');
      
      // Commit transaction
      await db.run('COMMIT');
      transactionStarted = false;
      
      // Return the rule data with the new ID
      return {
        id: rule.id,
        ...ruleData
      };
    } catch (error) {
      // Rollback on error, but only if we started a transaction
      if (transactionStarted) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackError) {
          console.error('Error rolling back transaction:', rollbackError.message);
        }
      }
      
      console.error('Error saving rule to SQLite:', error.message);
      return null;
    }
  });
}

// Function to get a rule by ID
async function updateRule(id, ruleData) {
  if (!dbConnected) return false;
  
  // Use the mutex pattern for transaction control
  return executeWithDbMutex(async () => {
    let transactionStarted = false;
    
    try {
      // Begin transaction
      await db.run('BEGIN TRANSACTION');
      transactionStarted = true;
      
      // Convert complex objects to JSON strings
      const conditionsJson = JSON.stringify(ruleData.conditions || []);
      const timeRestrictionsJson = JSON.stringify(ruleData.timeRestrictions || {});
      const actionsJson = JSON.stringify(ruleData.actions || []);
      
      // Update in SQLite
      const result = await db.run(`
        UPDATE rules 
        SET name = ?, description = ?, active = ?, conditions = ?, 
            time_restrictions = ?, actions = ?, last_triggered = ?, trigger_count = ?
        WHERE id = ? AND user_id = ?
      `, [
        ruleData.name,
        ruleData.description || '',
        ruleData.active ? 1 : 0,
        conditionsJson,
        timeRestrictionsJson,
        actionsJson,
        ruleData.lastTriggered ? ruleData.lastTriggered.toISOString() : null,
        ruleData.triggerCount || 0,
        id,
        ruleData.user_id
      ]);
      
      // Commit transaction
      await db.run('COMMIT');
      transactionStarted = false;
      
      return result.changes > 0;
    } catch (error) {
      // Rollback on error, but only if we started a transaction
      if (transactionStarted) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackError) {
          console.error('Error rolling back transaction:', rollbackError.message);
        }
      }
      
      console.error('Error updating rule in SQLite:', error.message);
      return false;
    }
  });
}

// Function to get all rules
async function getAllRules(userId, options = {}) {
  if (!dbConnected) return [];
  
  try {
    const { active, sort, limit, offset } = options;
    
    // Build query based on options
    let query = 'SELECT * FROM rules WHERE user_id = ?';
    const params = [userId];
    
    if (active !== undefined) {
      query += ' AND active = ?';
      params.push(active ? 1 : 0);
    }
    
    if (sort) {
      query += ` ORDER BY ${sort.field} ${sort.order || 'ASC'}`;
    } else {
      query += ' ORDER BY name ASC';
    }
    
    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
      
      if (offset) {
        query += ' OFFSET ?';
        params.push(offset);
      }
    }
    
    const rules = await db.all(query, params);
    
    // Parse JSON fields for each rule
    return rules.map(rule => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      active: rule.active === 1,
      conditions: JSON.parse(rule.conditions || '[]'),
      timeRestrictions: JSON.parse(rule.time_restrictions || '{}'),
      actions: JSON.parse(rule.actions || '[]'),
      createdAt: new Date(rule.created_at),
      lastTriggered: rule.last_triggered ? new Date(rule.last_triggered) : null,
      triggerCount: rule.trigger_count,
      user_id: rule.user_id,
      mqtt_username: rule.mqtt_username
    }));
  } catch (error) {
    console.error('Error getting rules from SQLite:', error.message);
    return [];
  }
}

// Function to delete a rule
async function deleteRule(id, userId) {
  if (!dbConnected) return false;
  
  // Check if a transaction is already in progress
  if (transactionInProgress) {
    console.warn('Transaction already in progress, queueing rule deletion');
    // Wait and retry
    return new Promise(resolve => {
      setTimeout(async () => {
        resolve(await deleteRule(id, userId));
      }, 100);
    });
  }
  
  try {
    // Set transaction flag
    transactionInProgress = true;
    
    // Begin transaction
    await db.run('BEGIN TRANSACTION');
    
    const result = await db.run(`
      DELETE FROM rules WHERE id = ? AND user_id = ?
    `, [id, userId]);
    
    // Commit transaction
    await db.run('COMMIT');
    
    return result.changes > 0;
  } catch (error) {
    // Rollback on error
    try {
      await db.run('ROLLBACK');
    } catch (rollbackError) {
      console.error('Error rolling back transaction:', rollbackError.message);
    }
    
    console.error('Error deleting rule from SQLite:', error.message);
    return false;
  } finally {
    // Always reset the transaction flag when done
    transactionInProgress = false;
  }
}

// Function to get a rule by ID
async function getRuleById(id, userId) {
  if (!dbConnected) return null;
  
  try {
    const rule = await db.get(`
      SELECT * FROM rules WHERE id = ? AND user_id = ?
    `, [id, userId]);
    
    if (!rule) return null;
    
    // Parse JSON fields
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      active: rule.active === 1,
      conditions: JSON.parse(rule.conditions || '[]'),
      timeRestrictions: JSON.parse(rule.time_restrictions || '{}'),
      actions: JSON.parse(rule.actions || '[]'),
      createdAt: new Date(rule.created_at),
      lastTriggered: rule.last_triggered ? new Date(rule.last_triggered) : null,
      triggerCount: rule.trigger_count,
      user_id: rule.user_id,
      mqtt_username: rule.mqtt_username
    };
  } catch (error) {
    console.error('Error getting rule by ID:', error.message);
    return null;
  }
}

// Function to get settings changes
async function getSettingsChanges(userId, options = {}) {
  if (!dbConnected) return { changes: [], pagination: { total: 0 } };
  
  try {
    const { changeType, topic, limit = 100, skip = 0 } = options;
    
    // Build query based on options
    let query = 'SELECT * FROM settings_changes WHERE user_id = ?';
    const countQuery = 'SELECT COUNT(*) as total FROM settings_changes WHERE user_id = ?';
    const params = [userId];
    const countParams = [userId];
    
    if (changeType) {
      query += ' AND change_type = ?';
      countQuery += ' AND change_type = ?';
      params.push(changeType);
      countParams.push(changeType);
    }
    
    if (topic) {
      query += ' AND topic LIKE ?';
      countQuery += ' AND topic LIKE ?';
      params.push(`%${topic}%`);
      countParams.push(`%${topic}%`);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, skip);
    
    // Get total count for pagination
    const countResult = await db.get(countQuery, countParams);
    const total = countResult.total;
    
    // Get the actual changes
    const changes = await db.all(query, params);
    
    // Parse JSON fields and format dates
    const formattedChanges = changes.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    return {
      changes: formattedChanges,
      pagination: {
        total,
        limit,
        skip,
        hasMore: skip + limit < total
      }
    };
  } catch (error) {
    console.error('Error getting settings changes from SQLite:', error.message);
    return { changes: [], pagination: { total: 0 } };
  }
}

// Helper function to parse JSON strings or return original value
function parseJsonOrValue(value) {
  if (!value) return value;
  
  try {
    // If it looks like JSON, parse it
    if (value.startsWith('{') || value.startsWith('[')) {
      return JSON.parse(value);
    }
  } catch (e) {
    // Not JSON, just return the value
  }
  
  return value;
}

// Handle incoming MQTT messages
async function handleMqttMessage(topic, message) {
  // Keep circular buffer of messages but with reduced size in learner mode
  const formattedMessage = `${topic}: ${message.toString()}`
  
  // Add to the circular buffer of messages - use a smaller buffer size when in learner mode
  const bufferSize = learnerModeActive ? Math.min(100, MAX_MESSAGES) : MAX_MESSAGES;
  incomingMessages.push(formattedMessage)
  if (incomingMessages.length > bufferSize) {
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

  // Track if this message should trigger rule processing
  let shouldProcessRules = false;

  // Update system state for key metrics - always do this regardless of learner mode
  if (specificTopic.includes('total/battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent)
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss')
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent)
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/load_power')) {
    currentSystemState.load = parseFloat(messageContent)
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent)
    shouldProcessRules = true;
  } else if (specificTopic.includes('total/grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent)
    shouldProcessRules = true;
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent
    shouldProcessRules = true;
  }

  // Batch changes to be processed together for better performance
  const settingsChanges = [];

  // Handle existing settings changes
  try {
    // Check if this topic is in our monitored settings
    let matchedSetting = null;
    
    // First check specific patterns that have dedicated handlers
    if (specificTopic.includes('grid_charge')) {
      matchedSetting = 'grid_charge';
    } else if (specificTopic.includes('energy_pattern')) {
      matchedSetting = 'energy_pattern';
    } else if (specificTopic.includes('voltage_point')) {
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
      // If not matched yet, check against the full list of monitored settings
      for (const setting of settingsToMonitor) {
        if (specificTopic.includes(setting)) {
          matchedSetting = setting;
          break;
        }
      }
    }
    
    // If we found a match, check if the value changed
    if (matchedSetting && previousSettings[specificTopic] !== messageContent) {
      // Only process if the value actually changed
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
      
      // Add to batch of changes
      settingsChanges.push(changeData);
      
      // Update previous settings
      previousSettings[specificTopic] = messageContent;
      
      // This should trigger rule processing
      shouldProcessRules = true;
    }
  } catch (error) {
    console.error('Error handling MQTT message:', error.message);
  }

  // Batch save all changes to database - use a limit to prevent overloading
  if (settingsChanges.length > 0 && dbConnected) {
    try {
      // Process in smaller batches if there are many changes
      const BATCH_SIZE = 20;
      
      if (settingsChanges.length <= BATCH_SIZE) {
        await batchSaveSettingsChanges(settingsChanges);
      } else {
        // Process in smaller batches
        for (let i = 0; i < settingsChanges.length; i += BATCH_SIZE) {
          const batch = settingsChanges.slice(i, i + BATCH_SIZE);
          await batchSaveSettingsChanges(batch);
        }
      }
    } catch (error) {
      console.error('Error saving settings changes to database:', error.message);
      // Try to connect to database in background
      retryDatabaseConnection();
    }
  }

  // Only process rules if something changed that could trigger a rule
  if (shouldProcessRules) {
    try {
      // Use our debounced version to avoid excessive rule processing
      debouncedProcessRules();
    } catch (error) {
      console.error('Error processing rules:', error.message);
    }
  }
}


// 8. Add a mutex pattern for better database operation coordination
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

// Create a database mutex
const dbMutex = new Mutex();

// Helper function to execute with mutex
async function executeWithDbMutex(operation) {
  await dbMutex.acquire();
  try {
    return await operation();
  } finally {
    dbMutex.release();
  }
}

// Function to batch save settings changes
async function batchSaveSettingsChanges(changes) {
  if (!dbConnected || changes.length === 0) return;
  
  // Use the mutex pattern for transaction control
  return executeWithDbMutex(async () => {
    let transactionStarted = false;
    
    try {
      // Begin a transaction
      await db.run('BEGIN TRANSACTION');
      transactionStarted = true;
      
      for (const change of changes) {
        // Convert system_state object to JSON string
        const systemStateJson = JSON.stringify(change.system_state || {});
        
        // Convert values to strings for SQLite
        const oldValueStr = typeof change.old_value === 'object' ? 
          JSON.stringify(change.old_value) : 
          String(change.old_value || '');
        
        const newValueStr = typeof change.new_value === 'object' ? 
          JSON.stringify(change.new_value) : 
          String(change.new_value || '');
        
        // Insert into SQLite
        await db.run(`
          INSERT INTO settings_changes 
          (timestamp, topic, old_value, new_value, system_state, change_type, user_id, mqtt_username)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          change.timestamp.toISOString(),
          change.topic,
          oldValueStr,
          newValueStr,
          systemStateJson,
          change.change_type,
          change.user_id,
          change.mqtt_username
        ]);
      }
      
      // Commit the transaction
      await db.run('COMMIT');
      transactionStarted = false;
      return true;
    } catch (error) {
      // Rollback on error, but only if we started a transaction
      if (transactionStarted) {
        try {
          await db.run('ROLLBACK');
        } catch (rollbackError) {
          // Only log the error if it's not "no transaction is active"
          if (!rollbackError.message.includes('no transaction is active')) {
            console.error('Error rolling back transaction:', rollbackError.message);
          }
        }
      }
      
      console.error('Error batch saving settings changes to SQLite:', error.message);
      return false;
    }
  });
}

// 3. Create a debounced version of processRules to avoid excessive processing
// This function should be defined near the top of your file, after your imports
const debouncedProcessRules = (() => {
  let timeout = null;
  let pendingRuleProcess = false;
  
  return function() {
    if (timeout) {
      clearTimeout(timeout);
    }
    
    // If we already have a pending rule process, just mark that we need another one
    if (pendingRuleProcess) {
      return;
    }
    
    pendingRuleProcess = true;
    
    // Process immediately but wait before allowing another process
    processRules().finally(() => {
      timeout = setTimeout(() => {
        pendingRuleProcess = false;
      }, 1000); // 1 second cooldown
    });
  };
})();



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
let _cachedTimeCheck = null;

// Replace the isWithinTimeRange function around line 1375
function isWithinTimeRange(startTime, endTime) {
  if (!startTime || !endTime) return true;
  
  // Cache the current time - computed once per rule evaluation cycle
  if (!_cachedTimeCheck) {
    _cachedTimeCheck = {
      time: moment().tz(currentTimezone),
      lastUpdated: Date.now()
    };
  } else if (Date.now() - _cachedTimeCheck.lastUpdated > 1000) {
    // Update cache if it's older than 1 second
    _cachedTimeCheck = {
      time: moment().tz(currentTimezone),
      lastUpdated: Date.now()
    };
  }
  
  const currentTime = _cachedTimeCheck.time;
  const start = moment.tz(startTime, 'HH:mm', currentTimezone);
  const end = moment.tz(endTime, 'HH:mm', currentTimezone);
  
  // Handle cases where the time range spans midnight
  if (end.isBefore(start)) {
    // Return true if current time is after start OR before end
    return currentTime.isAfter(start) || currentTime.isBefore(end);
  }
  
  // Normal case: check if current time is between start and end
  return currentTime.isBetween(start, end, null, '[]');
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
  const { parameter, operator, value } = condition;
  let currentValue;
  
  // Get the current value based on parameter - use in-memory state for speed
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
    default:
      // If we don't track this parameter, condition can't be evaluated
      return false;
  }
  
  // If we don't have the value yet, return false
  if (currentValue === null || currentValue === undefined) {
    return false;
  }
  
  // Evaluate the condition
  switch (operator) {
    case 'gt': // greater than
      return currentValue > value;
    case 'lt': // less than
      return currentValue < value;
    case 'eq': // equal to
      return currentValue === value;
    case 'gte': // greater than or equal to
      return currentValue >= value;
    case 'lte': // less than or equal to
      return currentValue <= value;
    default:
      return false;
  }
}


// Function to apply an action
function applyAction(action) {
  // Only allow sending commands when learner mode is active
  if (!learnerModeActive) {
    return false;
  }

  const { setting, value, inverter } = action;
  const inverters = [];
  
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
  for (const inv of inverters) {
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
        return false;
    }
    
    // Send the command via MQTT - with reduced logging
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false });
    }
  }
  
  return true;
}

// Function to process all rules
async function processRules() {
  if (!dbConnected) return;
  
  try {
    // Reset time cache for this evaluation cycle
    _cachedTimeCheck = null;
    
    // Skip processing if no system state is available
    if (Object.keys(currentSystemState).every(key => 
      currentSystemState[key] === null || currentSystemState[key] === undefined)) {
      return;
    }
    
    // Get all active rules for the current user
    const rules = await getAllRules(USER_ID, { active: true });
    
    // Batch update for triggered rules
    const rulesToUpdate = [];
    
    // Current time in the user's timezone for time-based rules
    const now = moment().tz(currentTimezone);
    const currentDay = now.format('dddd').toLowerCase();
    const currentTime = now.format('HH:mm');
    
    for (const rule of rules) {
      // Skip processing if rule has time restrictions that don't match current time
      if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
        const { days, startTime, endTime } = rule.timeRestrictions;
        
        // Check day of week restrictions
        if (days && days.length > 0 && !days.includes(currentDay)) {
          continue; // Skip this rule if not an allowed day
        }
        
        // Check time range restrictions
        if (startTime && endTime && !isWithinTimeRange(startTime, endTime)) {
          continue; // Skip this rule if outside time range
        }
        
        // Check specific dates (if configured)
        if (rule.timeRestrictions.specificDates && 
            rule.timeRestrictions.specificDates.length > 0) {
          const today = now.format('YYYY-MM-DD');
          if (!rule.timeRestrictions.specificDates.includes(today)) {
            continue; // Skip if today is not in the specific dates list
          }
        }
      }
      
      // Check if all conditions are met
      let allConditionsMet = true;
      
      if (rule.conditions && rule.conditions.length > 0) {
        for (const condition of rule.conditions) {
          if (!evaluateCondition(condition)) {
            allConditionsMet = false;
            break; // No need to check further conditions
          }
        }
      }
      
      if (allConditionsMet) {
        // Only apply actions if learner mode is active
        if (learnerModeActive && rule.actions && rule.actions.length > 0) {
          for (const action of rule.actions) {
            applyAction(action);
          }
        }
        
        // Always update rule statistics
        rule.lastTriggered = new Date();
        rule.triggerCount = (rule.triggerCount || 0) + 1;
        rulesToUpdate.push(rule);
      }
    }
    
    // Batch update all triggered rules
    if (rulesToUpdate.length > 0) {
      await batchUpdateRules(rulesToUpdate);
    }
  } catch (error) {
    console.error('Error processing rules:', error);
  }
}

// Function to create a default set of rules if none exist
async function createDefaultRules() {
  if (!dbConnected) return;
  
  try {
    // Check if this user already has rules
    const count = await countRules(USER_ID);
    
    if (count === 0) {
      console.log('Creating default rules for user:', USER_ID);
      
      // Rule 1: If load is lower than 5000W, change energy pattern to battery first
      const rule1 = {
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
      };
      await saveRule(rule1);
      
      // Rule 2: If SOC is lower than 20%, turn Grid charge on
      const rule2 = {
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
      };
      await saveRule(rule2);
      
      // Rule 3: Turn Grid charge off on weekends
      const rule3 = {
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
      };
      await saveRule(rule3);
      
      // Rule 4: Complex condition for grid charge
      const rule4 = {
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
      };
      await saveRule(rule4);
      
      // Rule 5: Emergency grid charge off
      const rule5 = {
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
      };
      await saveRule(rule5);
      
      console.log('Default rules created for user:', USER_ID);
    }
  } catch (error) {
    console.error('Error creating default rules:', error.message);
  }
}

  // Function to create extended set of automation rules
  async function createExtendedAutomationRules() {
    if (!dbConnected) return;
    
    try {
      // Check if this user already has extended rules
      const count = await db.get(`
        SELECT COUNT(*) as count FROM rules 
        WHERE user_id = ? AND name LIKE '%Extended%'
      `, [USER_ID]);
      
      if (count.count === 0) {
        console.log('Creating extended automation rules for user:', USER_ID);
        
        // ===== Power Point Rules Based on Battery SOC =====
        const powerPoint2Rule1 = {
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
        };
        await saveRule(powerPoint2Rule1);
        
        const powerPoint2Rule2 = {
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
        };
        await saveRule(powerPoint2Rule2);
        
        const powerPoint2Rule3 = {
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
        };
        await saveRule(powerPoint2Rule3);
        
        const powerPoint2Rule4 = {
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
        };
        await saveRule(powerPoint2Rule4);
        
        // ===== Morning Energy Pattern Rules (00:05 to 12:00) =====
        const morningEnergyPatternLowSoc = {
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
        };
        await saveRule(morningEnergyPatternLowSoc);
        
        const morningEnergyPatternHighSoc = {
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
        };
        await saveRule(morningEnergyPatternHighSoc);
        
        // ===== Afternoon Energy Pattern Rules (12:00 to 17:00) =====
        const afternoonEnergyPatternLowSoc = {
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
        };
        await saveRule(afternoonEnergyPatternLowSoc);
        
        const afternoonEnergyPatternHighSoc = {
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
        };
        await saveRule(afternoonEnergyPatternHighSoc);
        
        // ===== Evening Energy Pattern Rules (17:01 to 23:55) =====
        const eveningEnergyPatternLowSoc = {
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
        };
        await saveRule(eveningEnergyPatternLowSoc);
        
        const eveningEnergyPatternHighSoc = {
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
        };
        await saveRule(eveningEnergyPatternHighSoc);
        
        // ===== Afternoon Grid Charge Point 1 Rules (13:00 to 17:00) =====
        const afternoonGridChargePoint1LowSoc = {
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
        };
        await saveRule(afternoonGridChargePoint1LowSoc);
        
        const afternoonGridChargePoint1HighSoc = {
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
        };
        await saveRule(afternoonGridChargePoint1HighSoc);
        
        // ===== Evening Grid Charge Point 1 Rules (17:01 to 23:55) =====
        const eveningGridChargePoint1LowSoc = {
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
        };
        await saveRule(eveningGridChargePoint1LowSoc);
        
        const eveningGridChargePoint1HighSoc = {
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
        };
        await saveRule(eveningGridChargePoint1HighSoc);
        
        // ===== Early Morning Grid Charge Point 2 Rules (00:05 to 08:55) =====
        const earlyMorningGridChargePoint2LowSoc = {
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
        };
        await saveRule(earlyMorningGridChargePoint2LowSoc);
        
        const earlyMorningGridChargePoint2HighSoc = {
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
        };
        await saveRule(earlyMorningGridChargePoint2HighSoc);
        
        // ===== Morning Grid Charge Point 2 Rules (09:00 to 12:59) =====
        const morningGridChargePoint2LowSoc = {
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
        };
        await saveRule(morningGridChargePoint2LowSoc);
        
        const morningGridChargePoint2HighSoc = {
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
        };
        await saveRule(morningGridChargePoint2HighSoc);
        
        // ===== Timer Disabling Rule =====
        const disableTimerEarlyMorning = {
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
        };
        await saveRule(disableTimerEarlyMorning);
        
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
    const existingRule = await db.get(`
      SELECT * FROM rules 
      WHERE name = 'Night Battery Charging to 95%' AND user_id = ?
    `, [USER_ID]);
    
    if (existingRule) {
      console.log('Night charging rule already exists, updating it...');
      
      // Update the existing rule to exclude weekends
      const updatedRule = {
        name: 'Night Battery Charging to 95%',
        description: 'Charges the battery at night (11PM to 6AM) to 95% SOC on weekdays only',
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
          // Only apply on weekdays, not weekends
          days: ['monday', 'tuesday', 'wednesday', 'thursday']
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
      };
      
      await updateRule(existingRule.id, updatedRule);
      console.log('Night charging rule updated successfully');
    } else {
      // Create a new rule that excludes weekends
      const nightChargingRule = {
        name: 'Night Battery Charging to 95%',
        description: 'Charges the battery at night (11PM to 6AM) to 95% SOC on weekdays only',
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
          // Only apply on weekdays, not weekends
          days: ['monday', 'tuesday', 'wednesday', 'thursday']
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
      };
      
      await saveRule(nightChargingRule);
      console.log('Night charging rule created successfully');
    }
    
    // Create a complementary rule to turn OFF grid charging after 6AM on weekdays
    const existingComplementaryRule = await db.get(`
      SELECT * FROM rules 
      WHERE name = 'Disable Grid Charging After 6AM' AND user_id = ?
    `, [USER_ID]);
    
    if (existingComplementaryRule) {
      console.log('Complementary rule already exists, updating it...');
      
      // Update the existing rule to exclude weekends
      const updatedComplementaryRule = {
        name: 'Disable Grid Charging After 6AM',
        description: 'Disables grid charging after 6AM until 11PM (daytime) on weekdays',
        active: true,
        conditions: [], // No condition on battery SOC for this rule
        timeRestrictions: {
          startTime: '06:01',
          endTime: '22:59',
          enabled: true,
          // Only apply on weekdays, not weekends
          days: ['monday', 'tuesday', 'wednesday', 'thursday']
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
      };
      
      await updateRule(existingComplementaryRule.id, updatedComplementaryRule);
      console.log('Complementary rule updated successfully');
    } else {
      // Create the complementary rule excluding weekends
      const complementaryRule = {
        name: 'Disable Grid Charging After 6AM',
        description: 'Disables grid charging after 6AM until 11PM (daytime) on weekdays',
        active: true,
        conditions: [], // No condition on battery SOC for this rule
        timeRestrictions: {
          startTime: '06:01',
          endTime: '22:59',
          enabled: true,
          // Only apply on weekdays, not weekends
          days: ['monday', 'tuesday', 'wednesday', 'thursday']
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
      };
      
      await saveRule(complementaryRule);
      console.log('Complementary rule created successfully');
    }
    
    // Create a battery full rule (applies all days)
    const existingEmergencyRule = await db.get(`
      SELECT * FROM rules 
      WHERE name = 'Disable Grid Charging When Battery Full' AND user_id = ?
    `, [USER_ID]);
    
    if (existingEmergencyRule) {
      console.log('Battery full rule already exists, updating it...');
      
      // Update the existing rule - this applies all days including weekends
      const updatedEmergencyRule = {
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
      };
      
      await updateRule(existingEmergencyRule.id, updatedEmergencyRule);
      console.log('Battery full rule updated successfully');
    } else {
      // Create the battery full rule
      const emergencyRule = {
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
      };
      
      await saveRule(emergencyRule);
      console.log('Battery full rule created successfully');
    }
    
    return true;
  } catch (error) {
    console.error('Error creating night charging rules:', error.message);
    return false;
  }
}



// Function to create weekend grid charge rules
async function createWeekendGridChargeRules() {
  if (!dbConnected) return;
  
  try {
    // Create Friday evening rule
    const fridayRule = await db.get(`
      SELECT * FROM rules 
      WHERE name = 'Weekend Grid Charge Off - Friday Evening' AND user_id = ?
    `, [USER_ID]);
    
    if (fridayRule) {
      // Update existing rule
      const updatedFridayRule = {
        name: 'Weekend Grid Charge Off - Friday Evening',
        description: 'Turns Grid charge off every Friday from 6PM until midnight',
        active: true,
        conditions: [],
        timeRestrictions: {
          days: ['friday'],
          startTime: '18:00', // 6PM
          endTime: '23:59',
          enabled: true
        },
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      await updateRule(fridayRule.id, updatedFridayRule);
      console.log('Friday evening grid charge rule updated successfully');
    } else {
      // Create new Friday rule
      const newFridayRule = {
        name: 'Weekend Grid Charge Off - Friday Evening',
        description: 'Turns Grid charge off every Friday from 6PM until midnight',
        active: true,
        conditions: [],
        timeRestrictions: {
          days: ['friday'],
          startTime: '18:00', // 6PM
          endTime: '23:59',
          enabled: true
        },
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      await saveRule(newFridayRule);
      console.log('Friday evening grid charge rule created successfully');
    }
    
    // Create Saturday rule
    const saturdayRule = await db.get(`
      SELECT * FROM rules 
      WHERE name = 'Weekend Grid Charge Off - Saturday' AND user_id = ?
    `, [USER_ID]);
    
    if (saturdayRule) {
      // Update existing rule
      const updatedSaturdayRule = {
        name: 'Weekend Grid Charge Off - Saturday',
        description: 'Turns Grid charge off for all of Saturday',
        active: true,
        conditions: [],
        timeRestrictions: {
          days: ['saturday'],
          startTime: '00:00',
          endTime: '23:59',
          enabled: true
        },
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      await updateRule(saturdayRule.id, updatedSaturdayRule);
      console.log('Saturday grid charge rule updated successfully');
    } else {
      // Create new Saturday rule
      const newSaturdayRule = {
        name: 'Weekend Grid Charge Off - Saturday',
        description: 'Turns Grid charge off for all of Saturday',
        active: true,
        conditions: [],
        timeRestrictions: {
          days: ['saturday'],
          startTime: '00:00',
          endTime: '23:59',
          enabled: true
        },
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      await saveRule(newSaturdayRule);
      console.log('Saturday grid charge rule created successfully');
    }
    
    // Create Sunday rule
    const sundayRule = await db.get(`
      SELECT * FROM rules 
      WHERE name = 'Weekend Grid Charge Off - Sunday' AND user_id = ?
    `, [USER_ID]);
    
    if (sundayRule) {
      // Update existing rule
      const updatedSundayRule = {
        name: 'Weekend Grid Charge Off - Sunday',
        description: 'Turns Grid charge off on Sunday until 6PM',
        active: true,
        conditions: [],
        timeRestrictions: {
          days: ['sunday'],
          startTime: '00:00',
          endTime: '18:00', // 6PM
          enabled: true
        },
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      await updateRule(sundayRule.id, updatedSundayRule);
      console.log('Sunday grid charge rule updated successfully');
    } else {
      // Create new Sunday rule
      const newSundayRule = {
        name: 'Weekend Grid Charge Off - Sunday',
        description: 'Turns Grid charge off on Sunday until 6PM',
        active: true,
        conditions: [],
        timeRestrictions: {
          days: ['sunday'],
          startTime: '00:00',
          endTime: '18:00', // 6PM
          enabled: true
        },
        actions: [{
          setting: 'grid_charge',
          value: 'Disabled',
          inverter: 'all'
        }],
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      await saveRule(newSundayRule);
      console.log('Sunday grid charge rule created successfully');
    }
    
    return true;
  } catch (error) {
    console.error('Error creating weekend grid charge rules:', error.message);
    return false;
  }
}

// ================ API ROUTES ================

// API Routes with database integration
  app.get('/api/energy-pattern-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const results = await db.all(`
        SELECT * FROM settings_changes 
        WHERE (topic LIKE '%energy_pattern%' OR change_type = 'energy_pattern')
        AND user_id = ?
        ORDER BY timestamp DESC
      `, [USER_ID]);
      
      // Parse JSON fields and format dates
      const energyPatternChanges = results.map(change => ({
        id: change.id,
        timestamp: new Date(change.timestamp),
        topic: change.topic,
        old_value: parseJsonOrValue(change.old_value),
        new_value: parseJsonOrValue(change.new_value),
        system_state: JSON.parse(change.system_state || '{}'),
        change_type: change.change_type,
        user_id: change.user_id,
        mqtt_username: change.mqtt_username
      }));
      
      res.json(energyPatternChanges);
    } catch (error) {
      console.error('Error retrieving energy pattern changes:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });

// === Add API endpoints for retrieving battery charging settings changes ===
app.get('/api/battery-charging-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const results = await db.all(`
      SELECT * FROM settings_changes 
      WHERE (
        topic LIKE '%max_discharge_current%' OR
        topic LIKE '%max_charge_current%' OR
        topic LIKE '%max_grid_charge_current%' OR
        topic LIKE '%max_generator_charge_current%' OR
        topic LIKE '%battery_float_charge_voltage%' OR
        topic LIKE '%battery_absorption_charge_voltage%' OR
        topic LIKE '%battery_equalization_charge_voltage%' OR
        change_type IN (
          'max_discharge_current', 
          'max_charge_current', 
          'max_grid_charge_current', 
          'max_generator_charge_current', 
          'battery_float_charge_voltage', 
          'battery_absorption_charge_voltage', 
          'battery_equalization_charge_voltage'
        )
      )
      AND user_id = ?
      ORDER BY timestamp DESC
    `, [USER_ID]);
    
    // Parse JSON fields and format dates
    const batteryChargingChanges = results.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    res.json(batteryChargingChanges);
  } catch (error) {
    console.error('Error retrieving battery charging changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

// === Add API endpoints for retrieving work mode settings changes ===
app.get('/api/work-mode-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const results = await db.all(`
      SELECT * FROM settings_changes 
      WHERE (
        topic LIKE '%remote_switch%' OR
        topic LIKE '%generator_charge%' OR
        topic LIKE '%force_generator_on%' OR
        topic LIKE '%output_shutdown_voltage%' OR
        topic LIKE '%stop_battery_discharge_voltage%' OR
        topic LIKE '%start_battery_discharge_voltage%' OR
        topic LIKE '%start_grid_charge_voltage%' OR
        topic LIKE '%work_mode%' OR
        topic LIKE '%solar_export_when_battery_full%' OR
        topic LIKE '%max_sell_power%' OR
        topic LIKE '%max_solar_power%' OR
        topic LIKE '%grid_trickle_feed%' OR
        change_type IN (
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
        )
      )
      AND user_id = ?
      ORDER BY timestamp DESC
    `, [USER_ID]);
    
    // Parse JSON fields and format dates
    const workModeChanges = results.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    res.json(workModeChanges);
  } catch (error) {
    console.error('Error retrieving work mode changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

// === Add routes for viewing battery charging and work mode settings ===
app.get('/battery-charging', async (req, res) => {
  try {
    let changesCount = 0;
    if (dbConnected) {
      const result = await db.get(`
        SELECT COUNT(*) as count FROM settings_changes 
        WHERE (
          topic LIKE '%max_discharge_current%' OR
          topic LIKE '%max_charge_current%' OR
          topic LIKE '%max_grid_charge_current%' OR
          topic LIKE '%max_generator_charge_current%' OR
          topic LIKE '%battery_float_charge_voltage%' OR
          topic LIKE '%battery_absorption_charge_voltage%' OR
          topic LIKE '%battery_equalization_charge_voltage%' OR
          change_type IN (
            'max_discharge_current', 
            'max_charge_current', 
            'max_grid_charge_current', 
            'max_generator_charge_current', 
            'battery_float_charge_voltage', 
            'battery_absorption_charge_voltage', 
            'battery_equalization_charge_voltage'
          )
        )
        AND user_id = ?
      `, [USER_ID]);
      
      changesCount = result.count;
    }
    
    res.render('battery-charging', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
      user_id: USER_ID // Pass user ID to template
    });
  } catch (error) {
    console.error('Error rendering battery-charging page:', error);
    res.status(500).send('Error loading page data');
  }
});

// Update the battery charging settings API
app.post('/api/battery-charging/set', (req, res) => {
  try {
    // Check if learner mode is active
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
    
    // Validate settings that are allowed to be changed
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
    
    // Validate inverter ID
    const inverterID = inverter.replace('inverter_', '');
    if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
      return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` });
    }
    
    // Validate value ranges based on the setting type
    let isValid = true;
    let validationError = '';
    
    switch (setting) {
      case 'max_discharge_current':
      case 'max_charge_current':
      case 'max_grid_charge_current':
      case 'max_generator_charge_current':
        // Current values are typically between 0-100A
        if (parseFloat(value) < 0 || parseFloat(value) > 100) {
          isValid = false;
          validationError = `${setting} must be between 0 and 100 A`;
        }
        break;
      case 'battery_float_charge_voltage':
      case 'battery_absorption_charge_voltage':
      case 'battery_equalization_charge_voltage':
        // Voltage values are typically between 40-60V for 48V systems
        if (parseFloat(value) < 40 || parseFloat(value) > 60) {
          isValid = false;
          validationError = `${setting} must be between 40 and 60 V`;
        }
        break;
    }
    
    if (!isValid) {
      return res.status(400).json({ error: validationError });
    }
    
    // Construct MQTT topic
    const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`;
    
    // Publish to MQTT
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

// 3. Add API endpoint for getting current battery charging and work mode settings
app.get('/api/current-settings', async (req, res) => {
  try {
    // Create an object to hold current settings
    const currentSettings = {
      battery_charging: {},
      work_mode: {}
    };
    
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
        const settingName = topic.split('/').pop();
        currentSettings.battery_charging[settingName] = previousSettings[topic];
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
        
        const settingName = topic.split('/').pop();
        currentSettings.work_mode[settingName] = previousSettings[topic];
      }
    }
    
    res.json({
      success: true,
      currentSettings,
      inverterCount: inverterNumber,
      batteryCount: batteryNumber
    });
  } catch (error) {
    console.error('Error retrieving current settings:', error);
    res.status(500).json({ error: 'Failed to retrieve current settings' });
  }
});


// Fix API endpoints for manually changing work mode settings from UI
app.post('/api/work-mode/set', (req, res) => {
  try {
    // Check if learner mode is active
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
    ];
    
    if (!allowedSettings.includes(setting)) {
      return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` });
    }
    
    // Validate inverter ID
    const inverterID = inverter.replace('inverter_', '');
    if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
      return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` });
    }
    
    // Validate value based on setting type
    let isValid = true;
    let validationError = '';
    
    switch (setting) {
      case 'remote_switch':
      case 'generator_charge':
      case 'force_generator_on':
      case 'solar_export_when_battery_full':
        // Boolean settings
        if (value !== 'Enabled' && value !== 'Disabled' && value !== 'true' && value !== 'false' && value !== '1' && value !== '0') {
          isValid = false;
          validationError = `${setting} must be one of: Enabled, Disabled, true, false, 1, 0`;
        }
        break;
      case 'work_mode':
        // Enumeration settings
        const validWorkModes = ['Battery first', 'Grid first', 'Solar first', 'Solar + Battery', 'Solar + Grid'];
        if (!validWorkModes.includes(value)) {
          isValid = false;
          validationError = `${setting} must be one of: ${validWorkModes.join(', ')}`;
        }
        break;
      case 'output_shutdown_voltage':
      case 'stop_battery_discharge_voltage':
      case 'start_battery_discharge_voltage':
      case 'start_grid_charge_voltage':
        // Voltage values typically between 40-60V for 48V systems
        if (parseFloat(value) < 40 || parseFloat(value) > 60) {
          isValid = false;
          validationError = `${setting} must be between 40 and 60 V`;
        }
        break;
      case 'max_sell_power':
      case 'max_solar_power':
        // Power values in Watts, typical range 0-15000W
        if (parseFloat(value) < 0 || parseFloat(value) > 15000) {
          isValid = false;
          validationError = `${setting} must be between 0 and 15000 W`;
        }
        break;
      case 'grid_trickle_feed':
        // Typically a percentage or small value
        if (parseFloat(value) < 0 || parseFloat(value) > 100) {
          isValid = false;
          validationError = `${setting} must be between 0 and 100`;
        }
        break;
    }
    
    if (!isValid) {
      return res.status(400).json({ error: validationError });
    }
    
    // Construct MQTT topic
    const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`;
    
    // Publish to MQTT
    mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}: ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
      
      console.log(`Work Mode command sent: ${topic} = ${value}`);
      res.json({ success: true, message: `Command sent: ${topic} = ${value}` });
    });
  } catch (error) {
    console.error('Error sending work mode command:', error);
    res.status(500).json({ error: error.message });
  }
});


// 5. Add API endpoint for retrieving setting history to create charts/graphs in UI
app.get('/api/settings-history/:setting', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const setting = req.params.setting;
    const days = parseInt(req.query.days) || 7; // Default to 7 days
    
    // Calculate date threshold (e.g., past 7 days)
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - days);
    
    // Find all changes for this setting
    const changes = await db.all(`
      SELECT * FROM settings_changes 
      WHERE (topic LIKE ? OR change_type = ?) 
      AND timestamp >= ? 
      AND user_id = ?
      ORDER BY timestamp ASC
    `, [`%${setting}%`, setting, dateThreshold.toISOString(), USER_ID]);
    
    // Format data for charting (timestamp + value pairs)
    const formattedData = changes.map(change => ({
      timestamp: new Date(change.timestamp),
      value: parseJsonOrValue(change.new_value),
      old_value: parseJsonOrValue(change.old_value),
      system_state: JSON.parse(change.system_state || '{}')
    }));
    
    res.json({
      success: true,
      setting,
      data: formattedData,
      count: formattedData.length
    });
  } catch (error) {
    console.error(`Error retrieving ${req.params.setting} history:`, error);
    res.status(500).json({ error: 'Failed to retrieve setting history' });
  }
});


app.get('/work-mode', async (req, res) => {
  try {
    let changesCount = 0;
    if (dbConnected) {
      const result = await db.get(`
        SELECT COUNT(*) as count FROM settings_changes 
        WHERE (
          topic LIKE '%remote_switch%' OR
          topic LIKE '%generator_charge%' OR
          topic LIKE '%force_generator_on%' OR
          topic LIKE '%output_shutdown_voltage%' OR
          topic LIKE '%stop_battery_discharge_voltage%' OR
          topic LIKE '%start_battery_discharge_voltage%' OR
          topic LIKE '%start_grid_charge_voltage%' OR
          topic LIKE '%work_mode%' OR
          topic LIKE '%solar_export_when_battery_full%' OR
          topic LIKE '%max_sell_power%' OR
          topic LIKE '%max_solar_power%' OR
          topic LIKE '%grid_trickle_feed%' OR
          change_type IN (
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
          )
        )
        AND user_id = ?
      `, [USER_ID]);
      
      changesCount = result.count;
    }
    
    res.render('work-mode', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
      user_id: USER_ID // Pass user ID to template
    });
  } catch (error) {
    console.error('Error rendering work-mode page:', error);
    res.status(500).send('Error loading page data');
  }
});


// New API endpoint for voltage point changes
app.get('/api/voltage-point-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const voltagePointChanges = await db.all(`
      SELECT * FROM settings_changes 
      WHERE (topic LIKE '%voltage_point%' OR change_type = 'voltage_point')
      AND user_id = ?
      ORDER BY timestamp DESC
    `, [USER_ID]);
    
    // Parse JSON fields and format dates
    const formattedChanges = voltagePointChanges.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    res.json(formattedChanges);
  } catch (error) {
    console.error('Error retrieving voltage point changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

app.get('/grid-charge', async (req, res) => {
  try {
    let changesCount = 0;
    if (dbConnected) {
      const result = await db.get(`
        SELECT COUNT(*) as count FROM settings_changes 
        WHERE (topic LIKE '%grid_charge%' OR change_type = 'grid_charge')
        AND user_id = ?
      `, [USER_ID]);
      
      changesCount = result.count;
    }
    
    res.render('grid-charge', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
      user_id: USER_ID,
      mqtt_topic_prefix: options.mqtt_topic_prefix || 'energy' // Pass the MQTT topic prefix
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
    const gridChargeChanges = await db.all(`
      SELECT * FROM settings_changes 
      WHERE (
        topic LIKE '%grid_charge%' OR 
        change_type IN ('grid_charge', 'max_grid_charge_current')
      )
      AND user_id = ?
      ORDER BY timestamp DESC
    `, [USER_ID]);
    
    // Parse JSON fields and format dates
    const formattedChanges = gridChargeChanges.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    res.json(formattedChanges);
  } catch (error) {
    console.error('Error retrieving grid charge changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

app.get('/energy-pattern', async (req, res) => {
  try {
    let changesCount = 0;
    if (dbConnected) {
      const result = await db.get(`
        SELECT COUNT(*) as count FROM settings_changes 
        WHERE (topic LIKE '%energy_pattern%' OR change_type = 'energy_pattern')
        AND user_id = ?
      `, [USER_ID]);
      
      changesCount = result.count;
    }
    
    res.render('energy-pattern', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
      user_id: USER_ID // Pass user ID to template
    });
  } catch (error) {
    console.error('Error rendering energy-pattern page:', error);
    res.status(500).send('Error loading page data');
  }
});

// New route for voltage point view
app.get('/voltage-point', async (req, res) => {
  try {
    let changesCount = 0;
    if (dbConnected) {
      const result = await db.get(`
        SELECT COUNT(*) as count FROM settings_changes 
        WHERE (topic LIKE '%voltage_point%' OR change_type = 'voltage_point')
        AND user_id = ?
      `, [USER_ID]);
      
      changesCount = result.count;
    }
    
    res.render('voltage-point', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
      user_id: USER_ID, // Pass user ID to template
      mqtt_topic_prefix: options.mqtt_topic_prefix || 'energy' // Add this line to pass MQTT topic prefix
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
      rule = await getRuleById(ruleId, USER_ID);
    }
    
    // Get current system state for reference
    const systemState = { ...currentSystemState };
    
    // Get the number of inverters from config
    const numInverters = inverterNumber || 1;
    
    res.render('wizard', { 
      rule,
      systemState,
      numInverters,
      editMode: !!ruleId,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
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
    
    // Create the rule with user identification
    const rule = {
      name,
      description,
      active: active !== undefined ? active : true,
      conditions: conditions || [],
      timeRestrictions: timeRestrictions || {},
      actions,
      // Add user identification
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    const savedRule = await saveRule(rule);
    
    // Log the creation
    console.log(`Rule "${name}" created successfully`);
    
    res.status(201).json(savedRule);
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
    const rule = await getRuleById(req.params.id, USER_ID);
    
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    // Update the rule
    const updatedRule = {
      ...rule,
      name,
      description,
      active: active !== undefined ? active : true,
      conditions: conditions || [],
      timeRestrictions: timeRestrictions || {},
      actions
    };
    
    const success = await updateRule(req.params.id, updatedRule);
    
    if (!success) {
      return res.status(500).json({ error: 'Failed to update rule' });
    }
    
    console.log(`Rule "${name}" updated successfully`);
    
    res.json(updatedRule);
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
    const originalRule = await getRuleById(req.params.id, USER_ID);
    
    if (!originalRule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    // Create a new rule based on the original
    const newRule = {
      name: `Copy of ${originalRule.name}`,
      description: originalRule.description,
      active: originalRule.active,
      conditions: originalRule.conditions,
      timeRestrictions: originalRule.timeRestrictions,
      actions: originalRule.actions,
      // Add user identification
      user_id: USER_ID,
      mqtt_username: mqttConfig.username
    };
    
    const savedRule = await saveRule(newRule);
    
    console.log(`Rule "${originalRule.name}" duplicated as "${newRule.name}"`);
    
    res.status(201).json(savedRule);
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
      ruleHistory = await db.all(`
        SELECT * FROM rules
        WHERE last_triggered IS NOT NULL
        AND user_id = ?
        ORDER BY last_triggered DESC
      `, [USER_ID]);
      
      // Parse JSON fields and format dates
      ruleHistory = ruleHistory.map(rule => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        active: rule.active === 1,
        conditions: JSON.parse(rule.conditions || '[]'),
        timeRestrictions: JSON.parse(rule.time_restrictions || '{}'),
        actions: JSON.parse(rule.actions || '[]'),
        createdAt: new Date(rule.created_at),
        lastTriggered: rule.last_triggered ? new Date(rule.last_triggered) : null,
        triggerCount: rule.trigger_count,
        user_id: rule.user_id,
        mqtt_username: rule.mqtt_username
      }));
    }
    
    res.render('rule-history', {
      ruleHistory,
      db_connected: dbConnected,
      system_state: systemState,
      ingress_path: process.env.INGRESS_PATH || '',
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
    const sortBy = req.query.sortBy || 'last_triggered';
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    
    // Get rules that have been triggered for the current user
    const ruleHistory = await db.all(`
      SELECT id, name, description, last_triggered, trigger_count, conditions, actions, time_restrictions
      FROM rules
      WHERE last_triggered IS NOT NULL
      AND user_id = ?
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT ? OFFSET ?
    `, [USER_ID, limit, skip]);
    
    // Get total count for pagination
    const countResult = await db.get(`
      SELECT COUNT(*) as total
      FROM rules
      WHERE last_triggered IS NOT NULL
      AND user_id = ?
    `, [USER_ID]);
    
    const totalCount = countResult.total;
    
    // Parse JSON fields and format dates
    const formattedRules = ruleHistory.map(rule => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      lastTriggered: new Date(rule.last_triggered),
      triggerCount: rule.trigger_count,
      conditions: JSON.parse(rule.conditions || '[]'),
      actions: JSON.parse(rule.actions || '[]'),
      timeRestrictions: JSON.parse(rule.time_restrictions || '{}')
    }));
    
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
    
    // Get total rules count for the current user
    const totalRulesResult = await db.get(`
      SELECT COUNT(*) as count FROM rules WHERE user_id = ?
    `, [USER_ID]);
    
    // Calculate total executions
    const totalExecutionsResult = await db.get(`
      SELECT SUM(trigger_count) as total FROM rules WHERE user_id = ?
    `, [USER_ID]);
    
    // Find most active rule
    const mostActiveRuleResult = await db.get(`
      SELECT name, trigger_count FROM rules 
      WHERE user_id = ? AND trigger_count > 0
      ORDER BY trigger_count DESC
      LIMIT 1
    `, [USER_ID]);
    
    // Calculate executions in the last 24 hours
    const now = new Date();
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    
    const last24HoursResult = await db.get(`
      SELECT COUNT(*) as count FROM rules 
      WHERE user_id = ? 
      AND last_triggered IS NOT NULL 
      AND last_triggered >= ?
    `, [USER_ID, oneDayAgo.toISOString()]);
    
    // Send simplified response with just the data needed for the dashboard
    res.json({
      totalRules: totalRulesResult.count || 0,
      totalExecutions: totalExecutionsResult.total || 0,
      last24Hours: last24HoursResult.count || 0,
      mostActiveRule: mostActiveRuleResult ? mostActiveRuleResult.name : 'None'
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
    
    const rule = await getRuleById(req.params.id, USER_ID);
    
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    // If the rule has never been triggered, return an empty history
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
    
    // Get rule details and execution history
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
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    // Check if learner mode is active
    if (!learnerModeActive) {
      return res.status(403).json({ error: 'Learner mode is not active. Cannot execute rules.' });
    }
    
    // Find the rule filtered by both ID and user_id
    const rule = await getRuleById(req.params.id, USER_ID);
    
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
    await updateRule(rule.id, rule);
    
    // Log removed: console.log(`Rule "${rule.name}" manually executed at ${rule.lastTriggered}`);
    
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


// Enhance the rules page with additional data
app.get('/rules', async (req, res) => {
  try {
    let rulesCount = 0;
    let activeRulesCount = 0;
    let systemState = { ...currentSystemState };
    let recentlyTriggered = [];
    
    if (dbConnected) {
      const rulesCountResult = await db.get(`
        SELECT COUNT(*) as count FROM rules WHERE user_id = ?
      `, [USER_ID]);
      
      rulesCount = rulesCountResult.count;
      
      const activeRulesCountResult = await db.get(`
        SELECT COUNT(*) as count FROM rules WHERE active = 1 AND user_id = ?
      `, [USER_ID]);
      
      activeRulesCount = activeRulesCountResult.count;
      
      // Get recently triggered rules
      const recentlyTriggeredResults = await db.all(`
        SELECT id, name, last_triggered
        FROM rules
        WHERE last_triggered IS NOT NULL
        AND user_id = ?
        ORDER BY last_triggered DESC
        LIMIT 5
      `, [USER_ID]);
      
      recentlyTriggered = recentlyTriggeredResults.map(rule => ({
        id: rule.id,
        name: rule.name,
        lastTriggered: new Date(rule.last_triggered)
      }));
    }
    
    res.render('rules', { 
      db_connected: dbConnected,
      rules_count: rulesCount,
      active_rules_count: activeRulesCount,
      system_state: systemState,
      recently_triggered: recentlyTriggered,
      ingress_path: process.env.INGRESS_PATH || '',
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
    
    const rules = await getAllRules(USER_ID, { sort: { field: 'name', order: 'ASC' } });
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
    const success = await deleteRule(req.params.id, USER_ID);
    
    if (!success) {
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
    const rule = await getRuleById(req.params.id, USER_ID);
    
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
  });
});

app.get('/api/settings-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const changeType = req.query.type;
    const limit = parseInt(req.query.limit) || 100;
    const skip = parseInt(req.query.skip) || 0;
    
    let query = `SELECT * FROM settings_changes WHERE user_id = ?`;
    const params = [USER_ID];
    
    if (changeType) {
      query += ` AND change_type = ?`;
      params.push(changeType);
    }
    
    query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, skip);
    
    const changes = await db.all(query, params);
    
    const totalCountQuery = `SELECT COUNT(*) as total FROM settings_changes WHERE user_id = ?` + 
      (changeType ? ` AND change_type = ?` : ``);
    
    const totalParams = changeType ? [USER_ID, changeType] : [USER_ID];
    const totalResult = await db.get(totalCountQuery, totalParams);
    
    // Parse JSON fields and format dates
    const formattedChanges = changes.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    res.json({
      changes: formattedChanges,
      pagination: {
        total: totalResult.total,
        limit,
        skip,
        hasMore: skip + limit < totalResult.total
      }
    });
  } catch (error) {
    console.error('Error retrieving settings changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});


app.get('/api/learner/status', (req, res) => {
  res.json({ 
    active: learnerModeActive,
    change_detection: 'always', // Indicating that changes are always detected
    action_execution: learnerModeActive ? 'enabled' : 'disabled', // Only execute actions when learner mode is active
    monitored_settings: settingsToMonitor,
    current_system_state: currentSystemState,
    db_connected: dbConnected
  });
});

app.post('/api/learner/toggle', (req, res) => {
  learnerModeActive = !learnerModeActive;
  
  console.log(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`);
  
  res.json({ 
    success: true, 
    active: learnerModeActive,
    message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`,
    note: "Setting changes are still detected and recorded, but commands will only be sent when learner mode is active."
  });
});

app.get('/api/learner/changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    
    const changes = await db.all(`
      SELECT * FROM settings_changes 
      WHERE user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [USER_ID, limit]);
    
    // Parse JSON fields and format dates
    const formattedChanges = changes.map(change => ({
      id: change.id,
      timestamp: new Date(change.timestamp),
      topic: change.topic,
      old_value: parseJsonOrValue(change.old_value),
      new_value: parseJsonOrValue(change.new_value),
      system_state: JSON.parse(change.system_state || '{}'),
      change_type: change.change_type,
      user_id: change.user_id,
      mqtt_username: change.mqtt_username
    }));
    
    res.json(formattedChanges);
  } catch (error) {
    console.error('Error retrieving learner changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

app.get('/api/database/status', (req, res) => {
  res.json({
    connected: dbConnected,
    type: 'SQLite',
    file: DB_FILE.replace(/^.*[\\\/]/, '') // Just the filename, not the full path
  });
});

app.get('/learner', async (req, res) => {
  try {
    let changesCount = 0;
    if (dbConnected) {
      const result = await db.get(`
        SELECT COUNT(*) as count FROM settings_changes WHERE user_id = ?
      `, [USER_ID]);
      
      changesCount = result.count;
    }
    
    res.render('learner', { 
      active: learnerModeActive,
      change_detection: 'always', // New property to inform the front-end
      monitored_settings: settingsToMonitor,
      changes_count: changesCount,
      db_connected: dbConnected,
      ingress_path: process.env.INGRESS_PATH || '',
      user_id: USER_ID // Pass user ID to template
    });
  } catch (error) {
    console.error('Error rendering learner page:', error);
    res.status(500).send('Error loading page data');
  }
});

// Update the direct MQTT command injection route
app.post('/api/command', (req, res) => {
  try {
    // Check if learner mode is active
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
    
    mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}: ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
      
     // Uncomment or add this line:
  console.log(`Command sent through API: ${topic} = ${value}`);
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
  
  // Call the handleMqttMessage function to process and save to MongoDB
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
  if (db) {
    console.log('Closing SQLite connection')
    db.close().catch(err => console.error('Error closing SQLite:', err))
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
  connectToMqtt();
  
  // Connect to WebSocket broker
  connectToWebSocketBroker();
  
  // Connect to database
  try {
    await connectToDatabase();
    
    // Create default rules if connected to DB
    if (dbConnected) {
      // Replace the original createDefaultRules() call with our enhanced initialization
      await initializeAutomationRules();
    }
  } catch (err) {
    console.error('Initial database connection failed:', err);
    // Continue app startup even if DB fails initially
    setTimeout(retryDatabaseConnection, 10000);
  }
}

// Function that integrates both default and extended rules
async function initializeAutomationRules() {
  try {
    // First create the basic default rules
    await createDefaultRules();
    
    // Then create the extended advanced rules
    await createExtendedAutomationRules();

    // Create the night charging rules (updated to avoid weekend conflicts)
    await createNightChargingRule();
    
    // Create weekend grid charge rules
    await createWeekendGridChargeRules();
    
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
