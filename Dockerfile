ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG BUILD_ARCH
ARG S6_OVERLAY_VERSION=3.1.5.0

# --- Install S6 overlay (correct order for Alpine) ---
RUN apk add --no-cache xz

RUN \
    curl -L -s \
    "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
    | tar -Jxpf - -C / \
    && case "${BUILD_ARCH}" in \
        "aarch64") S6_ARCH="aarch64" ;; \
        "amd64") S6_ARCH="x86_64" ;; \
        "armhf") S6_ARCH="armhf" ;; \
        "armv7") S6_ARCH="arm" ;; \
        "i386") S6_ARCH="i686" ;; \
        *) S6_ARCH="x86_64" ;; \
    esac \
    && curl -L -s \
    "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
    | tar -Jxpf - -C /

# Required for s6-overlay v3
RUN apk add --no-cache execline

# --- Install system dependencies ---
RUN apk add --no-cache \
    nodejs npm \
    openssl openssl-dev \
    bash curl wget tzdata \
    python3 make g++ gcc \
    linux-headers

# --- Install Grafana & InfluxDB ---
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories \
    && apk update \
    && apk add --no-cache grafana influxdb

# --- Prepare directories ---
RUN mkdir -p /data/influxdb/meta \
    /data/influxdb/data \
    /data/influxdb/wal \
    /data/backup \
    && chown -R nobody:nobody /data

WORKDIR /usr/src/app

# --- Install Node dependencies (forced native build on correct arch) ---
COPY package*.json ./

RUN npm config set unsafe-perm true \
    && npm install --omit=dev \
    && npm cache clean --force

# --- Copy application ---
COPY . .

COPY rootfs /
COPY grafana/grafana.ini /etc/grafana/grafana.ini
COPY grafana/provisioning /etc/grafana/provisioning

RUN chmod +x /usr/bin/carbonoz.sh \
    && find /etc/services.d -name run -exec chmod +x {} \; \
    && find /etc/services.d -name finish -exec chmod +x {} \;

ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION

LABEL \
    io.hass.name="CARBONOZ SolarAutopilot" \
    io.hass.description="Home Assistant Add-on" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION}

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=256"

EXPOSE 3001 8086 6789 8000

ENTRYPOINT ["/init"]
