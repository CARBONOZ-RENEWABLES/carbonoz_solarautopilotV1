# Fixed Dockerfile for multi-architecture builds
ARG BUILD_FROM
FROM ${BUILD_FROM} as base

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Build arguments
ARG BUILD_ARCH
ARG TARGETARCH
ARG TARGETPLATFORM
ARG S6_OVERLAY_VERSION=3.1.6.2

# Install S6 overlay with better architecture detection
RUN \
    case "${BUILD_ARCH:-${TARGETARCH}}" in \
    "aarch64"|"arm64") S6_ARCH="aarch64" ;; \
    "amd64"|"x86_64") S6_ARCH="x86_64" ;; \
    "armhf") S6_ARCH="armhf" ;; \
    "armv7"|"arm") S6_ARCH="arm" ;; \
    "i386"|"386") S6_ARCH="i686" ;; \
    *) S6_ARCH="x86_64" ;; \
    esac \
    && curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" | tar -Jxpf - -C / \
    && curl -L -s "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" | tar -Jxpf - -C /

# Install base system dependencies
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
    gnupg \
    python3 \
    make \
    g++

# Get Alpine version and add appropriate repositories
RUN ALPINE_VERSION=$(cat /etc/alpine-release | cut -d'.' -f1,2) && \
    echo "Current Alpine version: ${ALPINE_VERSION}" && \
    echo "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/community" >> /etc/apk/repositories && \
    echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    apk update

# Install InfluxDB and Grafana with architecture-specific handling
RUN set -x && \
    ARCH="${BUILD_ARCH:-${TARGETARCH}}" && \
    echo "Installing packages for architecture: ${ARCH}" && \
    case "${ARCH}" in \
    "aarch64"|"arm64") \
        apk add --no-cache influxdb || echo "InfluxDB not available for ${ARCH}, will use alternative" ;; \
    "amd64"|"x86_64") \
        apk add --no-cache influxdb grafana || echo "Some packages not available for ${ARCH}" ;; \
    "armv7"|"armhf"|"i386") \
        echo "Using lightweight alternatives for ${ARCH}" && \
        apk add --no-cache influxdb || echo "InfluxDB not available for ${ARCH}" ;; \
    *) \
        echo "Unknown architecture ${ARCH}, skipping optional packages" ;; \
    esac

# Set up directories with proper permissions for persistent storage
RUN mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal \
    && mkdir -p /data/backup \
    && chown -R nobody:nobody /data

# Set work directory
WORKDIR /usr/src/app

# Copy package.json first for better caching
COPY package*.json ./

# Install Node.js dependencies with better error handling
RUN set -x && \
    echo "Installing Node.js dependencies for architecture: ${BUILD_ARCH:-${TARGETARCH}}" && \
    npm config set unsafe-perm true && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm install --frozen-lockfile --production --no-optional && \
    npm cache clean --force

# Copy application code and configurations
COPY rootfs /
COPY . .

# Copy Grafana configuration if it exists
RUN if [ -f "grafana/grafana.ini" ]; then \
        mkdir -p /etc/grafana && \
        cp grafana/grafana.ini /etc/grafana/grafana.ini; \
    fi && \
    if [ -d "grafana/provisioning" ]; then \
        mkdir -p /etc/grafana && \
        cp -r grafana/provisioning /etc/grafana/; \
    fi

# Make scripts executable with error checking
RUN find /etc/services.d -name "run" -type f -exec chmod a+x {} \; || true && \
    find /etc/services.d -name "finish" -type f -exec chmod a+x {} \; || true && \
    [ -f /usr/bin/carbonoz.sh ] && chmod a+x /usr/bin/carbonoz.sh || echo "carbonoz.sh not found, skipping"

# Build arguments for labels
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

# Labels
LABEL \
    io.hass.name="Carbonoz SolarAutopilot" \
    io.hass.description="CARBONOZ SolarAutopilot for Home Assistant with live Solar dashboard and MQTT inverter control" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="Elite Desire <eelitedesire@gmail.com>" \
    org.opencontainers.image.title="Carbonoz SolarAutopilot" \
    org.opencontainers.image.description="CARBONOZ SolarAutopilot for Home Assistant with live Solar dashboard and MQTT inverter control" \
    org.opencontainers.image.vendor="Home Assistant Community Add-ons" \
    org.opencontainers.image.authors="Elite Desire <eelitedesire@gmail.com>" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/CARBONOZ-RENEWABLES/solarautopilot" \
    org.opencontainers.image.source="https://github.com/CARBONOZ-RENEWABLES/solarautopilot" \
    org.opencontainers.image.documentation="https://github.com/CARBONOZ-RENEWABLES/solarautopilot/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

# Environment variables for memory optimization
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"

# Expose ports
EXPOSE 3001 8086 6789 8000

# Set entrypoint to s6-overlay init
ENTRYPOINT ["/init"]
