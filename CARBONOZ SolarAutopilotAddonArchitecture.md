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

## WebSocket Client Implementation and Data Synchronization

## Overview
The system uses a WebSocket client to establish a persistent connection with a broker server at `wss://broker.carbonoz.com:8000`. This connection is used to forward MQTT messages to the broker after user authentication.

## WebSocket Client Implementation

### 1. Connection Management
```javascript
const connectToWebSocketBroker = async () => {
  let heartbeatInterval = null;
  const reconnectTimeout = 5000; // 5 seconds reconnection delay
```

The implementation includes:
- Heartbeat mechanism to maintain connection health
- Automatic reconnection with a 5-second delay
- Error handling and connection state management

### 2. Heartbeat System
```javascript
const startHeartbeat = (wsClient) => {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  
  heartbeatInterval = setInterval(() => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000); // Send ping every 30 seconds
};
```

Key features:
- 30-second ping interval
- Clears existing heartbeat before starting new one
- Checks connection state before sending ping

### 3. Authentication Flow
```javascript
wsClient.on('open', async () => {
  console.log('Connected to WebSocket broker');
  
  try {
    const isUser = await AuthenticateUser(options);
    console.log('Authentication Result:', { isUser });

    if (isUser) {
      startHeartbeat(wsClient);
      // Message forwarding setup...
    }
  } catch (authError) {
    console.error('Authentication error:', authError);
  }
});
```

Authentication process:
1. Establishes WebSocket connection
2. Authenticates user with provided credentials
3. Starts heartbeat if authentication successful
4. Sets up message forwarding on successful auth

## Data Synchronization

### 1. MQTT to WebSocket Message Forwarding
```javascript
mqttClient.on('message', (topic, message) => {
  if (wsClient.readyState === WebSocket.OPEN) {
    try {
      wsClient.send(
        JSON.stringify({
          mqttTopicPrefix,
          topic,
          message: message.toString(),
          userId: isUser,
          timestamp: new Date().toISOString()
        })
      );
    } catch (sendError) {
      console.error('Error sending message to WebSocket:', sendError);
    }
  } else {
    console.warn('WebSocket is not open. Cannot send message');
  }
});
```

Message forwarding includes:
- Topic prefix for message categorization
- Original MQTT topic and message
- User ID for authentication
- Timestamp for message ordering
- Connection state verification before sending

### 2. Error Handling and Reconnection
```javascript
wsClient.on('error', (error) => {
  console.error('WebSocket Error:', error);
  stopHeartbeat();
  setTimeout(connect, reconnectTimeout);
});

wsClient.on('close', (code, reason) => {
  console.log(`WebSocket closed with code ${code}: ${reason}. Reconnecting...`);
  stopHeartbeat();
  setTimeout(connect, reconnectTimeout);
});
```

Error handling features:
- Automatic reconnection on connection loss
- Heartbeat cleanup on disconnection
- Error logging with codes and reasons
- Graceful connection closure handling

### 3. Data Flow Architecture

```
MQTT Source → MQTT Client → WebSocket Client → Broker Server
     ↓             ↓              ↓                ↓
Real-time    Message Queue    Connection     Data Processing
  Data         Buffer        Management      & Distribution
```

Key components:
1. MQTT Source: Provides real-time data
2. MQTT Client: Receives and buffers messages
3. WebSocket Client: Manages connection and forwards data
4. Broker Server: Processes and distributes data

## Security Considerations

1. Authentication:
   - Client ID and Secret required
   - User verification before message forwarding
   - Secure WebSocket (WSS) protocol

2. Connection Security:
   - Heartbeat monitoring
   - Automatic reconnection
   - Error handling and logging

3. Data Integrity:
   - Message validation
   - Connection state verification
   - Timestamp inclusion

## Implementation Notes

1. The system uses native WebSocket instead of Socket.IO for:
   - Lower overhead
   - Simpler implementation
   - Direct message forwarding

2. Connection management is handled through:
   - Automatic reconnection
   - Heartbeat monitoring
   - Error handling

3. Data synchronization is achieved via:
   - Real-time message forwarding
   - Connection state monitoring
   - User authentication verification

This implementation ensures reliable, secure, and efficient data synchronization between MQTT sources and the broker server while maintaining connection stability through heartbeat monitoring and automatic reconnection mechanisms.
