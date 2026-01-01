const mqtt = require('mqtt')
const fs = require('fs')

// Read configuration from options.json
let options
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
} catch (error) {
  options = JSON.parse(fs.readFileSync('./options.json', 'utf8'))
}

// MQTT configuration
const mqttConfig = {
  host: options.mqtt_host,
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password
}

const inverterNumber = options.inverter_number
const mqttTopicPrefix = options.mqtt_topic_prefix

// Connect to MQTT
const mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
  username: mqttConfig.username,
  password: mqttConfig.password
})

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT broker')
  stopBatteryChargingFromGrid()
})

mqttClient.on('error', (err) => {
  console.error('❌ MQTT error:', err.message)
  process.exit(1)
})

function stopBatteryChargingFromGrid() {
  console.log('🔋 Stopping battery charging from grid...')
  
  for (let i = 1; i <= inverterNumber; i++) {
    const inverterId = `inverter_${i}`
    
    // Try both legacy and new inverter commands for maximum compatibility
    
    // Legacy inverter: Disable grid charge
    const legacyTopic = `${mqttTopicPrefix}/${inverterId}/grid_charge/set`
    mqttClient.publish(legacyTopic, 'Disabled', { qos: 1 })
    console.log(`📤 Sent: ${legacyTopic} = Disabled`)
    
    // New inverter: Set charger source priority to Solar first
    const newTopic = `${mqttTopicPrefix}/${inverterId}/charger_source_priority/set`
    mqttClient.publish(newTopic, 'Solar first', { qos: 1 })
    console.log(`📤 Sent: ${newTopic} = Solar first`)
    
    // Legacy inverter: Set energy pattern to Battery first
    const energyTopic = `${mqttTopicPrefix}/${inverterId}/energy_pattern/set`
    mqttClient.publish(energyTopic, 'Battery first', { qos: 1 })
    console.log(`📤 Sent: ${energyTopic} = Battery first`)
    
    // New inverter: Set output source priority to Solar/Battery/Utility
    const outputTopic = `${mqttTopicPrefix}/${inverterId}/output_source_priority/set`
    mqttClient.publish(outputTopic, 'Solar/Battery/Utility', { qos: 1 })
    console.log(`📤 Sent: ${outputTopic} = Solar/Battery/Utility`)
  }
  
  console.log('✅ Commands sent to stop grid charging')
  
  // Close connection after 2 seconds
  setTimeout(() => {
    mqttClient.end()
    console.log('🔌 Disconnected from MQTT')
    process.exit(0)
  }, 2000)
}