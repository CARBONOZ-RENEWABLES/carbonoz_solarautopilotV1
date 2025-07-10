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

bashio::log.info "Starting Carbonoz SolarAutopilot services..."

# Ensure data directories exist with correct permissions
bashio::log.info "Setting up data directories..."
mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal
mkdir -p /data/grafana/data /data/grafana/logs /data/grafana/plugins
chown -R nobody:nobody /data/influxdb
chown -R grafana:grafana /data/grafana

# Start InfluxDB first
bashio::log.info "Starting InfluxDB..."
influxd -config /etc/influxdb/influxdb.conf &
INFLUXDB_PID=$!

# Wait for InfluxDB to be ready
bashio::log.info "Waiting for InfluxDB to be ready..."
RETRY_COUNT=0
MAX_RETRIES=30
until curl -s http://localhost:8086/ping > /dev/null 2>&1; do
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    bashio::log.error "InfluxDB failed to start within timeout"
    exit 1
  fi
done
bashio::log.info "InfluxDB is ready"

# Initialize InfluxDB database if needed
bashio::log.info "Checking InfluxDB database setup..."
if ! influx -execute "SHOW DATABASES" | grep -q "home_assistant"; then
  bashio::log.info "Creating InfluxDB database and user..."
  influx -execute "CREATE DATABASE home_assistant" || bashio::log.warning "Database might already exist"
  influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'" || bashio::log.warning "User might already exist"
  influx -execute "GRANT ALL ON home_assistant TO admin" || bashio::log.warning "Privileges might already be granted"
  bashio::log.info "InfluxDB setup completed"
fi

# Update Grafana configuration with ingress path
bashio::log.info "Configuring Grafana..."
sed -i "s|^root_url = .*|root_url = ${INGRESS_PATH}|g" /etc/grafana/grafana.ini

# Start Grafana with proper user and wait for it to be ready
bashio::log.info "Starting Grafana..."
s6-setuidgid grafana grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana &
GRAFANA_PID=$!

# Wait for Grafana to be ready
bashio::log.info "Waiting for Grafana to be ready..."
RETRY_COUNT=0
MAX_RETRIES=30
until curl -s http://localhost:3001/api/health > /dev/null 2>&1; do
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    bashio::log.error "Grafana failed to start within timeout"
    exit 1
  fi
done
bashio::log.info "Grafana is ready"

# Start the Node.js application
bashio::log.info "Starting Node.js application..."
cd /usr/src/app

# Function to cleanup on exit
cleanup() {
  bashio::log.info "Shutting down services..."
  kill $GRAFANA_PID 2>/dev/null || true
  kill $INFLUXDB_PID 2>/dev/null || true
  wait
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

# Start the Node.js application
exec node --max-old-space-size=256 server.js