ARG BUILD_FROM
FROM ${BUILD_FROM}

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Build arguments
ARG BUILD_ARCH
ARG S6_OVERLAY_VERSION=3.1.5.0

# Install S6 overlay
RUN \
    curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" | tar -Jxpf - -C / \
    && case "${BUILD_ARCH}" in \
    "aarch64") S6_ARCH="aarch64" ;; \
    "amd64") S6_ARCH="x86_64" ;; \
    "armhf") S6_ARCH="armhf" ;; \
    "armv7") S6_ARCH="arm" ;; \
    "i386") S6_ARCH="i686" ;; \
    *) S6_ARCH="x86_64" ;; \
    esac \
    && curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" | tar -Jxpf - -C /

# Install system dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    sqlite \
    sqlite-dev \
    openssl \
    openssl-dev \
    curl \
    bash \
    tzdata \
    wget \
    gnupg \
    python3 \
    make \
    g++ \
    gcc \
    linux-headers

# Add community repositories and install Grafana and InfluxDB
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    echo "https://dl-cdn.alpinelinux.org/alpine/v3.18/community" >> /etc/apk/repositories && \
    apk update && \
    apk add --no-cache grafana influxdb

# Set up directories
RUN mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal \
    && mkdir -p /data/backup \
    && chown -R nobody:nobody /data

# Set work directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies with native compilation for better-sqlite3
RUN npm cache clean --force \
    && npm install --omit=dev --build-from-source \
    && npm cache clean --force

# Test better-sqlite3 module
RUN node -e "const Database = require('better-sqlite3'); console.log('✅ better-sqlite3 loaded successfully');"

# Copy application files
COPY . .

# Copy configurations
COPY rootfs /
COPY grafana/grafana.ini /etc/grafana/grafana.ini
COPY grafana/provisioning /etc/grafana/provisioning

# Make scripts executable
RUN find /etc/services.d -type f -name "run" -exec chmod a+x {} \; \
    && find /etc/services.d -type f -name "finish" -exec chmod a+x {} \; \
    && chmod a+x /usr/bin/carbonoz.sh 2>/dev/null || true

# Build arguments for labels
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

# Labels
LABEL \
    io.hass.name="Carbonoz SolarAutopilot" \
    io.hass.description="CARBONOZ SolarAutopilot for Home Assistant" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Elite Desire <eelitedesire@gmail.com>"

# Environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"

# Expose ports
EXPOSE 3001 8086 6789 8000

# Entrypoint
ENTRYPOINT ["/init"]