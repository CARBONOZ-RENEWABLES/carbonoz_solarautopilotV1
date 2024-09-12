ARG BUILD_FROM
FROM $BUILD_FROM

# Install requirements for add-on
RUN \
    apk add --no-cache \
    nodejs \
    npm \
    grafana \
    sqlite \
    openssl \
    openssl-dev

# Copy root filesystem
COPY rootfs /

# Set work directory
WORKDIR /usr/src/app

# Install npm dependencies
COPY package.json .
RUN npm install --frozen-lockfile

# Copy data for add-on
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Copy Grafana configuration files
COPY grafana/grafana.ini /etc/grafana/grafana.ini
COPY grafana/provisioning /etc/grafana/provisioning

# Make scripts executable
RUN chmod a+x /etc/services.d/carbonoz/run \
    && chmod a+x /etc/services.d/carbonoz/finish \
    && chmod a+x /usr/bin/carbonoz.sh

# Make Grafana data directory writable
RUN mkdir -p /var/lib/grafana /data && \
    chown -R nobody:nobody /var/lib/grafana /data

# Build arguments
ARG BUILD_ARCH
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

# Expose Grafana port
EXPOSE 3000

# Set entrypoint
ENTRYPOINT ["/init"]
