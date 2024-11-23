#!/usr/bin/with-contenv bashio

# Set up environment variables
export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789

# Get config with memory-optimized environment
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=256"

# Get MQTT configuration
export MQTT_HOST=$(bashio::config 'mqtt_host')
export MQTT_USERNAME=$(bashio::config 'mqtt_username')
export MQTT_PASSWORD=$(bashio::config 'mqtt_password')
export MQTT_TOPIC_PREFIX=$(bashio::config 'mqtt_topic_prefix')
export BATTERY_NUMBER=$(bashio::config 'battery_number')
export INVERTER_NUMBER=$(bashio::config 'inverter_number')
export CLIENT_USERNAME=$(bashio::config 'client_username')
export CLIENT_PASSWORD=$(bashio::config 'client_password')

# Set directory permissions
bashio::log.info "Setting directory permissions..."
chown -R nobody:nobody /data/influxdb
chmod -R 755 /data/influxdb

# Update Grafana configuration
sed -i "s|^root_url = .*|root_url = ${INGRESS_PATH}|g" /etc/grafana/grafana.ini

# Check if InfluxDB data exists
if [ ! -d "/data/influxdb/meta" ]; then
    bashio::log.warning "No existing InfluxDB data found, initializing fresh setup..."
    mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal
    chown -R nobody:nobody /data/influxdb
else
    bashio::log.info "Existing InfluxDB data found, using it..."
fi

# Restore data if needed
if [ ! -d "/data/influxdb/meta" ] && [ -d "/data/influxdb/backup" ]; then
    bashio::log.warning "Restoring InfluxDB data from backup..."
    influxd restore -portable -db home_assistant /data/influxdb/backup
fi

# Start InfluxDB
bashio::log.info "Starting InfluxDB..."
influxd -config /etc/influxdb/influxdb.conf &

# Wait for InfluxDB to initialize
bashio::log.info "Waiting for InfluxDB to initialize..."
for i in {1..30}; do
    if influx -execute "SHOW DATABASES" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Database and user setup
if ! influx -execute "SHOW DATABASES" | grep -q "home_assistant"; then
    bashio::log.info "Creating 'home_assistant' database..."
    influx -execute "CREATE DATABASE home_assistant"
else
    bashio::log.info "'home_assistant' database already exists."
fi

if ! influx -execute "SHOW USERS" | grep -q "admin"; then
    bashio::log.info "Creating 'admin' user..."
    influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'"
    influx -execute "GRANT ALL ON home_assistant TO admin"
else
    bashio::log.info "'admin' user already exists."
fi

# Start Grafana
grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana --pidfile /var/run/grafana.pid &

# Start Node.js application
cd /usr/src/app
exec node --max-old-space-size=256 --gc-interval=100 --optimize-for-size server.js
