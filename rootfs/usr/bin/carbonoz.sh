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

# Start Grafana if available
if command -v grafana-server >/dev/null 2>&1; then
  echo "[INFO] Configuring Grafana..."
  
  # Configure Grafana
  sed -i "s|^root_url = .*|root_url = %(protocol)s://%(domain)s:%(http_port)s/|g" /etc/grafana/grafana.ini 2>/dev/null || true
  sed -i "s|^serve_from_sub_path = .*|serve_from_sub_path = false|g" /etc/grafana/grafana.ini 2>/dev/null || true
  sed -i "s|^domain = .*|domain = localhost|g" /etc/grafana/grafana.ini 2>/dev/null || true
  sed -i "s|^http_port = .*|http_port = 3001|g" /etc/grafana/grafana.ini 2>/dev/null || true
  
  # Setup Grafana user and permissions
  addgroup -g 472 grafana 2>/dev/null || true
  adduser -D -u 472 -G grafana grafana 2>/dev/null || true
  chown -R grafana:grafana /data/grafana 2>/dev/null || true
  chmod -R 755 /data/grafana 2>/dev/null || true
  
  # Start Grafana
  echo "[INFO] Starting Grafana..."
  s6-setuidgid grafana grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana &
  GRAFANA_PID=$!
  
  # Wait for Grafana
  echo "[INFO] Waiting for Grafana to be ready..."
  RETRY_COUNT=0
  MAX_RETRIES=30
  until curl -s http://localhost:3001/api/health > /dev/null 2>&1; do
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
      echo "[WARNING] Grafana failed to start, continuing without it"
      kill $GRAFANA_PID 2>/dev/null || true
      GRAFANA_PID=""
      break
    fi
  done
  
  if [ -n "$GRAFANA_PID" ]; then
    echo "[INFO] Grafana is ready"
  fi
else
  echo "[INFO] Grafana not available on this architecture, skipping..."
  GRAFANA_PID=""
fi

# Start the Node.js application
echo "[INFO] Starting Node.js application..."
cd /usr/src/app

# Function to cleanup on exit
cleanup() {
  echo "[INFO] Shutting down services..."
  [ -n "$GRAFANA_PID" ] && kill $GRAFANA_PID 2>/dev/null || true
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