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
const app = express()
const port = process.env.PORT || 6789
const socketPort = 8000
const { http } = require('follow-redirects')
const cors = require('cors')
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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

// Extract inverter and battery numbers from options
const inverterNumber = options.inverter_number || 1
const batteryNumber = options.battery_number || 1
// MQTT topic prefix
const mqttTopicPrefix = options.mqtt_topic_prefix || '${mqttTopicPrefix}'

// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const CACHE_DURATION = 24 * 3600000; // 24 hours in milliseconds


// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Disabled for development, enable in production
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);


// Ensure data directory and settings file exist
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
const influx = new Influx.InfluxDB(influxConfig)

// MQTT configuration
const mqttConfig = {
  host: 'homeassistant.local',
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
}

// Connect to MQTT broker
let mqttClient
let incomingMessages = []
const MAX_MESSAGES = 400

// Learner mode configuration
let learnerModeActive = false;
const settingsToMonitor = [
  'energy_pattern',
  'grid_charge',
  'power',
  'device_mode',
  'voltage'
];

// Store system state
let currentSystemState = {
  battery_soc: null,
  pv_power: null,
  load: null,
  timestamp: null
};

// Define log file paths with fallback options
const primaryDataDir = '/data';
const fallbackDataDir = path.join(__dirname, 'data');
let dataDir, logsDir, learnerLogFile, settingsChangesFile;

// Try to set up log directories with proper error handling
try {
  // Try primary location first
  dataDir = primaryDataDir;
  logsDir = path.join(dataDir, 'logs');
  
  // Check if primary data directory exists and is writable
  if (!fs.existsSync(dataDir)) {
    console.log(`Primary data directory ${dataDir} does not exist, attempting to create it`);
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Test write permissions by writing a temp file
  const testFile = path.join(dataDir, '.write_test');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  
  // Primary location is writable, use it
  console.log(`Using primary data directory: ${dataDir}`);
} catch (error) {
  // Fall back to local directory
  console.warn(`Cannot use primary data directory: ${error.message}`);
  console.log(`Falling back to local data directory`);
  
  dataDir = fallbackDataDir;
  logsDir = path.join(dataDir, 'logs');
  
  // Create fallback directories
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// Now create logs directory if it doesn't exist
if (!fs.existsSync(logsDir)) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log(`Created logs directory at: ${logsDir}`);
  } catch (error) {
    console.error(`Error creating logs directory: ${error.message}`);
  }
}

// Set file paths after directory setup
learnerLogFile = path.join(logsDir, 'learner_mode.log');
settingsChangesFile = path.join(logsDir, 'settings_changes.json');

// Function for logging to file with better error handling
function logToFile(message) {
  try {
    // Double check directory exists before writing
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      console.log(`Created logs directory at: ${logsDir}`);
    }
    
    const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
    const logMessage = `[${timestamp}] ${message}\n`;
    
    // Use synchronous write to ensure logging completes
    fs.appendFileSync(learnerLogFile, logMessage);
  } catch (err) {
    console.error(`Logging error: ${err.message}`);
    console.error(`Attempted to write to: ${learnerLogFile}`);
    console.error(`Current working directory: ${process.cwd()}`);
  }
}

// Initialize or load existing settings changes data
let settingsChanges = [];
try {
  if (fs.existsSync(settingsChangesFile)) {
    const fileContent = fs.readFileSync(settingsChangesFile, 'utf8');
    // Only try to parse if the file has content
    if (fileContent && fileContent.trim().length > 0) {
      settingsChanges = JSON.parse(fileContent);
    }
  }
} catch (error) {
  console.error('Error loading settings changes file:', error);
  console.log('Creating new settings changes file');
  // Initialize with empty array and save
  settingsChanges = [];
  try {
    fs.writeFileSync(settingsChangesFile, JSON.stringify(settingsChanges));
  } catch (writeError) {
    console.error('Error initializing settings file:', writeError);
  }
}

// Function to save settings changes
function saveSettingsChanges() {
  try {
    // Ensure directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.writeFileSync(settingsChangesFile, JSON.stringify(settingsChanges, null, 2));
  } catch (error) {
    console.error('Error saving settings changes:', error);
    logToFile('Error saving settings changes: ' + error.message);
  }
}
// Track previous state of settings to detect changes
let previousSettings = {};

// Handle incoming MQTT messages
function handleMqttMessage(topic, message) {
  const formattedMessage = `${topic}: ${message.toString()}`;
  
  // Add to the circular buffer of messages
  incomingMessages.push(formattedMessage);
  if (incomingMessages.length > MAX_MESSAGES) {
    incomingMessages.shift();
  }

  // Parse message content
  let messageContent;
  try {
    messageContent = message.toString();
    
    // Try to parse as JSON if it looks like JSON
    if (messageContent.startsWith('{') && messageContent.endsWith('}')) {
      messageContent = JSON.parse(messageContent);
    }
  } catch (error) {
    // If not JSON, keep as string
    messageContent = message.toString();
  }

  // Extract the specific topic part after the prefix
  const topicPrefix = options.mqtt_topic_prefix || '';
  let specificTopic = topic;
  if (topic.startsWith(topicPrefix)) {
    specificTopic = topic.substring(topicPrefix.length + 1); // +1 for the slash
  }

  // Update system state for key metrics
  if (specificTopic.includes('battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent);
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  } else if (specificTopic.includes('pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent);
  } else if (specificTopic.includes('load_power')) {
    currentSystemState.load = parseFloat(messageContent);
  }

  // Check if this is a settings topic we're monitoring
  let isSettingsTopic = false;
  for (const setting of settingsToMonitor) {
    if (specificTopic.includes(setting)) {
      isSettingsTopic = true;
      
      // Only proceed if we're in learner mode
      if (learnerModeActive) {
        // Check if the setting has changed
        if (previousSettings[specificTopic] !== messageContent) {
          // Log the change
          const changeData = {
            id: Date.now().toString(), // Add unique ID based on timestamp
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
            topic: specificTopic,
            old_value: previousSettings[specificTopic],
            new_value: messageContent,
            system_state: { ...currentSystemState }
          };
          
          logToFile(`Settings change detected: ${JSON.stringify(changeData)}`);
          settingsChanges.push(changeData);
          saveSettingsChanges();
          
          // Update previous settings
          previousSettings[specificTopic] = messageContent;
        }
      } else {
        // Keep track of current settings even when not in learner mode
        previousSettings[specificTopic] = messageContent;
      }
      break;
    }
  }

  // For debugging, log all messages to the learner log if in debug mode
  if (learnerModeActive && specificTopic.includes('debug')) {
    logToFile(`DEBUG - ${specificTopic}: ${JSON.stringify(messageContent)}`);
  }
}

app.get('/api/learner/status', (req, res) => {
  res.json({ 
    active: learnerModeActive,
    monitored_settings: settingsToMonitor,
    current_system_state: currentSystemState,
    log_file_path: learnerLogFile
  });
});

app.post('/api/learner/toggle', (req, res) => {
  learnerModeActive = !learnerModeActive;
  
  logToFile(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`);
  
  res.json({ 
    success: true, 
    active: learnerModeActive,
    message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`
  });
});

app.get('/api/learner/changes', (req, res) => {
  res.json(settingsChanges);
});

// New endpoint for deleting a change
app.delete('/api/learner/changes/:id', (req, res) => {
  const changeId = req.params.id;
  
  // Find the index of the change to delete
  const changeIndex = settingsChanges.findIndex(change => change.id === changeId);
  
  if (changeIndex === -1) {
    return res.status(404).json({ success: false, message: 'Change not found' });
  }
  
  // Remove the change from the array
  settingsChanges.splice(changeIndex, 1);
  
  // Save the updated changes to the file
  saveSettingsChanges();
  
  logToFile(`Deleted change with ID: ${changeId}`);
  
  res.json({ success: true, message: 'Change deleted successfully' });
});

app.get('/api/system/paths', (req, res) => {
  res.json({
    cwd: process.cwd(),
    data_dir: dataDir,
    logs_dir: logsDir,
    learner_log_file: learnerLogFile,
    settings_changes_file: settingsChangesFile
  });
});

app.get('/learner', (req, res) => {
  res.render('learner', { 
    active: learnerModeActive,
    monitored_settings: settingsToMonitor,
    changes_count: settingsChanges.length,
    ingress_path: process.env.INGRESS_PATH || '',
    log_path: learnerLogFile
  });
});


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

function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
  })

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker')
    mqttClient.subscribe(`${mqttTopicPrefix}/#`)
  })

  mqttClient.on('message', (topic, message) => {
    const formattedMessage = `${topic}: ${message.toString()}`
    incomingMessages.push(formattedMessage)
    if (incomingMessages.length > MAX_MESSAGES) {
      incomingMessages.shift()
    }
    saveMessageToInfluxDB(topic, message)
  })

  mqttClient.on('error', (err) => {
    console.error('Error connecting to MQTT broker:', err.message)
    mqttClient = null
  })
}

// Save MQTT message to InfluxDB
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


// Route handlers
app.get('/messages', (req, res) => {
  res.render('messages', {
    ingress_path: process.env.INGRESS_PATH || '',
    categoryOptions: generateCategoryOptions(inverterNumber, batteryNumber),
  })
})

app.get('/api/messages', (req, res) => {
  const category = req.query.category
  const filteredMessages = filterMessagesByCategory(category)
  res.json(filteredMessages)
})

app.get('/chart', (req, res) => {
  res.render('chart', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, // Include mqtt_host here
  })
})


function getSelectedZone(req) {
  // First, check if a zone is provided in the query
  if (req.query.zone) {
    return req.query.zone;
  }
  return null;
}

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

const server = app.listen(port, '0.0.0.0', async () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  connectToMqtt();
  connectToWebSocketBroker();
});


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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

// 404 handler
app.use((req, res, next) => {
  res.status(404).send("Sorry, that route doesn't exist.")
})

module.exports = { app, server }
