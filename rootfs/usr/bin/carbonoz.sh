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

# Check if InfluxDB data directories exist
if [ ! -d "/data/influxdb/meta" ] || [ ! -d "/data/influxdb/data" ] || [ ! -d "/data/influxdb/wal" ]; then
  # Create required directories
  mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal
  chown -R nobody:nobody /data/influxdb
fi

# Start InfluxDB with proper configuration
influxd -config /etc/influxdb/influxdb.conf &

# Wait for InfluxDB to start
bashio::log.info "Waiting for InfluxDB to start..."
until curl -s http://localhost:8086/ping > /dev/null 2>&1; do
  sleep 1
done
bashio::log.info "InfluxDB started successfully"

# Check if database exists, create it if not
DB_EXISTS=$(influx -execute "SHOW DATABASES" | grep -c "home_assistant")
if [ "$DB_EXISTS" -eq "0" ]; then
  # Create the InfluxDB database
  influx -execute "CREATE DATABASE home_assistant"
  # Create a user with a password and grant privileges
  influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'"
  influx -execute "GRANT ALL ON home_assistant TO admin"
  bashio::log.info "InfluxDB database and user created"
fi

# Run the Node.js application
cd /usr/src/app

# Start the Node.js application with increased heap size
exec node --max-old-space-size=256 server.js
