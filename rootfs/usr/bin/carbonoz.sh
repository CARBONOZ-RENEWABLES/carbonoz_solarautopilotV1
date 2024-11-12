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

# Update Grafana configuration
sed -i "s|^root_url = .*|root_url = ${INGRESS_PATH}|g" /etc/grafana/grafana.ini

# Start services with reduced memory footprint
grafana-server \
    --config /etc/grafana/grafana.ini \
    --homepath /usr/share/grafana \
    --pidfile /var/run/grafana.pid &

# Start InfluxDB with memory limits
influxd -config /etc/influxdb/influxdb.conf &

# Wait for InfluxDB to start
bashio::log.info "Waiting for InfluxDB to start..."
for i in {1..30}; do
    if influx -execute "SHOW DATABASES" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Initialize database with error handling
if ! influx -execute "CREATE DATABASE home_assistant" 2>/dev/null; then
    bashio::log.info "Database already exists or creation failed"
fi

if ! influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'" 2>/dev/null; then
    bashio::log.info "User already exists or creation failed"
fi

influx -execute "GRANT ALL ON home_assistant TO admin"

# Start Node.js application with memory optimization
cd /usr/src/app
exec node \
    --max-old-space-size=256 \
    --gc-interval=100 \
    --optimize-for-size \
    server.js
