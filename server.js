const express = require('express')
const bodyParser = require('body-parser')
const mqtt = require('mqtt')
const fs = require('fs')
const path = require('path')
const Influx = require('influx')
const ejs = require('ejs')
const axios = require('axios');
const moment = require('moment-timezone')
const WebSocket = require('ws')
const retry = require('async-retry')
const session = require('express-session');
require('dotenv').config();

const app = express()
const port = process.env.PORT || 6789
const socketPort = 7100
const { http } = require('follow-redirects')
const cors = require('cors')
const { connectDatabase, prisma } = require('./config/mongodb')
const { startOfDay } = require('date-fns')

// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
}));

// Read configuration from Home Assistant add-on options
const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))

const dashboardFilePath = './grafana/provisioning/dashboards/solar_power_dashboard.json';

// Extract inverter and battery numbers from options
const inverterNumber = options.inverter_number || 1;
const batteryNumber = options.battery_number || 1;

// InfluxDB configuration
const influxConfig = {
  host: options.mqtt_host,
  port: 8086,
  database: options.database_name,
  username: options.database_username,
  password: options.database_password,
  protocol: 'http',
  timeout: 10000,
}
const influx = new Influx.InfluxDB(influxConfig)

// MQTT configuration
const mqttConfig = {
  host: options.mqtt_host,
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
  const categories = ['all', 'loadPower', 'gridPower', 'pvPower', 'total'];
  
  for (let i = 1; i <= inverterNumber; i++) {
    categories.push(`inverter${i}`);
  }
  
  for (let i = 1; i <= batteryNumber; i++) {
    categories.push(`battery${i}`);
  }
  
  return categories;
}

const timezonePath = path.join(__dirname, 'timezone.json');

function getCurrentTimezone() {
  try {
    const data = fs.readFileSync(timezonePath, 'utf8');
    return JSON.parse(data).timezone;
  } catch (error) {
    return 'Indian/Mauritius'; // Default timezone
  }
}

function setCurrentTimezone(timezone) {
  fs.writeFileSync(timezonePath, JSON.stringify({ timezone }));
}

let currentTimezone = getCurrentTimezone();

function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
  })

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker')
    mqttClient.subscribe('solar_assistant_DEYE/#')
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


function publishToMQTT(topic, message) {
  let messageToSend = message;
  if (typeof message === 'number' && isNaN(message)) {
    console.warn(`Attempting to publish NaN value to ${topic}. Skipping.`);
    return;
  }
  if (typeof message !== 'string') {
    messageToSend = JSON.stringify(message);
  }

  client.publish(topic, messageToSend, (err) => {
    if (err) {
      console.error('Error publishing to MQTT:', err);
    } else {
      console.log(`Published to ${topic}: ${messageToSend}`);
      broadcastMessage({
        type: 'automationLog',
        message: `Published to ${topic}: ${messageToSend}`
      });
    }
  });
}

// Inverter configuration
let inverterConfig = {
  Deye: {
    workMode: ['Selling first', 'Zero Export to Load', 'Selling first'],
    solarExportWhenBatteryFull: true,
    energyPattern: ['Load First', 'Battery First'],
    maxSellPower: 5000
  },
  MPP: {
    // Add MPP-specific settings here
  }
};

// Data storage
let automationRules = [];
let scheduledSettings = [];
let universalSettings = {
  maxBatteryDischargePower: 500,
  gridChargeOn: false,
  generatorChargeOn: false,
  dischargeVoltage: 48.0
};
let currentInverterType = 'Deye';
let currentInverterSettings = { ...inverterConfig.Deye };

// Current system state
let currentSystemState = {
  inverter_1: {},
  inverter_2: {},
  battery_1: {},
  total: {},
  batteryPower: 0,
  batterySOC: 0,
  solarPower: 0,
  gridPower: 0,
  loadPower: 0,
  time: new Date(),
};

// Function to update the current system state
function updateSystemState(deviceType, measurement, value) {
  if (!currentSystemState[deviceType]) {
    currentSystemState[deviceType] = {};
  }
  currentSystemState[deviceType][measurement] = value;
  currentSystemState.time = new Date();

  // Special handling for 'total' measurements
  if (deviceType === 'total') {
    switch(measurement) {
      case 'battery_power':
        currentSystemState.batteryPower = value;
        break;
      case 'battery_state_of_charge':
        currentSystemState.batterySOC = value;
        break;
      case 'grid_power':
        currentSystemState.gridPower = value;
        break;
      case 'load_power':
        currentSystemState.loadPower = value;
        break;
      case 'pv_power':
        currentSystemState.solarPower = value;
        break;
    }
  }

  broadcastMessage({ type: 'stateUpdate', state: currentSystemState });
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
  `;
  try {
      return await influx.query(query);
  } catch (error) {
      console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
      throw error;
  }
}

// Calculate daily difference
function calculateDailyDifference(data) {
  return data.map((current, index, array) => {
    if (index === 0 || !array[index - 1].value) {
      return { ...current, difference: 0 }
    } else {
      const previousData = array[index - 1].value
      const currentData = current.value
      const difference =
        currentData >= previousData ? currentData - previousData : currentData
      return { ...current, difference: parseFloat(difference.toFixed(1)) }
    }
  })
}


// Route handlers

app.get('/settings', (req, res) => {
  res.render('settings', { ingress_path: process.env.INGRESS_PATH || '' })
})

app.get('/messages', (req, res) => {
  res.render('messages', { 
    ingress_path: process.env.INGRESS_PATH || '',
    categoryOptions: generateCategoryOptions(inverterNumber, batteryNumber)
  });
});



app.get('/api/messages', (req, res) => {
  const category = req.query.category;
  const filteredMessages = filterMessagesByCategory(category);
  res.json(filteredMessages);
});

app.get('/chart', (req, res) => {
  res.render('chart', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, // Include mqtt_host here
  })
})



app.get('/analytics', async (req, res) => {
  try {
      const loadPowerData = await queryInfluxDB('solar_assistant_DEYE/total/load_energy/state');
      const pvPowerData = await queryInfluxDB('solar_assistant_DEYE/total/pv_energy/state');
      const batteryStateOfChargeData = await queryInfluxDB('solar_assistant_DEYE/total/battery_energy_in/state');
      const batteryPowerData = await queryInfluxDB('solar_assistant_DEYE/total/battery_energy_out/state');
      const gridPowerData = await queryInfluxDB('solar_assistant_DEYE/total/grid_energy_in/state');
      const gridVoltageData = await queryInfluxDB('solar_assistant_DEYE/total/grid_energy_out/state');

      const data = {
          loadPowerData,
          pvPowerData,
          batteryStateOfChargeData,
          batteryPowerData,
          gridPowerData,
          gridVoltageData,
      };

      res.render('analytics', { data, ingress_path: process.env.INGRESS_PATH || '' });
  } catch (error) {
      console.error('Error fetching analytics data from InfluxDB:', error);
      res.status(500).json({ error: 'Error fetching analytics data from InfluxDB' });
  }
});


app.get('/', (req, res) => {
  res.render('energy-dashboard', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, 
  })
})



app.get('/api/timezone', (req, res) => {
  res.json({ timezone: currentTimezone });
});

app.post('/api/timezone', (req, res) => {
  const { timezone } = req.body;
  if (moment.tz.zone(timezone)) {
    currentTimezone = timezone;
    setCurrentTimezone(timezone);
    res.json({ success: true, timezone: currentTimezone });
  } else {
    res.status(400).json({ error: 'Invalid timezone' });
  }
});

// Universal Settings
app.get('/api/universal-settings', (req, res) => {
  res.json(universalSettings);
});

app.post('/api/universal-settings', (req, res) => {
  universalSettings = { ...universalSettings, ...req.body };
  res.json(universalSettings);
  Object.entries(universalSettings).forEach(([key, value]) => {
    publishToMQTT(`solar_assistant_DEYE/universal/${key}`, value);
  });
});

// Inverter Settings
app.get('/api/inverter-types', (req, res) => {
  res.json(Object.keys(inverterConfig));
});

app.get('/api/inverter-settings', (req, res) => {
  res.json({ type: currentInverterType, settings: currentInverterSettings });
});

app.post('/api/inverter-settings', (req, res) => {
  const { type, settings } = req.body;
  if (inverterConfig[type]) {
    currentInverterType = type;
    currentInverterSettings = { ...inverterConfig[type], ...settings };
    inverterConfig[type] = currentInverterSettings;
    res.json({ type: currentInverterType, settings: currentInverterSettings });
    Object.entries(currentInverterSettings).forEach(([key, value]) => {
      publishToMQTT(`solar_assistant_DEYE/inverter/${key}`, value);
    });
  } else {
    res.status(400).json({ error: 'Invalid inverter type' });
  }
});

app.post('/api/inverter-types', (req, res) => {
  const { type, settings } = req.body;
  if (!inverterConfig[type]) {
    inverterConfig[type] = settings;
    res.status(201).json({ message: 'Inverter type added successfully', type, settings });
  } else {
    res.status(400).json({ error: 'Inverter type already exists' });
  }
});

app.put('/api/inverter-types/:type', (req, res) => {
  const { type } = req.params;
  const { settings } = req.body;
  if (inverterConfig[type]) {
    inverterConfig[type] = { ...inverterConfig[type], ...settings };
    res.json({ type, settings: inverterConfig[type] });
  } else {
    res.status(404).json({ error: 'Inverter type not found' });
  }
});

app.delete('/api/inverter-types/:type', (req, res) => {
  const { type } = req.params;
  if (inverterConfig[type]) {
    delete inverterConfig[type];
    res.sendStatus(204);
  } else {
    res.status(404).json({ error: 'Inverter type not found' });
  }
});

// Automation Rules
app.get('/api/automation-rules', (req, res) => {
  res.json(automationRules);
});

app.post('/api/automation-rules', (req, res) => {
  const newRule = {
    id: Date.now().toString(),
    name: req.body.name,
    conditions: req.body.conditions,
    actions: req.body.actions,
    days: req.body.days
  };
  automationRules.push(newRule);
  res.status(201).json(newRule);
});

app.get('/api/automation-rules/:id', (req, res) => {
  const rule = automationRules.find(r => r.id === req.params.id);
  if (rule) {
    res.json(rule);
  } else {
    res.status(404).json({ error: 'Rule not found' });
  }
});

app.put('/api/automation-rules/:id', (req, res) => {
  const { id } = req.params;
  const index = automationRules.findIndex(rule => rule.id === id);
  if (index !== -1) {
    automationRules[index] = { ...automationRules[index], ...req.body };
    res.json(automationRules[index]);
  } else {
    res.status(404).json({ error: 'Rule not found' });
  }
});

app.delete('/api/automation-rules/:id', (req, res) => {
  const { id } = req.params;
  automationRules = automationRules.filter(rule => rule.id !== id);
  res.sendStatus(204);
});

// Scheduled Settings
app.get('/api/scheduled-settings', (req, res) => {
  res.json(scheduledSettings);
});

app.post('/api/scheduled-settings', (req, res) => {
  const newSetting = {
    id: Date.now().toString(),
    key: req.body.key,
    value: req.body.value,
    day: req.body.day,
    hour: req.body.hour
  };
  scheduledSettings.push(newSetting);
  res.status(201).json(newSetting);
});

app.put('/api/scheduled-settings/:id', (req, res) => {
  const { id } = req.params;
  const index = scheduledSettings.findIndex(setting => setting.id === id);
  if (index !== -1) {
    scheduledSettings[index] = { ...scheduledSettings[index], ...req.body };
    res.json(scheduledSettings[index]);
  } else {
    res.status(404).json({ error: 'Scheduled setting not found' });
  }
});

app.delete('/api/scheduled-settings/:id', (req, res) => {
  const { id } = req.params;
  scheduledSettings = scheduledSettings.filter(setting => setting.id !== id);
  res.sendStatus(204);
});

// MQTT publishing route
app.post('/api/mqtt', (req, res) => {
  const { topic, message } = req.body;
  publishToMQTT(topic, message);
  res.sendStatus(200);
});


// Function to read the dashboard JSON
function readDashboard() {
  const data = fs.readFileSync(dashboardFilePath, 'utf8');
  return JSON.parse(data);
}

// Function to write back the updated JSON
function writeDashboard(data) {
  fs.writeFileSync(dashboardFilePath, JSON.stringify(data, null, 2));
}

// Endpoint to get min and max values for relevant gauges
app.get('/gauges', (req, res) => {
  const dashboard = readDashboard();
  const gauges = {};

  dashboard.panels.forEach(panel => {
      if (panel.fieldConfig && panel.fieldConfig.defaults) {
          const title = panel.title;
          const min = panel.fieldConfig.defaults.min;
          const max = panel.fieldConfig.defaults.max;

          gauges[title] = { min, max };
      }
  });

  res.json(gauges);
});


// Endpoint to update min and max values for specific gauges
app.post('/gauges/update', (req, res) => {
  const dashboard = readDashboard();
  const updates = req.body;

  dashboard.panels.forEach(panel => {
      if (panel.fieldConfig && panel.fieldConfig.defaults) {
          const title = panel.title;
          if (updates[title]) {
              const newMin = updates[title].min;
              const newMax = updates[title].max;

              // Only update if the value is explicitly set (not null or undefined)
              if (newMin !== undefined && newMin !== null) {
                  panel.fieldConfig.defaults.min = newMin;
              }

              if (newMax !== undefined && newMax !== null) {
                  panel.fieldConfig.defaults.max = newMax;
              }
          }
      }
  });

  // Write updated values to the file
  writeDashboard(dashboard);
  res.json({ message: 'Gauges updated successfully.' });
});


// Function to filter messages by category
function filterMessagesByCategory(category) {
  if (category === 'all') {
    return incomingMessages;
  }

  return incomingMessages.filter(message => {
    const topic = message.split(':')[0];
    const topicParts = topic.split('/');

    if (category.startsWith('inverter')) {
      const inverterNum = category.match(/\d+$/)[0];
      return topicParts[1] === `inverter_${inverterNum}`;
    }

    if (category.startsWith('battery')) {
      const batteryNum = category.match(/\d+$/)[0];
      return topicParts[1] === `battery_${batteryNum}`;
    }

    const categoryKeywords = {
      loadPower: ['load_power'],
      gridPower: ['grid_power'],
      pvPower: ['pv_power'],
      total: ['total'],
    };

    return categoryKeywords[category] ? topicParts.some(part => categoryKeywords[category].includes(part)) : false;
  });
}


// Helper functions
function applyScheduledSettings() {
  const now = new Date();
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];
  const hour = now.getHours();

  scheduledSettings.forEach(setting => {
    if (setting.day === day && setting.hour === hour) {
      publishToMQTT(`solar_assistant_DEYE/${setting.key}`, setting.value);
      broadcastMessage({
        type: 'realtimeUpdate',
        updateType: 'scheduledSettingApplied',
        key: setting.key,
        value: setting.value
      });
    }
  });
}

function applyAutomationRules() {
  const now = new Date();
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

  automationRules.forEach(rule => {
    if (rule.days.includes(day) && checkConditions(rule.conditions)) {
      rule.actions.forEach(action => {
        publishToMQTT(`solar_assistant_DEYE/${action.key}`, action.value);
      });
      broadcastMessage({
        type: 'realtimeUpdate',
        updateType: 'automationRuleTriggered',
        ruleName: rule.name,
        actions: rule.actions
      });
    }
  });
}

function checkConditions(conditions) {
  return conditions.every(condition => {
    const { deviceType, parameter, operator, value } = condition;
    
    if (currentSystemState[deviceType] && currentSystemState[deviceType][parameter] !== undefined) {
      return compareNumeric(currentSystemState[deviceType][parameter], operator, parseFloat(value));
    } else if (currentSystemState[parameter] !== undefined) {
      return compareNumeric(currentSystemState[parameter], operator, parseFloat(value));
    }
    
    console.warn(`Unknown parameter: ${deviceType}.${parameter}`);
    return false;
  });
}

function compareNumeric(actual, operator, expected) {
  switch (operator) {
    case 'equals':
      return Math.abs(actual - expected) < 0.001;
    case 'notEquals':
      return Math.abs(actual - expected) >= 0.001;
    case 'greaterThan':
      return actual > expected;
    case 'lessThan':
      return actual < expected;
    case 'greaterThanOrEqual':
      return actual >= expected;
    case 'lessThanOrEqual':
      return actual <= expected;
    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}

function compareTime(actualDate, operator, expectedTime) {
  const [expectedHours, expectedMinutes] = expectedTime.split(':').map(Number);
  const actualMinutes = actualDate.getHours() * 60 + actualDate.getMinutes();
  const expectedTotalMinutes = expectedHours * 60 + expectedMinutes;

  switch (operator) {
    case 'equals':
      return actualMinutes === expectedTotalMinutes;
    case 'notEquals':
      return actualMinutes !== expectedTotalMinutes;
    case 'after':
      return actualMinutes > expectedTotalMinutes;
    case 'before':
      return actualMinutes < expectedTotalMinutes;
    default:
      console.warn(`Unknown operator for time comparison: ${operator}`);
      return false;
  }
}

function compareDay(actualDay, operator, expectedDay) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const expectedDayIndex = days.indexOf(expectedDay.toLowerCase());

  if (expectedDayIndex === -1) {
    console.warn(`Invalid day: ${expectedDay}`);
    return false;
  }

  switch (operator) {
    case 'equals':
      return actualDay === expectedDayIndex;
    case 'notEquals':
      return actualDay !== expectedDayIndex;
    default:
      console.warn(`Unknown operator for day comparison: ${operator}`);
      return false;
  }
}



//socket server setup

//socket data
const getRealTimeData = async () => {
  const loadPowerData = await queryInfluxDB(
    'solar_assistant_DEYE/total/load_energy/state'
  )
  const pvPowerData = await queryInfluxDB(
    'solar_assistant_DEYE/total/pv_energy/state'
  )
  const batteryStateOfChargeData = await queryInfluxDB(
    'solar_assistant_DEYE/total/battery_energy_in/state'
  )
  const batteryPowerData = await queryInfluxDB(
    'solar_assistant_DEYE/total/battery_energy_out/state'
  )
  const gridPowerData = await queryInfluxDB(
    'solar_assistant_DEYE/total/grid_energy_in/state'
  )
  const gridVoltageData = await queryInfluxDB(
    'solar_assistant_DEYE/total/grid_energy_out/state'
  )

  const data = {
    load: calculateDailyDifferenceForSockets(loadPowerData),
    pv: calculateDailyDifferenceForSockets(pvPowerData),
    gridIn: calculateDailyDifferenceForSockets(gridPowerData),
    gridOut: calculateDailyDifferenceForSockets(gridVoltageData),
    batteryCharged: calculateDailyDifferenceForSockets(
      batteryStateOfChargeData
    ),
    batteryDischarged: calculateDailyDifferenceForSockets(batteryPowerData),
  }

  return data
}
//send  on connection

const server = app.listen(port, '0.0.0.0', async () => {
  console.log(`Server is running on http://0.0.0.0:${port}`)
  connectToMqtt()
  connectDatabase()
    .then(() => console.log('Database connected'))
    .catch((err) => console.log({ err }))
})

const wss = new WebSocket.Server({ server })

wss.on('connection', (ws) => {
  console.log('Client connected')
  mqttClient.on('message', async () => {
    const { load, pv, gridIn, gridOut, batteryCharged, batteryDischarged } =
      await getRealTimeData()
    const topics = await prisma.topic.findMany()
    const port = options.mqtt_host
    const date = new Date()
    const isForServer = true
    topics.forEach((t) => {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          topics.forEach((t) => {
            client.send(
              JSON.stringify({
                date,
                userId: t.userId,
                pv,
                load,
                gridIn,
                gridOut,
                batteryCharged,
                batteryDischarged,
                port,
                isForServer,
              })
            )
          })
        }
      })
    })
  })
  ws.on('error', (error) => {
    console.error('WebSocket error:', error)
  })
  ws.on('close', () => console.log('Client disconnected'))
})

function broadcastMessage(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message))
    }
  })
}

// Scheduled tasks
setInterval(applyScheduledSettings, 60000) // Run every minute
setInterval(applyAutomationRules, 60000) // Run every minute

// carbon intensity



const locations = [
  { value: 'MU', label: 'Mauritius' },
  { value: 'KY', label: 'Cayman Islands' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'FR', label: 'France' },
  { value: 'DE', label: 'Germany' },
  { value: 'ES', label: 'Spain' },
  { value: 'IT', label: 'Italy' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'BE', label: 'Belgium' },
  { value: 'AT', label: 'Austria' },
  { value: 'CH', label: 'Switzerland' },
  { value: 'DK', label: 'Denmark' },
  { value: 'SE', label: 'Sweden' },
  { value: 'NO', label: 'Norway' },
  { value: 'FI', label: 'Finland' },
  { value: 'PT', label: 'Portugal' },
  { value: 'IE', label: 'Ireland' },
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'JP', label: 'Japan' },
  { value: 'SG', label: 'Singapore' },
  { value: 'AE', label: 'United Arab Emirates' },
];


// Function to read the saved location from a file
function getSavedLocation() {
  try {
    const data = fs.readFileSync('saved_location.txt', 'utf8');
    return data.trim();
  } catch (err) {
    console.error('Error reading saved location:', err);
    return 'MU'; // Default to Mauritius if there's an error
  }
}

// Function to save the location to a file
function saveLocation(location) {
  try {
    fs.writeFileSync('saved_location.txt', location);
  } catch (err) {
    console.error('Error saving location:', err);
  }
}

// Initialize the saved location file with Mauritius if it doesn't exist
if (!fs.existsSync('saved_location.txt')) {
  saveLocation('MU');
}

async function getCarbonIntensity(location) {
  const url = `https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${location}`;
  const headers = {
    'Authorization': `Bearer ${process.env.ELECTRICITY_MAPS_API_KEY}`
  };
  try {
    const response = await axios.get(url, { headers });
    return response.data.carbonIntensity;
  } catch (error) {
    console.error('Error fetching carbon intensity:', error.message);
    return 0;
  }
}

async function getCarbonIntensityHistory(location, start, end) {
  const url = `https://api.electricitymap.org/v3/carbon-intensity/history?zone=${location}&start=${start}&end=${end}`;
  const headers = {
    'Authorization': `Bearer ${process.env.ELECTRICITY_MAPS_API_KEY}`
  };
  try {
    const response = await axios.get(url, { headers });
    return response.data.history;
  } catch (error) {
    console.error('Error fetching carbon intensity history:', error.message);
    return [];
  }
}

async function getCurrentData(topic) {
  const query = `
    SELECT last("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}'
    ORDER BY time DESC
    LIMIT 1
  `;
  try {
    const result = await influx.query(query);
    return result[0] ? result[0].value : null;
  } catch (error) {
    console.error(`Error querying InfluxDB for topic ${topic}:`, error);
    return null;
  }
}

async function getHistoricalPowerData(topic, start, end) {
  const query = `
    SELECT mean("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}' AND time >= '${start}' AND time <= '${end}'
    GROUP BY time(1h)
  `;
  try {
    const result = await influx.query(query);
    return result;
  } catch (error) {
    console.error(`Error querying InfluxDB for topic ${topic}:`, error);
    return [];
  }
}

function calculateCO2(power, carbonIntensity) {
  return (power * carbonIntensity) / 1000; // Convert to kg
}

function calculateDailyEmissions(powerData, intensityData) {
  const emissions = {};
  powerData.forEach(power => {
    const date = moment(power.time).format('YYYY-MM-DD');
    const intensity = intensityData.find(i => moment(i.datetime).format('YYYY-MM-DD') === date);
    if (intensity) {
      if (!emissions[date]) {
        emissions[date] = { grid: 0, solar: 0, battery: 0 };
      }
      emissions[date].grid += (power.grid * intensity.carbonIntensity) / 1000 / 24;
      emissions[date].solar += (power.solar * intensity.carbonIntensity) / 1000 / 24;
      emissions[date].battery += (power.battery * intensity.carbonIntensity) / 1000 / 24;
    }
  });
  return emissions;
}

app.get('/carbon-intensity', async (req, res) => {
  const location = getSavedLocation();
  try {
    const data = await fetchDashboardData(location);
    res.render('dashboard', { 
      ingress_path: process.env.INGRESS_PATH || '', 
      locations, 
      selectedLocation: location, 
      currentData: data 
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('An error occurred');
  }
});


app.post('/api/update-location', (req, res) => {
  const { location } = req.body;
  saveLocation(location);
  res.json({ success: true });
});

app.get('/api/dashboard-data', async (req, res) => {
  const location = getSavedLocation();
  try {
    const data = await fetchDashboardData(location);
    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});


app.get('/api/historical-data', async (req, res) => {
  const location = getSavedLocation();
  const { period } = req.query;
  let start, end;

  switch (period) {
    case 'week':
      start = moment().subtract(1, 'week').startOf('day').toISOString();
      end = moment().endOf('day').toISOString();
      break;
    case 'month':
      start = moment().subtract(1, 'month').startOf('day').toISOString();
      end = moment().endOf('day').toISOString();
      break;
    case 'quarter':
      start = moment().subtract(3, 'months').startOf('day').toISOString();
      end = moment().endOf('day').toISOString();
      break;
    default:
      return res.status(400).json({ error: 'Invalid period' });
  }

  try {
    const intensityData = await getCarbonIntensityHistory(location, start, end);
    const gridPower = await getHistoricalPowerData('solar_assistant_DEYE/total/grid_energy_in/state', start, end);
    const solarPower = await getHistoricalPowerData('solar_assistant_DEYE/total/pv_energy/state', start, end);
    const batteryPower = await getHistoricalPowerData('solar_assistant_DEYE/total/battery_energy_in/state', start, end);

    const powerData = gridPower.map((grid, index) => ({
      time: grid.time,
      grid: grid.value,
      solar: solarPower[index].value,
      battery: batteryPower[index].value
    }));

    const emissions = calculateDailyEmissions(powerData, intensityData);

    // Fill in missing dates with zero values
    const filledEmissions = {};
    let currentDate = moment(start);
    const endDate = moment(end);
    while (currentDate <= endDate) {
      const dateString = currentDate.format('YYYY-MM-DD');
      filledEmissions[dateString] = emissions[dateString] || { grid: 0, solar: 0, battery: 0 };
      currentDate.add(1, 'day');
    }

    const totalEmissions = Object.values(filledEmissions).reduce(
      (acc, day) => {
        acc.grid += day.grid;
        acc.solar += day.solar;
        acc.battery += day.battery;
        return acc;
      },
      { grid: 0, solar: 0, battery: 0 }
    );

    res.json({ emissions: filledEmissions, totalEmissions });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

async function fetchDashboardData(location) {
  const carbonIntensity = await getCarbonIntensity(location);
  const gridPower = await getCurrentData('solar_assistant_DEYE/total/grid_energy_in/state');
  const solarPower = await getCurrentData('solar_assistant_DEYE/total/pv_energy/state');
  const batteryPower = await getCurrentData('solar_assistant_DEYE/total/battery_energy_in/state');
  const gridVoltage = await getCurrentData('solar_assistant_DEYE/total/grid_voltage/state');

  const isGridActive = Math.abs(gridVoltage - 230) < 20;
  const gridEmissions = isGridActive ? calculateCO2(gridPower, carbonIntensity) : 0;
  const solarAvoided = calculateCO2(solarPower, carbonIntensity);
  const batteryAvoided = calculateCO2(batteryPower, carbonIntensity);

  return {
    timestamp: new Date().toISOString(),
    gridPower,
    solarPower,
    batteryPower,
    gridVoltage,
    gridEmissions,
    solarAvoided,
    batteryAvoided
  };
}


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
