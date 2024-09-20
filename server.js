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
    updateSystemState(topic, message)
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

// Fetch current value from InfluxDB
async function getCurrentValue(topic) {
  const query = `
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${topic}'
        AND time >= now() - 2d
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

function calculateLastTwoDaysDifference(data) {
  const dataLength = data.length;

  if (dataLength < 2) {
    // If there's not enough data, return 0 for both days
    return [
      {
        time: new Date(),
        difference: 0,
      },
    ];
  }

  const latestDay = data[dataLength - 1];
  const previousDay = data[dataLength - 2];

  let difference;

  if (!previousDay?.value || !latestDay?.value) {
    // If no data for the previous or current day, return 0
    difference = 0;
  } else if (latestDay.value <= previousDay.value) {
    // If current day's data is less than or equal to previous day's data
    difference = latestDay.value;
  } else {
    // If current day's data is greater, calculate the difference
    difference = latestDay.value - previousDay.value;
  }

  return [
    {
      time: latestDay.time || new Date(),
      difference: parseFloat(difference.toFixed(1)),
    },
  ];

}


// carbon intensity



// Route handlers

app.get('/settings', (req, res) => {
  res.render('settings', { ingress_path: process.env.INGRESS_PATH || '' })
})

app.get('/carbon-intensity', (req, res) => {
  res.render('carbon-intensity', { ingress_path: process.env.INGRESS_PATH || '' })
})
app.get('/configuration', (req, res) => {
  res.render('configuration', { ingress_path: process.env.INGRESS_PATH || '' })
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

app.get('/dashboard', async (req, res) => {
  try {
    const loadPowerData = await getCurrentValue(
      'solar_assistant_DEYE/total/load_energy/state'
    );
    const pvPowerData = await getCurrentValue(
      'solar_assistant_DEYE/total/pv_energy/state'
    );
    const batteryPowerInData = await getCurrentValue(
      'solar_assistant_DEYE/total/battery_energy_in/state'
    );
    const batteryPowerOutData = await getCurrentValue(
      'solar_assistant_DEYE/total/battery_energy_out/state'
    );
    const gridPowerInData = await getCurrentValue(
      'solar_assistant_DEYE/total/grid_energy_in/state'
    );
    const gridPowerOutData = await getCurrentValue(
      'solar_assistant_DEYE/total/grid_energy_out/state'
    );

    const loadPowerDataDaily = calculateLastTwoDaysDifference(loadPowerData || []);
    const pvPowerDataDaily = calculateLastTwoDaysDifference(pvPowerData || []);
    const batteryPowerInDataDaily = calculateLastTwoDaysDifference(batteryPowerInData || []);
    const batteryPowerOutDataDaily = calculateLastTwoDaysDifference(batteryPowerOutData || []);
    const gridPowerInDataDaily = calculateLastTwoDaysDifference(gridPowerInData || []);
    const gridPowerOutDataDaily = calculateLastTwoDaysDifference(gridPowerOutData || []);

    const data = {
      loadDifference: loadPowerDataDaily[0].difference || 0,
      solarDifference: pvPowerDataDaily[0].difference || 0,
      batteryChargeDifference: batteryPowerInDataDaily[0].difference || 0,
      batteryDischargeDifference: batteryPowerOutDataDaily[0].difference || 0,
      gridInDifference: gridPowerInDataDaily[0].difference || 0,
      gridOutDifference: gridPowerOutDataDaily[0].difference || 0,
    };

    res.render('dashboard', {
      data,
      ingress_path: process.env.INGRESS_PATH || '',
    });
  } catch (error) {
    console.error('Error fetching data for dashboard:', error);
    res.status(500).json({ error: 'Error fetching data for dashboard' });
  }
});


app.get('/api/energy', async (req, res) => {
  try {
    const loadPowerData = await getCurrentValue(
      'solar_assistant_DEYE/total/load_energy/state'
    )
    const pvPowerData = await getCurrentValue(
      'solar_assistant_DEYE/total/pv_energy/state'
    )
    const batteryPowerInData = await getCurrentValue(
      'solar_assistant_DEYE/total/battery_energy_in/state'
    )
    const batteryPowerOutData = await getCurrentValue(
      'solar_assistant_DEYE/total/battery_energy_out/state'
    )
    const gridPowerInData = await getCurrentValue(
      'solar_assistant_DEYE/total/grid_energy_in/state'
    )
    const gridPowerOutData = await getCurrentValue(
      'solar_assistant_DEYE/total/grid_energy_out/state'
    )

    const loadPowerDataDaily = calculateLastTwoDaysDifference(loadPowerData)
    const pvPowerDataDaily = calculateLastTwoDaysDifference(pvPowerData)
    const batteryPowerInDataDaily =
      calculateLastTwoDaysDifference(batteryPowerInData)
    const batteryPowerOutDataDaily =
      calculateLastTwoDaysDifference(batteryPowerOutData)
    const gridPowerInDataDaily = calculateLastTwoDaysDifference(gridPowerInData)
    const gridPowerOutDataDaily =
      calculateLastTwoDaysDifference(gridPowerOutData)

    const data = {
      loadDifference: loadPowerDataDaily[0].difference,
      solarDifference: pvPowerDataDaily[0].difference,
      batteryChargeDifference: batteryPowerInDataDaily[0].difference,
      batteryDischargeDifference: batteryPowerOutDataDaily[0].difference,
      gridInDifference: gridPowerInDataDaily[0].difference,
      gridOutDifference: gridPowerOutDataDaily[0].difference,
    }

    res.json(data)
  } catch (error) {
    console.error('Error fetching energy data:', error)
    res.status(500).json({ error: 'Error fetching energy data' })
  }
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


// carbon intensity

let settings = {};
const settingsPath = path.join(__dirname, 'settings.json');

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    console.log('No settings file found or invalid JSON. Using default settings.');
    settings = { apiKey: '' };
  }
}

function saveSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

loadSettings();

// Electricity Maps API configuration
const ELECTRICITY_MAPS_API_URL = 'https://api.electricitymap.org/v3/carbon-intensity/latest';

// Sample countries (you can expand this list)
const countries = [
  { name: 'United Kingdom', code: 'GB', lat: 51.5074, lon: -0.1278 },
  { name: 'France', code: 'FR', lat: 46.2276, lon: 2.2137 },
  { name: 'Germany', code: 'DE', lat: 51.1657, lon: 10.4515 },
  { name: 'Spain', code: 'ES', lat: 40.4637, lon: -3.7492 },
  { name: 'Italy', code: 'IT', lat: 41.8719, lon: 12.5674 },
  { name: 'Sweden', code: 'SE', lat: 60.1282, lon: 18.6435 },
  { name: 'Norway', code: 'NO', lat: 60.4720, lon: 8.4689 },
  { name: 'Denmark', code: 'DK', lat: 56.2639, lon: 9.5018 },
  { name: 'Netherlands', code: 'NL', lat: 52.1326, lon: 5.2913 },
  { name: 'Belgium', code: 'BE', lat: 50.8503, lon: 4.3517 },
  { name: 'Switzerland', code: 'CH', lat: 46.8182, lon: 8.2275 },
  { name: 'Austria', code: 'AT', lat: 47.5162, lon: 14.5501 },
  { name: 'Poland', code: 'PL', lat: 51.9194, lon: 19.1451 },
  { name: 'Portugal', code: 'PT', lat: 39.3999, lon: -8.2245 },
  { name: 'Finland', code: 'FI', lat: 61.9241, lon: 25.7482 },
  { name: 'Ireland', code: 'IE', lat: 53.4129, lon: -8.2439 },
];

app.get('/api/carbon-intensity', async (req, res) => {
  if (!settings.apiKey) {
    return res.status(400).json({ error: 'API key not configured. Please set it in the settings.' });
  }

  try {
    const results = await Promise.all(countries.map(async (country) => {
      const response = await axios.get(ELECTRICITY_MAPS_API_URL, {
        params: {
          lat: country.lat,
          lon: country.lon,
        },
        headers: {
          'auth-token': settings.apiKey,
        },
      });
      return {
        ...country,
        carbonIntensity: response.data.carbonIntensity,
      };
    }));

    res.json(results);
  } catch (error) {
    console.error('Error fetching carbon intensity:', error);
    res.status(500).json({ error: 'Unable to fetch carbon intensity data' });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({ apiKey: settings.apiKey ? 'API key is set' : '' });
});

app.post('/api/settings', (req, res) => {
  const { apiKey } = req.body;
  if (apiKey) {
    settings.apiKey = apiKey;
    saveSettings();
    res.json({ message: 'API key updated successfully' });
  } else {
    res.status(400).json({ error: 'Invalid API key' });
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
