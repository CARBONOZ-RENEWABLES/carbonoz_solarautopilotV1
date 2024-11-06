# First stage: Base image setup
ARG BUILD_FROM
FROM ${BUILD_FROM} as base

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
    gnupg

# Install Grafana
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories \
    && apk add --no-cache grafana

# Second stage: Get InfluxDB
FROM influxdb:1.8-alpine AS influxdb

# Final stage: Combine everything
FROM base

# Copy InfluxDB binaries and configs from InfluxDB stage
COPY --from=influxdb /usr/bin/influx /usr/bin/
COPY --from=influxdb /usr/bin/influxd /usr/bin/
COPY --from=influxdb /etc/influxdb/influxdb.conf /etc/influxdb/

# Set up directories with proper permissions
RUN mkdir -p /var/lib/influxdb /var/log/influxdb /var/lib/grafana /data \
    && chown -R nobody:nobody /var/lib/influxdb /var/log/influxdb /var/lib/grafana /data

# Set work directory
WORKDIR /usr/src/app

# Copy package.json and install dependencies with production flag
COPY package.json .
RUN npm install --frozen-lockfile --production \
    && npm cache clean --force

# Copy application code and configurations
COPY rootfs /
COPY . .
COPY grafana/grafana.ini /etc/grafana/grafana.ini
COPY grafana/provisioning /etc/grafana/provisioning

# Generate Prisma client with production optimization
RUN npx prisma generate \
    && npm prune --production

# Make scripts executable
RUN chmod a+x /etc/services.d/carbonoz/run \
    && chmod a+x /etc/services.d/carbonoz/finish \
    && chmod a+x /etc/services.d/influxdb/run \
    && chmod a+x /etc/services.d/influxdb/finish \
    && chmod a+x /usr/bin/carbonoz.sh

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
    org.opencontainers.image.url="https://github.com/eelitedesire/carbonoz_solarautopilot" \
    org.opencontainers.image.source="https://github.com/eelitedesire/carbonoz_solarautopilot" \
    org.opencontainers.image.documentation="https://github.com/eelitedesire/carbonoz_solarautopilot/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}

# Environment variables for memory optimization
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"

# Expose ports
EXPOSE 3000 8086

# Set entrypoint to s6-overlay init
ENTRYPOINT ["/init"]