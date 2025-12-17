#!/usr/bin/with-contenv bash

# Set up environment variables
export INGRESS_PATH="${INGRESS_ENTRY:-}"
export PORT=6789

# Get config from options.json if available
if [ -f "/data/options.json" ]; then
  export MQTT_PORT=$(jq -r '.mqtt_port // 1883' /data/options.json)
  export MQTT_USERNAME=$(jq -r '.mqtt_username // ""' /data/options.json)
  export MQTT_PASSWORD=$(jq -r '.mqtt_password // ""' /data/options.json)
  export MQTT_TOPIC_PREFIX=$(jq -r '.mqtt_topic_prefix // "solarautopilot"' /data/options.json)
  export BATTERY_NUMBER=$(jq -r '.battery_number // "1"' /data/options.json)
  export INVERTER_NUMBER=$(jq -r '.inverter_number // "1"' /data/options.json)
  export CLIENT_USERNAME=$(jq -r '.client_username // ""' /data/options.json)
  export CLIENT_PASSWORD=$(jq -r '.client_password // ""' /data/options.json)
else
  # Default values
  export MQTT_PORT=1883
  export MQTT_USERNAME=""
  export MQTT_PASSWORD=""
  export MQTT_TOPIC_PREFIX="solarautopilot"
  export BATTERY_NUMBER="1"
  export INVERTER_NUMBER="1"
  export CLIENT_USERNAME=""
  export CLIENT_PASSWORD=""
fi

echo "[INFO] Starting Carbonoz SolarAutopilot services..."
echo "[INFO] Ingress path: ${INGRESS_PATH}"

# Ensure data directories exist with correct permissions
echo "[INFO] Setting up data directories..."
mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal
mkdir -p /data/grafana/data /data/grafana/logs /data/grafana/plugins
chown -R nobody:nobody /data/influxdb

# Start InfluxDB first
echo "[INFO] Starting InfluxDB..."
influxd -config /etc/influxdb/influxdb.conf &
INFLUXDB_PID=$!

# Wait for InfluxDB to be ready
echo "[INFO] Waiting for InfluxDB to be ready..."
RETRY_COUNT=0
MAX_RETRIES=30
until curl -s http://localhost:8086/ping > /dev/null 2>&1; do
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "[ERROR] InfluxDB failed to start within timeout"
    exit 1
  fi
done
echo "[INFO] InfluxDB is ready"

# Initialize InfluxDB database if needed
echo "[INFO] Checking InfluxDB database setup..."
if ! influx -execute "SHOW DATABASES" | grep -q "home_assistant"; then
  echo "[INFO] Creating InfluxDB database and user..."
  influx -execute "CREATE DATABASE home_assistant" || echo "[WARNING] Database might already exist"
  influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'" || echo "[WARNING] User might already exist"
  influx -execute "GRANT ALL ON home_assistant TO admin" || echo "[WARNING] Privileges might already be granted"
  echo "[INFO] InfluxDB setup completed"
fi

# Update Grafana configuration with proper ingress support
echo "[INFO] Configuring Grafana..."

# Always configure Grafana to run at root - let the proxy handle routing
echo "[INFO] Setting Grafana to run at localhost:3001 (proxy handles routing)"
sed -i "s|^root_url = .*|root_url = %(protocol)s://%(domain)s:%(http_port)s/|g" /etc/grafana/grafana.ini
sed -i "s|^serve_from_sub_path = .*|serve_from_sub_path = false|g" /etc/grafana/grafana.ini
sed -i "s|^domain = .*|domain = localhost|g" /etc/grafana/grafana.ini
sed -i "s|^http_port = .*|http_port = 3001|g" /etc/grafana/grafana.ini

# Ensure Grafana has proper permissions and clean start
echo "[INFO] Preparing Grafana environment..."
addgroup -g 472 grafana 2>/dev/null || true
adduser -D -u 472 -G grafana grafana 2>/dev/null || true
chown -R grafana:grafana /data/grafana
chmod -R 755 /data/grafana

# Clean any problematic Grafana state
rm -f /data/grafana/grafana.db-wal /data/grafana/grafana.db-shm 2>/dev/null || true

# Start Grafana with proper user and wait for it to be ready
echo "[INFO] Starting Grafana..."
s6-setuidgid grafana grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana &
GRAFANA_PID=$!

# Wait for Grafana to be ready with more comprehensive checks
echo "[INFO] Waiting for Grafana to be ready..."
RETRY_COUNT=0
MAX_RETRIES=60
until curl -s http://localhost:3001/api/health > /dev/null 2>&1; do
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "[ERROR] Grafana failed to start within timeout"
    echo "[INFO] Checking Grafana process status..."
    ps aux | grep grafana || echo "[ERROR] Grafana process not found"
    echo "[INFO] Checking Grafana logs..."
    tail -20 /data/grafana/logs/grafana.log 2>/dev/null || echo "[WARNING] No Grafana log file found"
    exit 1
  fi
  if [ $((RETRY_COUNT % 15)) -eq 0 ]; then
    echo "[INFO] Still waiting for Grafana... (attempt $RETRY_COUNT/$MAX_RETRIES)"
  fi
done
echo "[INFO] Grafana is ready"

# Verify Grafana configuration and API access
echo "[INFO] Verifying Grafana configuration..."
HEALTH_RESPONSE=$(curl -s http://localhost:3001/api/health || echo "failed")
if [ "$HEALTH_RESPONSE" = "failed" ]; then
  echo "[ERROR] Grafana health check failed"
  exit 1
fi

echo "[INFO] Grafana health check: $HEALTH_RESPONSE"

# Test additional Grafana endpoints
echo "[INFO] Testing Grafana API endpoints..."
curl -s http://localhost:3001/api/org >/dev/null 2>&1 && echo "[INFO] Grafana API accessible" || echo "[WARNING] Grafana API test failed"

# Test static file serving
curl -s http://localhost:3001/public/img/grafana_icon.svg >/dev/null 2>&1 && echo "[INFO] Grafana static files accessible" || echo "[WARNING] Grafana static files test failed"

# Test if Grafana home page loads
curl -s http://localhost:3001/ >/dev/null 2>&1 && echo "[INFO] Grafana home page accessible" || echo "[WARNING] Grafana home page test failed"

# Check Grafana frontend build files
if [ -d "/usr/share/grafana/public/build" ]; then
  echo "[INFO] Grafana build directory exists"
  ls -la /usr/share/grafana/public/build/ | head -5 || echo "[WARNING] Could not list build files"
else
  echo "[WARNING] Grafana build directory not found"
fi

# Create a simple dashboard if none exists
echo "[INFO] Checking for dashboards..."
DASHBOARD_CHECK=$(curl -s http://localhost:3001/api/search 2>/dev/null || echo "[]")
if [ "$DASHBOARD_CHECK" = "[]" ]; then
  echo "[INFO] No dashboards found, this is normal for first run"
fi

# Start the Node.js application
echo "[INFO] Starting Node.js application..."
cd /usr/src/app

# Function to cleanup on exit
cleanup() {
  echo "[INFO] Shutting down services..."
  kill $GRAFANA_PID 2>/dev/null || true
  kill $INFLUXDB_PID 2>/dev/null || true
  wait
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

# Show final configuration
echo "[INFO] === Configuration Summary ==="
echo "[INFO] Port: ${PORT}"
echo "[INFO] Ingress Path: ${INGRESS_PATH:-'Not set (direct access)'}"
echo "[INFO] Grafana URL: http://localhost:3001"
echo "[INFO] Dashboard URL: http://localhost:${PORT}${INGRESS_PATH}"
echo "[INFO] ============================="

# Start the Node.js application with memory optimization
exec node --max-old-space-size=256 server.js