const Influx = require('influx');

// Source InfluxDB (has data)
const sourceConfig = {
  host: 'homeassistant-andreas-raspberry.zebu-beaufort.ts.net',
  port: 8086,
  database: 'home_assistant',
  username: 'admin',
  password: 'adminpassword',
  protocol: 'http',
  timeout: 30000,
};

// Target InfluxDB (needs data)
const targetConfig = {
  host: '192.168.43.33',
  port: 8086,
  database: 'home_assistant',
  username: 'admin',
  password: 'adminpassword',
  protocol: 'http',
  timeout: 30000,
};

const sourceInflux = new Influx.InfluxDB(sourceConfig);
const targetInflux = new Influx.InfluxDB(targetConfig);

async function copyTibberWeekData() {
  try {
    console.log('Testing target connection...');
    await targetInflux.ping(5000);
    console.log('✓ Target database connected');
    
    let totalForecast = 0, totalPrices = 0;
    
    // Copy data day by day to get all hourly data
    for (let day = 0; day < 7; day++) {
      const dayStart = new Date(Date.now() - (day + 1) * 24 * 60 * 60 * 1000).toISOString();
      const dayEnd = new Date(Date.now() - day * 24 * 60 * 60 * 1000).toISOString();
      
      console.log(`Day ${day + 1}: ${dayStart.split('T')[0]}`);
      
      try {
        // Fetch ALL forecast data for this day (no limit)
        const forecast = await sourceInflux.query(`SELECT * FROM "tibber_forecast" WHERE time >= '${dayStart}' AND time < '${dayEnd}'`);
        
        if (forecast.length > 0) {
          await targetInflux.writePoints(forecast.map(record => ({
            measurement: 'tibber_forecast',
            timestamp: new Date(record.time),
            fields: {
              currency: record.currency,
              energy: record.energy,
              level: record.level,
              tax: record.tax,
              total: record.total
            }
          })));
          totalForecast += forecast.length;
          console.log(`  ✓ ${forecast.length} forecast records`);
        }
        
        // Fetch ALL prices data for this day (no limit)
        const prices = await sourceInflux.query(`SELECT * FROM "tibber_prices" WHERE time >= '${dayStart}' AND time < '${dayEnd}'`);
        
        if (prices.length > 0) {
          await targetInflux.writePoints(prices.map(record => ({
            measurement: 'tibber_prices',
            timestamp: new Date(record.time),
            fields: Object.fromEntries(
              Object.entries(record).filter(([key]) => key !== 'time')
            )
          })));
          totalPrices += prices.length;
          console.log(`  ✓ ${prices.length} price records`);
        }
        
        // Small delay between days to avoid overwhelming the source
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (dayError) {
        console.log(`  ⚠️  Day ${day + 1} failed:`, dayError.message);
      }
    }
    
    return { forecast: totalForecast, prices: totalPrices };
  } catch (error) {
    console.error('Error copying Tibber data:', error);
    throw error;
  }
}

// Execute copy
copyTibberWeekData()
  .then(result => {
    console.log('\n🎉 Data copy completed successfully!');
    console.log(`Copied ${result.forecast} forecast records`);
    console.log(`Copied ${result.prices} price records`);
  })
  .catch(console.error);

module.exports = { copyTibberWeekData };