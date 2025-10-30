#!/usr/bin/with-contenv bashio

# Set up environment variables
export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789

# Get config
export MQTT_PORT=$(bashio::config 'mqtt_port') 
export MQTT_USERNAME=$(bashio::config 'mqtt_username')
export MQTT_PASSWORD=$(bashio::config 'mqtt_password')
export MQTT_TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix')
export BATTERY_NUMBER=$(bashio::config 'battery_number')
export INVERTER_NUMBER=$(bashio::config 'inverter_number')
export CLIENT_USERNAME=$(bashio::config 'client_username')
export CLIENT_PASSWORD=$(bashio::config 'client_password')

bashio::log.info "Starting Carbonoz SolarAutopilot services..."
bashio::log.info "Ingress path: ${INGRESS_PATH}"

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

# Update Grafana configuration with proper ingress support
bashio::log.info "Configuring Grafana..."

# Always configure Grafana to run at root - let the proxy handle routing
bashio::log.info "Setting Grafana to run at localhost:3001 (proxy handles routing)"
sed -i "s|^root_url = .*|root_url = %(protocol)s://%(domain)s:%(http_port)s/|g" /etc/grafana/grafana.ini
sed -i "s|^serve_from_sub_path = .*|serve_from_sub_path = false|g" /etc/grafana/grafana.ini
sed -i "s|^domain = .*|domain = localhost|g" /etc/grafana/grafana.ini
sed -i "s|^http_port = .*|http_port = 3001|g" /etc/grafana/grafana.ini

# Ensure Grafana has proper permissions and clean start
bashio::log.info "Preparing Grafana environment..."
chown -R grafana:grafana /data/grafana
chmod -R 755 /data/grafana

# Clean any problematic Grafana state
rm -f /data/grafana/grafana.db-wal /data/grafana/grafana.db-shm 2>/dev/null || true

# Start Grafana with proper user and wait for it to be ready
bashio::log.info "Starting Grafana..."
s6-setuidgid grafana grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana &
GRAFANA_PID=$!

# Wait for Grafana to be ready with more comprehensive checks
bashio::log.info "Waiting for Grafana to be ready..."
RETRY_COUNT=0
MAX_RETRIES=60
until curl -s http://localhost:3001/api/health > /dev/null 2>&1; do
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    bashio::log.error "Grafana failed to start within timeout"
    bashio::log.info "Checking Grafana process status..."
    ps aux | grep grafana || bashio::log.error "Grafana process not found"
    bashio::log.info "Checking Grafana logs..."
    tail -20 /data/grafana/logs/grafana.log 2>/dev/null || bashio::log.warning "No Grafana log file found"
    exit 1
  fi
  if [ $((RETRY_COUNT % 15)) -eq 0 ]; then
    bashio::log.info "Still waiting for Grafana... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  fi
done
bashio::log.info "Grafana is ready"

# Verify Grafana configuration and API access
bashio::log.info "Verifying Grafana configuration..."
HEALTH_RESPONSE=$(curl -s http://localhost:3001/api/health || echo "failed")
if [ "$HEALTH_RESPONSE" = "failed" ]; then
  bashio::log.error "Grafana health check failed"
  exit 1
fi

bashio::log.info "Grafana health check: $HEALTH_RESPONSE"

# Test additional Grafana endpoints
bashio::log.info "Testing Grafana API endpoints..."
curl -s http://localhost:3001/api/org >/dev/null 2>&1 && bashio::log.info "Grafana API accessible" || bashio::log.warning "Grafana API test failed"

# Test static file serving
curl -s http://localhost:3001/public/img/grafana_icon.svg >/dev/null 2>&1 && bashio::log.info "Grafana static files accessible" || bashio::log.warning "Grafana static files test failed"

# Test if Grafana home page loads
curl -s http://localhost:3001/ >/dev/null 2>&1 && bashio::log.info "Grafana home page accessible" || bashio::log.warning "Grafana home page test failed"

# Check Grafana frontend build files
if [ -d "/usr/share/grafana/public/build" ]; then
  bashio::log.info "Grafana build directory exists"
  ls -la /usr/share/grafana/public/build/ | head -5 || bashio::log.warning "Could not list build files"
else
  bashio::log.warning "Grafana build directory not found"
fi

# Create a simple dashboard if none exists
bashio::log.info "Checking for dashboards..."
DASHBOARD_CHECK=$(curl -s http://localhost:3001/api/search 2>/dev/null || echo "[]")
if [ "$DASHBOARD_CHECK" = "[]" ]; then
  bashio::log.info "No dashboards found, this is normal for first run"
fi

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

# Show final configuration
bashio::log.info "=== Configuration Summary ==="
bashio::log.info "Port: ${PORT}"
bashio::log.info "Ingress Path: ${INGRESS_PATH:-'Not set (direct access)'}"
bashio::log.info "Grafana URL: http://localhost:3001"
bashio::log.info "Dashboard URL: http://localhost:${PORT}${INGRESS_PATH}"
bashio::log.info "============================="

# Start the Node.js application with memory optimization
exec node --max-old-space-size=256 server.js