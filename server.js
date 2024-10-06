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
const cookieParser = require('cookie-parser');
const axios = require('axios');

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


// Add cookie parser middleware
app.use(cookieParser());

// Read configuration from Home Assistant add-on options
const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))


// Extract inverter and battery numbers from options
const inverterNumber = options.inverter_number || 1;
const batteryNumber = options.battery_number || 1;
// MQTT topic prefix
const mqttTopicPrefix = options.mqtt_topic_prefix || '${mqttTopicPrefix}';

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
  `;
  try {
      return await influx.query(query);
  } catch (error) {
      console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
      throw error;
  }
}

// Route handlers
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
    const selectedZone = req.cookies[COOKIE_NAME] || null;
    let carbonIntensityData = [];
    
    if (selectedZone) {
      carbonIntensityData = await fetchCarbonIntensityHistory(selectedZone);
    }
    
    const [loadPowerData, pvPowerData, batteryStateOfChargeData, 
           batteryPowerData, gridPowerData, gridVoltageData] = await Promise.all([
      queryInfluxDB('solar_assistant_DEYE/total/load_energy/state'),
      queryInfluxDB('solar_assistant_DEYE/total/pv_energy/state'),
      queryInfluxDB('solar_assistant_DEYE/total/battery_energy_in/state'),
      queryInfluxDB('solar_assistant_DEYE/total/battery_energy_out/state'),
      queryInfluxDB('solar_assistant_DEYE/total/grid_energy_in/state'),
      queryInfluxDB('solar_assistant_DEYE/total/grid_energy_out/state')
    ]);

    const data = {
      loadPowerData,
      pvPowerData,
      batteryStateOfChargeData,
      batteryPowerData,
      gridPowerData,
      gridVoltageData,
      carbonIntensityData,
      selectedZone
    };

    res.render('analytics', { data, ingress_path: process.env.INGRESS_PATH || '' });
  } catch (error) {
    console.error('Error fetching analytics data:', error);
    res.status(500).json({ error: 'Error fetching analytics data' });
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

const dashboardFilePath = path.join(__dirname, 'grafana', 'provisioning', 'dashboards', 'solar_power_dashboard.json');

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

// Endpoint to update min and max values for specific gauges and adjust thresholds
app.post('/gauges/update', (req, res) => {
  const dashboard = readDashboard();
  const updates = req.body;

  dashboard.panels.forEach(panel => {
      if (panel.fieldConfig && panel.fieldConfig.defaults) {
          const title = panel.title;
          if (updates[title]) {
              const newMin = updates[title].min;
              const newMax = updates[title].max;

              // Update min and max values if they are provided
              if (newMin !== undefined && newMin !== null) {
                  panel.fieldConfig.defaults.min = newMin;
              }

              if (newMax !== undefined && newMax !== null) {
                  panel.fieldConfig.defaults.max = newMax;

                  // Automatically update thresholds based on the new max value
                  const thresholds = panel.fieldConfig.defaults.thresholds.steps;
                  if (thresholds) {
                      // If it's "Load Power" or "Grid Power", apply the special rules
                      if (title === 'Load Power' || title === 'Grid Power') {
                          thresholds[1].value = newMax * 0.25;  // Green at 25%
                          thresholds[2].value = newMax * 0.50;  // Yellow at 50%
                          thresholds[3].value = newMax * 0.75;  // Orange at 75%
                          thresholds[4] = { color: "red", value: newMax };  // Red at max value
                      } else {
                          // For other gauges, use the default rule
                          thresholds[1].value = newMax * 0.25;  // Red at 25%
                          thresholds[2].value = newMax * 0.50;  // Orange at 50%
                          thresholds[3].value = newMax * 0.75;  // Yellow at 75%
                          thresholds[4] = { color: "green", value: newMax };  // Green at max value
                      }
                  }
              }
          }
      }
  });

  // Write updated values to the file
  writeDashboard(dashboard);
  res.json({ message: 'Gauges and thresholds updated successfully.' });
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

//socket data
const getRealTimeData = async () => {
  const loadPowerData = await queryInfluxDB(`${mqttTopicPrefix}/total/load_energy/state`);
  const pvPowerData = await queryInfluxDB(`${mqttTopicPrefix}/total/pv_energy/state`);
  const batteryStateOfChargeData = await queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_in/state`);
  const batteryPowerData = await queryInfluxDB(`${mqttTopicPrefix}/total/battery_energy_out/state`);
  const gridPowerData = await queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_in/state`);
  const gridVoltageData = await queryInfluxDB(`${mqttTopicPrefix}/total/grid_energy_out/state`);

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


// carbon intensity


app.get('/settings', async (req, res) => {
  const zones = await getZones();
  const selectedZone = req.cookies[COOKIE_NAME] || '';
  res.render('settings', { zones, selectedZone, ingress_path: process.env.INGRESS_PATH || '' });
});

app.get('/results', async (req, res) => {
    let selectedZone = req.query.zone || req.cookies[COOKIE_NAME] || null;
    const zones = await getZones();
  
    // If a new zone is selected, update the cookie
    if (req.query.zone && req.query.zone !== req.cookies[COOKIE_NAME]) {
      res.cookie(COOKIE_NAME, req.query.zone, COOKIE_OPTIONS);
      selectedZone = req.query.zone;
    }
  
    try {
      let historyData = [], gridEnergyIn = [], pvEnergy = [], gridVoltage = [];
      let error = null;
  
      if (selectedZone) {
        try {
          [historyData, gridEnergyIn, pvEnergy, gridVoltage] = await Promise.all([
            fetchCarbonIntensityHistory(selectedZone),
            queryInfluxData('${mqttTopicPrefix}/total/grid_energy_in/state', '365d'),
            queryInfluxData('${mqttTopicPrefix}/total/pv_energy/state', '365d'),
            queryInfluxData('${mqttTopicPrefix}/total/grid_voltage/state', '365d')
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
  
      res.render('results', {
        selectedZone,
        zones,
        periods,
        todayData,
        error,
        unavoidableEmissions: todayData.unavoidableEmissions,
        avoidedEmissions: todayData.avoidedEmissions,
        selfSufficiencyScore: todayData.selfSufficiencyScore,
        ingress_path: process.env.INGRESS_PATH || '' 
      });
    } catch (error) {
      console.error('Error processing data:', error);
      res.render('results', {
        selectedZone,
        zones,
        error: 'Error processing data',
        ingress_path: process.env.INGRESS_PATH || '' 
      });
    }
  });

// Cache for carbon intensity data
const carbonIntensityCache = new Map();
const CACHE_DURATION = 3600000; // 1 hour in milliseconds
const COOKIE_NAME = 'selectedZone';
const COOKIE_OPTIONS = {
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production'
};


// Fetch zones without caching
async function getZones() {
    try {
      const response = await axios.get('https://api.electricitymap.org/v3/zones', { timeout: 10000 });
      const data = response.data;
  
      return Object.entries(data)
        .map(([key, value]) => ({
          code: key,
          zoneName: value.zoneName || key
        }))
        .sort((a, b) => a.zoneName.localeCompare(b.zoneName));
    } catch (error) {
      console.error('Error fetching zones data:', error);
      return [];
    }
  }

app.get('/clear-zone', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.redirect(`${process.env.INGRESS_PATH || ''}/results`);
});

async function queryInfluxData(topic, duration = '365d') {
    const query = `
      SELECT last("value") AS "value"
      FROM "state"
      WHERE "topic" = '${topic}'
      AND time >= now() - ${duration}
      GROUP BY time(1d)
      tz('${currentTimezone}')
    `;
    try {
      return await influx.query(query);
    } catch (error) {
      console.error(`Error querying InfluxDB for topic ${topic}:`, error.toString());
      throw error;
    }
  }

  async function fetchCarbonIntensityHistory(selectedZone) {
    if (!selectedZone) return [];
  
    const cacheKey = `${selectedZone}-${moment().format('YYYY-MM-DD')}`;
    if (carbonIntensityCache.has(cacheKey)) {
      const cachedData = carbonIntensityCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < CACHE_DURATION) {
        return cachedData.data;
      }
    }
  
    const historyData = [];
    const today = moment();
    const oneYearAgo = moment().subtract(1, 'year');
    const batchSize = 7;
  
    for (let m = moment(oneYearAgo); m.isBefore(today); m.add(batchSize, 'days')) {
      const batchPromises = [];
      for (let i = 0; i < batchSize && m.clone().add(i, 'days').isBefore(today); i++) {
        const date = m.clone().add(i, 'days').format('YYYY-MM-DD');
        batchPromises.push(
          axios.get(`https://api.electricitymap.org/v3/carbon-intensity/history?zone=${selectedZone}&datetime=${date}`, {
            headers: { 'Authorization': 'Bearer x3iKtJLhs6xDD' }
          }).then(response => response.data)
        );
      }
  
      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach((data, index) => {
        if (data.history && data.history.length > 0) {
          historyData.push({
            date: m.clone().add(index, 'days').format('YYYY-MM-DD'),
            carbonIntensity: data.history[0].carbonIntensity
          });
        }
      });
    }
  
    carbonIntensityCache.set(cacheKey, {
      data: historyData,
      timestamp: Date.now()
    });
  
    return historyData;
  }

  function calculateEmissionsForPeriod(historyData, gridEnergyIn, pvEnergy, gridVoltage) {
    return historyData.map((dayData, index) => {
      const carbonIntensity = dayData.carbonIntensity;
      const currentGridVoltage = gridVoltage[index]?.value || 0;
      const isGridActive = Math.abs(currentGridVoltage) > 20;
      const gridEnergy = gridEnergyIn[index]?.value || 0;
      const solarEnergy = pvEnergy[index]?.value || 0;
  
      let unavoidableEmissions = 0;
      let avoidedEmissions = 0;
  
      if (isGridActive) {
        unavoidableEmissions = gridEnergy * carbonIntensity / 1000;
        avoidedEmissions = solarEnergy * carbonIntensity / 1000;
      }
  
      const totalEnergy = gridEnergy + solarEnergy;
      const selfSufficiencyScore = totalEnergy > 0 ? (solarEnergy / totalEnergy) * 100 : 0;
  
      return {
        date: dayData.date,
        carbonIntensity: carbonIntensity,
        gridVoltage: currentGridVoltage,
        unavoidableEmissions: unavoidableEmissions,
        avoidedEmissions: avoidedEmissions,
        selfSufficiencyScore: selfSufficiencyScore
      };
    });
  }

  app.get('/api/grid-voltage', async (req, res) => {
    try {
      const result = await influx.query(`
        SELECT last("value") AS "value"
        FROM "state"
        WHERE "topic" = '${mqttTopicPrefix}/total/grid_voltage/state'
      `);
      res.json({ voltage: result[0]?.value || 0 });
    } catch (error) {
      console.error('Error fetching grid voltage:', error);
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
