#!/usr/bin/with-contenv bashio

# Set up environment variables
export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789

# Get config
export MQTT_HOST=$(bashio::config 'mqtt_host')
export MQTT_PORT=$(bashio::config 'mqtt_port')
export MQTT_USERNAME=$(bashio::config 'mqtt_username')
export MQTT_PASSWORD=$(bashio::config 'mqtt_password')
export MQTT_TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix')
export BATTERY_NUMBER=$(bashio::config 'battery_number')
export INVERTER_NUMBER=$(bashio::config 'inverter_number')
export CLIENT_USERNAME=$(bashio::config 'client_username')
export CLIENT_PASSWORD=$(bashio::config 'client_password')

# Update Grafana configuration
sed -i "s|^root_url = .*|root_url = ${INGRESS_PATH}|g" /etc/grafana/grafana.ini

# Start Grafana
grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana &
influxd &

# Wait for InfluxDB to start
sleep 10

# Create the InfluxDB database
influx -execute "CREATE DATABASE home_assistant"

# Create a user with a password and grant privileges
influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'"
influx -execute "GRANT ALL ON home_assistant TO admin"

# Run the Node.js application
cd /usr/src/app

# Run Prisma to generate client code
npx prisma generate

# Start the Node.js application
exec node --max-old-space-size=64 server.js