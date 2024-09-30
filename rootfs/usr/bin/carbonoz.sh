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
export DATABASE_NAME=$(bashio::config 'database_name')
export DATABASE_USERNAME=$(bashio::config 'database_username')
export DATABASE_PASSWORD=$(bashio::config 'database_password')
export CLIENT_USERNAME=$(bashio::config 'client_username')
export CLIENT_PASSWORD=$(bashio::config 'client_password')

# Update Grafana configuration
sed -i "s|^root_url = .*|root_url = ${INGRESS_PATH}|g" /etc/grafana/grafana.ini

# Start Grafana
grafana-server --config /etc/grafana/grafana.ini --homepath /usr/share/grafana &

# Run the Node.js application
cd /usr/src/app

# Run Prisma to generate client code
npx prisma generate

# Start the Node.js application
exec node --max-old-space-size=64 server.js