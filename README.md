# Carbonoz SolarAutopilot

## Home Assistant Add-on: Carbonoz SolarAutopilot

Carbonoz SolarAutopilot is a powerful add-on for Home Assistant that provides a live Solar dashboard and MQTT inverter control. It allows you to monitor and manage your solar power system efficiently.

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]
![Supports armhf Architecture][armhf-shield]
![Supports armv7 Architecture][armv7-shield]
![Supports i386 Architecture][i386-shield]

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
[armhf-shield]: https://img.shields.io/badge/armhf-yes-green.svg
[armv7-shield]: https://img.shields.io/badge/armv7-yes-green.svg
[i386-shield]: https://img.shields.io/badge/i386-yes-green.svg

## About

This add-on provides a comprehensive solution for managing and monitoring solar power systems. It includes:

- Live Solar Dashboard
- MQTT Inverter Control
- Automation Rules
- Data Logging to InfluxDB

## Installation

Follow these steps to install the add-on:

1. Navigate to the Home Assistant Add-on Store.
2. Find the "Carbonoz SolarAutopilot" add-on in the list and click on it.
3. Click on "Install".

## Configuration

After installation, you need to configure the add-on. Here are the available options:

```yaml
mqtt_host: 192.168.160.55
mqtt_port: 1883
mqtt_username: ""
mqtt_password: ""
battery_number: 1
inverter_number: 1
database_name: ""
database_username: ""
database_password: ""
