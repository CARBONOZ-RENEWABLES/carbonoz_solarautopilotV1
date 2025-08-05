# First stage: Base image setup
ARG BUILD_FROM
FROM ${BUILD_FROM} as base

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Build arguments
ARG BUILD_ARCH
ARG S6_OVERLAY_VERSION=3.1.5.0

# Get Alpine version and set repositories appropriately
RUN ALPINE_VERSION=$(cat /etc/alpine-release | cut -d'.' -f1,2) && \
    echo "http://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/main" > /etc/apk/repositories && \
    echo "http://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/community" >> /etc/apk/repositories && \
    echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
    apk update

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

# Install base system dependencies first
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

# Install architecture-specific packages
RUN case "${BUILD_ARCH}" in \
    "amd64"|"aarch64") \
        echo "Installing full packages for ${BUILD_ARCH}" && \
        apk add --no-cache grafana influxdb || \
        (echo "Grafana/InfluxDB not available, using alternatives" && \
         apk add --no-cache --repository=http://dl-cdn.alpinelinux.org/alpine/edge/testing influxdb || \
         echo "InfluxDB not available for ${BUILD_ARCH}") \
        ;; \
    *) \
        echo "Installing minimal packages for ${BUILD_ARCH}" && \
        (apk add --no-cache influxdb || echo "InfluxDB not available for ${BUILD_ARCH}") \
        ;; \
    esac

# Set up directories with proper permissions for persistent storage
RUN mkdir -p /data/influxdb/meta /data/influxdb/data /data/influxdb/wal \
    && mkdir -p /data/backup \
    && mkdir -p /var/lib/grafana \
    && chown -R nobody:nobody /data \
    && chmod -R 755 /data

# Set work directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies with production flag
COPY package.json .
RUN npm install --frozen-lockfile --production \
    && npm cache clean --force

# Copy application code and configurations
COPY rootfs /
COPY . .

# Copy Grafana config only if it exists and Grafana is installed
RUN if [ -f "grafana/grafana.ini" ] && command -v grafana-server >/dev/null 2>&1; then \
        cp grafana/grafana.ini /etc/grafana/grafana.ini 2>/dev/null || \
        mkdir -p /etc/grafana && cp grafana/grafana.ini /etc/grafana/grafana.ini; \
    fi

RUN if [ -d "grafana/provisioning" ] && command -v grafana-server >/dev/null 2>&1; then \
        cp -r grafana/provisioning /etc/grafana/ 2>/dev/null || \
        mkdir -p /etc/grafana && cp -r grafana/provisioning /etc/grafana/; \
    fi

# Make scripts executable (with error handling)
RUN chmod a+x /etc/services.d/carbonoz/run 2>/dev/null || echo "carbonoz service script not found" \
    && chmod a+x /etc/services.d/carbonoz/finish 2>/dev/null || echo "carbonoz finish script not found" \
    && chmod a+x /etc/services.d/influxdb/run 2>/dev/null || echo "influxdb service script not found" \
    && chmod a+x /etc/services.d/influxdb/finish 2>/dev/null || echo "influxdb finish script not found" \
    && chmod a+x /usr/bin/carbonoz.sh 2>/dev/null || echo "carbonoz.sh script not found"

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
