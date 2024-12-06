# First stage: Base image setup
ARG BUILD_FROM
FROM ${BUILD_FROM} as base

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Build arguments
ARG BUILD_ARCH
ARG S6_OVERLAY_VERSION=3.1.5.0

# Install S6 overlay
RUN curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" | tar -Jxpf - -C / && \
    case "${BUILD_ARCH}" in \
    "aarch64") S6_ARCH="aarch64" ;; \
    "amd64") S6_ARCH="x86_64" ;; \
    "armhf") S6_ARCH="armhf" ;; \
    "armv7") S6_ARCH="arm" ;; \
    "i386") S6_ARCH="i686" ;; \
    *) S6_ARCH="x86_64" ;; \
    esac && \
    curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" | tar -Jxpf - -C /

# Install base system dependencies
RUN apk add --no-cache \
    nodejs\
    npm \
    curl \
    bash \
    tzdata \
    wget \
    gnupg

# Add community repositories and install Grafana and InfluxDB
RUN echo "https://dl-cdn.alpinelinux.org/alpine/v3.18/community" >> /etc/apk/repositories && \
    apk add --no-cache grafana influxdb

# Configure InfluxDB
RUN mkdir -p /etc/influxdb && \
    wget -q https://raw.githubusercontent.com/influxdata/influxdb/1.8/etc/config.sample.toml -O /etc/influxdb/influxdb.conf

# Set up directories with proper permissions
RUN mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal && \
    chown -R nobody:nobody /data

# Set work directory
WORKDIR /usr/src/app

# Copy package.json first and install dependencies
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Copy application code and configurations
COPY rootfs /
COPY . .
COPY grafana/grafana.ini /etc/grafana/grafana.ini
COPY grafana/provisioning /etc/grafana/provisioning

# Make scripts executable
RUN chmod a+x \
    /etc/services.d/carbonoz/run \
    /etc/services.d/carbonoz/finish \
    /etc/services.d/influxdb/run \
    /etc/services.d/influxdb/finish \
    /usr/bin/carbonoz.sh

# Build arguments for labels
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

# Add labels
LABEL \
    maintainer="Your Name" \
    org.opencontainers.image.title="CARBONOZ SolarAutopilot Addon" \
    org.opencontainers.image.description="CARBONOZ SolarAutopilot for Home Assistant with live Solar dashboard and MQTT inverter control." \
    org.opencontainers.image.vendor="CARBONOZ" \
    org.opencontainers.image.version=${BUILD_VERSION} \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.source=${BUILD_REF}

# Environment variables for memory optimization
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=128"

# Expose ports
EXPOSE 3000 8086

# Set entrypoint to s6-overlay init
ENTRYPOINT ["/init"]
