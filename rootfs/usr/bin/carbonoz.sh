#!/usr/bin/with-contenv bashio
# Environment and config setup
export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=128"
export MQTT_HOST=$(bashio::config 'mqtt_host')
export MQTT_USERNAME=$(bashio::config 'mqtt_username')
export MQTT_PASSWORD=$(bashio::config 'mqtt_password')
export MQTT_TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix')
export BATTERY_NUMBER=$(bashio::config 'battery_number')
export INVERTER_NUMBER=$(bashio::config 'inverter_number')
export CLIENT_USERNAME=$(bashio::config 'client_username')
export CLIENT_PASSWORD=$(bashio::config 'client_password')

# Set directory permissions
chown -R nobody:nobody /data/influxdb
chmod -R 755 /data/influxdb

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

# Start Node.js application
cd /usr/src/app
exec node --max-old-space-size=128 --gc-interval=100 --optimize-for-size server.js
