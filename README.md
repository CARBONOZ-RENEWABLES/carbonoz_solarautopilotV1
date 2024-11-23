# CARBONOZ SolarAutopilot

## About

CARBONOZ SolarAutopilot is a comprehensive solar monitoring and control solution for Home Assistant that combines powerful system management with environmental impact tracking.

### Environmental Impact & CO2 Offsetting

CO2 offsetting is a strategy used to mitigate the impact of greenhouse gas emissions by compensating for them through activities that reduce or remove an equivalent amount of CO2 from the atmosphere. This can include investing in renewable energy projects, reforestation, or other sustainability initiatives. By contributing to CO2 offsets, individuals and businesses can play a significant role in addressing climate change and achieving global carbon neutrality goals.

For solar system owners, CO2 offsetting is particularly relevant. Solar energy systems generate clean, renewable energy, reducing the need for electricity from fossil fuel-powered plants. Each kilowatt-hour (kWh) of solar energy produced prevents the release of a measurable amount of CO2 into the atmosphere. By tracking their system's energy output, solar owners can calculate the amount of CO2 their system offsets and leverage this data for economic and environmental benefits.

Create your own account at [login.carbonoz.com](https://login.carbonoz.com) to become part of our movement to:
- Log your electricity production
- Receive valuable system optimization advice
- Offer your CO2 offsets on the market
- Soon: Receive compensation for your CO2 offsets (under development)

## Features

- Live Solar Dashboard with real-time monitoring
- MQTT inverter control integration
- CO2 offset tracking and reporting
- System optimization recommendations
- Multiple architecture support (aarch64, amd64, armhf, armv7, i386)
- Integrated web interface
- Secure WebSocket communication
- Built-in InfluxDB for data storage

## Installation

1. Add our repository to your Home Assistant instance
2. Search for "CARBONOZ SolarAutopilot" in the add-on store
3. Install the add-on
4. Configure the required settings

## Configuration

```yaml
mqtt_host: ""          # Your MQTT broker host
mqtt_username: ""      # MQTT username (optional)
mqtt_password: ""      # MQTT password (optional)
mqtt_topic_prefix: "solar_assistant_DEYE"  # MQTT topic prefix
battery_number: 1      # Number of batteries in your system
inverter_number: 1     # Number of inverters in your system
clientId: ""          # Your CARBONOZ client ID
clientSecret: ""      # Your CARBONOZ client secret
```

## Network Ports

The add-on uses the following ports:
- 3001/tcp: Web interface (optional)
- 6789/tcp: Main application
- 7100/tcp: WebSocket
- 8086/tcp: InfluxDB

## Support

For support, please visit:
- GitHub Issues: [https://github.com/CARBONOZ-RENEWABLES/solarautopilot/issues](https://github.com/CARBONOZ-RENEWABLES/solarautopilot/issues)
- Website: [https://carbonoz.com](https://carbonoz.com)

## License

This project is licensed under the MIT License.

## Contributing

We welcome contributions! Please see our contributing guidelines in the repository.
