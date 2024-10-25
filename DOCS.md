# CARBONOZ SolarAutopilot

## Home Assistant Add-on: CARBONOZ SolarAutopilot

CARBONOZ Solar Autopilot is the dashboard of your choice for every day use of your Hybrid Solar system. We offer easy to use data logging, analytics, CO2 avoidance and powerful export features. Solar Autopilot is your first line of defence against overconsuming devices, drowning batteries and cloudy days. Manage easy to setup templates, automations and alerts by setting up event triggers. Solar Autopilot is available via Home Assistant Add-On Store so you can still benefit from the many other Home Assistant IoT integrations, features and automations available.

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

SUPPORTED SOLAR HYBRID INVERTERS

- Deye / Sunsynk
- Voltronic / Axpert / MPP Solar
- Growatt
- More to come....

## Installation

Follow these steps to install the add-on:

1. Navigate to the Home Assistant Add-on Store.
2. Find the "CARBONOZ SolarAutopilot" add-on in the list and click on it.
3. Click on "Install".

## Configuration

After installation, you need to configure the add-on. Here are the available options:

```yaml
mqtt_host: 192.168.160.55
mqtt_port: 1883
mqtt_username: ""
mqtt_password: ""
battery_number: 
inverter_number: 
mqtt_topic_prefix: "solar_assistant_DEYE"
clientId: ""
clientSecret: ""
