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
const NodeCache = require('node-cache');

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
const CACHE_DURATION = 86400000; // 24 hours in milliseconds

// Advanced cache implementation
const cache = new NodeCache({ 
  stdTTL: 86400, // 24 hours in seconds 
  checkperiod: 120, // Check every 2 minutes for expired items
  useClones: false // Use references instead of copies for better performance
});

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

app.get('/', (req, res) => {
  const expectedInverters = parseInt(options.inverter_number) || 1
  const inverterWarning = checkInverterMessages(
    incomingMessages,
    expectedInverters
  )

  const batteryWarning = checkBatteryInformation(incomingMessages)

  res.render('energy-dashboard', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, // Include mqtt_host here
    inverterWarning,
    batteryWarning,
    batteryMessages: debugBatteryMessages(incomingMessages), // Add this for debugging in the view
  })
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
const carbonIntensityCache = new Map();

// Utility Functions
async function getZones() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE));
    
    // Check cache first
    const cachedZones = cache.get('zones');
    if (cachedZones) {
      return cachedZones;
    }
    
    if (!settings.apiKey) {
      return {
        success: false,
        error: 'API key not configured',
        zones: []
      };
    }

    const response = await axios.get('https://api.electricitymap.org/v3/zones', {
      headers: { 'Authorization': `Bearer ${settings.apiKey}` },
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

    const result = {
      success: true,
      zones
    };
    
    // Cache zones for 24 hours
    cache.set('zones', result, 86400);
    
    return result;
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
      const { timezone, apiKey, selectedZone, username } = req.body;
      
      // Validate the settings
      if (!timezone || !selectedZone || !username) {
          return res.status(400).json({
              success: false,
              error: 'All fields are required'
          });
      }

      // Save the settings to the settings file
      const settings = {
          apiKey: apiKey || '',
          selectedZone,
          username,
          timezone
      };

      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

      // Update the current timezone
      currentTimezone = timezone;
      setCurrentTimezone(timezone);

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


app.post('/validate-api-key', async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    const response = await axios.get('https://api.electricitymap.org/v3/zones', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 5000
    });

    res.json({ 
      valid: !response.data.error,
      message: response.data.error ? 'Invalid API key' : 'API key is valid'
    });
  } catch (error) {
    res.json({ 
      valid: false, 
      message: error.response?.status === 401 
        ? 'Invalid API key'
        : 'Error validating API key'
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
    const selectedZone = req.query.zone || JSON.parse(fs.readFileSync(SETTINGS_FILE)).selectedZone;
    
    // Use cache first approach for frequently accessed data
    const cacheKey = `results_data_${selectedZone}`;
    let cachedResults = cache.get(cacheKey);
    
    if (cachedResults) {
      return res.render('results', cachedResults);
    }
    
    const zones = await getZones();
    let historyData = [], gridEnergyIn = [], pvEnergy = [], gridVoltage = [];
    let error = null;

    if (selectedZone) {
      try {
        // Fetch data in parallel
        [historyData, gridEnergyIn, pvEnergy, gridVoltage] = await Promise.all([
          fetchCarbonIntensityHistory(selectedZone),
          queryInfluxData(`${mqttTopicPrefix}/total/grid_energy_in/state`, '365d'),
          queryInfluxData(`${mqttTopicPrefix}/total/pv_energy/state`, '365d'),
          queryInfluxData(`${mqttTopicPrefix}/total/grid_voltage/state`, '365d')
        ]);
      } catch (e) {
        console.error('Error fetching data:', e);
        error = 'Error fetching data. Please try again later.';
      }
    }

    const emissionsData = calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage);

    const periods = {
      week: emissionsData.slice(-7),
      month: emissionsData.slice(-30),
      quarter: emissionsData.slice(-90),
      year: emissionsData
    };

    const todayData = emissionsData[emissionsData.length - 1] || {
      unavoidableEmissions: 0,
      avoidedEmissions: 0,
      selfSufficiencyScore: 0
    };

    const resultsData = {
      selectedZone,
      zones,
      periods,
      todayData,
      error,
      unavoidableEmissions: todayData.unavoidableEmissions,
      avoidedEmissions: todayData.avoidedEmissions,
      selfSufficiencyScore: todayData.selfSufficiencyScore,
      ingress_path: process.env.INGRESS_PATH || '',
    };
    
    // Cache results for 1 hour
    cache.set(cacheKey, resultsData, 3600);
    
    res.render('results', resultsData);
  } catch (error) {
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

  // Check for cached data with more granular key
  const cacheKey = `carbonIntensity_${selectedZone}`;
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  const historyData = [];
  const today = moment();
  const oneYearAgo = moment().subtract(1, 'year');
  
  // Increase batch size for faster processing
  const batchSize = 14; // Two weeks at a time
  const allPromises = [];

  // Generate all promises at once instead of waiting for each batch
  for (let m = moment(oneYearAgo); m.isBefore(today); m.add(batchSize, 'days')) {
    for (let i = 0; i < batchSize && m.clone().add(i, 'days').isBefore(today); i++) {
      const date = m.clone().add(i, 'days').format('YYYY-MM-DD');
      const requestPromise = axios.get(
        `https://api.electricitymap.org/v3/carbon-intensity/history?zone=${selectedZone}&datetime=${date}`, 
        {
          headers: { 'Authorization': `Bearer ${settings.apiKey}` },
          timeout: 10000 // Add timeout to prevent hanging requests
        }
      )
      .then(response => {
        if (response.data.history && response.data.history.length > 0) {
          return {
            date: date,
            carbonIntensity: response.data.history[0].carbonIntensity
          };
        }
        return null;
      })
      .catch(error => {
        console.error(`Error fetching data for ${date}:`, error.message);
        return null;
      });
      
      allPromises.push(requestPromise);
    }
  }

  // Execute all requests in parallel with a maximum concurrency
  const MAX_CONCURRENT = 10;
  let results = [];
  for (let i = 0; i < allPromises.length; i += MAX_CONCURRENT) {
    const batch = allPromises.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.all(batch);
    results = results.concat(batchResults);
  }

  // Filter out null results and sort by date
  const validResults = results.filter(item => item !== null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Cache results for 24 hours
  cache.set(cacheKey, validResults, 86400);

  return validResults;
}

// More efficient emissions calculation
function calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage) {
  // Pre-process input data into maps for faster lookups
  const gridEnergyMap = new Map();
  gridEnergyIn.forEach(item => {
    // Extract the date part from the time
    const date = moment(item.time).format('YYYY-MM-DD');
    gridEnergyMap.set(date, item.value || 0);
  });

  const pvEnergyMap = new Map();
  pvEnergy.forEach(item => {
    const date = moment(item.time).format('YYYY-MM-DD');
    pvEnergyMap.set(date, item.value || 0);
  });

  const gridVoltageMap = new Map();
  gridVoltage.forEach(item => {
    const date = moment(item.time).format('YYYY-MM-DD');
    gridVoltageMap.set(date, item.value || 0);
  });

  // Process historical data more efficiently
  return historyData.map((dayData, index) => {
    const date = dayData.date;
    const prevDate = index > 0 ? historyData[index - 1].date : null;
    
    const carbonIntensity = dayData.carbonIntensity;
    const currentGridVoltage = gridVoltageMap.get(date) || 0;
    const isGridActive = Math.abs(currentGridVoltage) > 20;

    let gridEnergy = gridEnergyMap.get(date) || 0;
    let solarEnergy = pvEnergyMap.get(date) || 0;

    // Calculate daily differences
    if (prevDate) {
      const prevGridEnergy = gridEnergyMap.get(prevDate) || 0;
      const prevPvEnergy = pvEnergyMap.get(prevDate) || 0;
      gridEnergy = Math.max(0, gridEnergy - prevGridEnergy);
      solarEnergy = Math.max(0, solarEnergy - prevPvEnergy);
    }

    const unavoidableEmissions = isGridActive ? (gridEnergy * carbonIntensity) / 1000 : 0;
    const avoidedEmissions = isGridActive ? (solarEnergy * carbonIntensity) / 1000 : 0;
    const totalEnergy = gridEnergy + solarEnergy;
    const selfSufficiencyScore = totalEnergy > 0 ? (solarEnergy / totalEnergy) * 100 : 0;

    return {
      date,
      carbonIntensity,
      gridVoltage: currentGridVoltage,
      gridEnergy,
      solarEnergy,
      unavoidableEmissions,
      avoidedEmissions,
      selfSufficiencyScore,
    };
  });
}


app.get('/api/grid-voltage', async (req, res) => {
  try {
    // Use cache for grid voltage
    const cacheKey = 'current_grid_voltage';
    let voltage = cache.get(cacheKey);
    
    if (voltage === undefined) {
      const result = await influx.query(`
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${mqttTopicPrefix}/total/grid_voltage/state'
      `)
      voltage = result[0]?.value || 0;
      cache.set(cacheKey, voltage, 300); // Cache for 5 minutes
    }
    
    res.json({ voltage });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch grid voltage' });
  }
});

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
