# CARBONOZ SolarAutopilot - Addon Architecture Documentation

## Overview
CARBONOZ SolarAutopilot is structured as a multi-service Home Assistant addon that integrates Node.js, InfluxDB, and Grafana into a single container using S6-overlay for service management.

## Build Architecture

### Base Image Configuration
```dockerfile
ARG BUILD_FROM
FROM ${BUILD_FROM} as base
```
- Uses a dynamic base image specified at build time
- Supports multiple architectures: aarch64, amd64, armhf, armv7, i386

### Service Supervisor (S6-Overlay)
- Version: 3.1.5.0
- Architecture-specific installation process
- Handles service dependencies and startup order
- Located in `/etc/services.d/`

### Directory Structure
```
/
├── etc/
│   ├── services.d/
│   │   ├── carbonoz/
│   │   │   ├── run
│   │   │   └── finish
│   │   └── influxdb/
│   │       ├── run
│   │       └── finish
│   └── grafana/
│       ├── grafana.ini
│       └── provisioning/
├── usr/
│   ├── src/
│   └── bin/
│       └── carbonoz.sh
├── Dockerfile
└── server.js
```

## Component Architecture

### 1. Service Management
#### S6-Overlay Services
- **Carbonoz Service**
  ```bash
  # /etc/services.d/carbonoz/run
  #!/usr/bin/with-contenv bashio
  bashio::log.info "Starting Carbonoz SolarAutopilot..."
  exec /usr/bin/carbonoz.sh
  ```
  - Manages main application startup
  - Handles environment configuration
  - Controls service dependencies

- **InfluxDB Service**
  ```bash
  # /etc/services.d/influxdb/run
  #!/usr/bin/with-contenv bashio
  bashio::log.info "Starting InfluxDB..."
  exec s6-setuidgid nobody influxd -config /etc/influxdb/influxdb.conf
  ```
  - Runs InfluxDB with proper permissions
  - Manages database initialization

### 2. Data Storage
#### InfluxDB Configuration
```ini
[data]
cache-max-memory-size = "64MB"
cache-snapshot-memory-size = "32MB"
max-concurrent-compactions = 1
max-series-per-database = 100000
wal-fsync-delay = "200ms"

[meta]
dir = "/data/influxdb/meta"

[data]
dir = "/data/influxdb/data"
wal-dir = "/data/influxdb/wal"
```
- Optimized for embedded systems
- Persistent storage in `/data`
- Memory-conscious configuration

### 3. Visualization Layer
#### Grafana Setup
- Custom configuration via `grafana.ini`
- Automatic provisioning
- Integration with InfluxDB

### 4. Application Layer
#### Node.js Application
- Production environment
- Memory optimized: `--max-old-space-size=128`
- Dependencies managed via `package.json`
- Startup script: `carbonoz.sh`

## Build Process

### 1. Stage: Base Setup
```dockerfile
FROM ${BUILD_FROM} as base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
```
- Configures base environment
- Sets up shell for reliable script execution

### 2. Stage: Dependencies
```dockerfile
RUN apk add --no-cache \
    nodejs \
    npm \
    sqlite \
    openssl \
    openssl-dev \
    curl \
    bash \
    tzdata \
    wget \
    gnupg
```
- Installs system requirements
- Includes development tools

### 3. Stage: Service Installation
```dockerfile
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories
RUN apk add --no-cache grafana influxdb
```
- Adds required repositories
- Installs Grafana and InfluxDB

### 4. Stage: Application Setup
```dockerfile
WORKDIR /usr/src/app
COPY package.json .
RUN npm install --frozen-lockfile --production
```
- Sets up Node.js application
- Installs production dependencies

## Configuration System

### 1. Addon Configuration
```yaml
options:
  mqtt_host: ""
  mqtt_username: ""
  mqtt_password: ""
  mqtt_topic_prefix: ""
  battery_number: 1
  inverter_number: 1
  clientId: ""
  clientSecret: ""
```
- Required MQTT settings
- System configuration
- Authentication details

### 2. Network Configuration
```yaml
ports:
  "3001/tcp": 3001
  "6789/tcp": 6789
  "8000/tcp": 8000
  "8086/tcp": 8086
```
- Grafana: 3001
- Main application: 6789
- WebSocket: 8000
- InfluxDB: 8086

### 3. Ingress Configuration
```yaml
ingress: true
ingress_port: 6789
ingress_stream: true
```
- Enables Home Assistant UI integration
- Configures streaming support

## Startup Process

1. **S6-Overlay Initialization**
   - Starts service supervisor
   - Prepares environment

2. **Service Startup**
   ```bash
   # /usr/bin/carbonoz.sh
   export INGRESS_PATH="$(bashio::addon.ingress_entry)"
   export PORT=6789
   # ... environment setup ...
   grafana-server &
   influxd &
   exec node --max-old-space-size=256 server.js
   ```
   - Sets up environment variables
   - Starts Grafana
   - Initializes InfluxDB
   - Launches Node.js application

3. **Database Initialization**
   ```bash
   influx -execute "CREATE DATABASE home_assistant"
   influx -execute "CREATE USER admin WITH PASSWORD 'adminpassword'"
   influx -execute "GRANT ALL ON home_assistant TO admin"
   ```
   - Creates required database
   - Sets up initial user

## Resource Management

### Memory Optimization
- Node.js: 128MB max old space
- InfluxDB: 64MB cache max
- Grafana: Default configuration

### Storage Management
- Persistent data in `/data`
- Write-ahead logging
- Backup support
