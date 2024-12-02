#!/usr/bin/with-contenv bashio
# Environment and config setup
export INGRESS_PATH="$(bashio::addon.ingress_entry)"
export PORT=6789
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=256"
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

# Initialize InfluxDB data if not exists
if [ ! -d "/data/influxdb/meta" ]; then
    mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal
    chown -R nobody:nobody /data/influxdb
fi

# Restore data from backup if needed
if [ ! -d "/data/influxdb/meta" ] && [ -d "/data/influxdb/backup" ]; then
    influxd restore -portable -db home_assistant /data/influxdb/backup
fi

# Start InfluxDB
influxd -config /etc/influxdb/influxdb.conf &

# Wait for InfluxDB to initialize
for i in {1..30}; do
    if influx -execute "SHOW DATABASES" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Create database if not exists
if ! influx -execute "SHOW DATABASES" | grep -q "home_assistant"; then
    influx -execute "CREATE DATABASE home_assistant"
fi

# Create admin user if not exists
if ! influx -execute "SHOW USERS" | grep -q "admin"; then
    influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'"
    influx -execute "GRANT ALL ON home_assistant TO admin"
fi

# Start Grafana
grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana --pidfile /var/run/grafana.pid &

# Start Node.js application
cd /usr/src/app
exec node --max-old-space-size=256 --gc-interval=100 --optimize-for-size server.js
