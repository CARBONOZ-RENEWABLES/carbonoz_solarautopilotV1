// pricingApis.js

/**
 * Global Electricity Pricing API integrations for dynamic pricing feature
 * This module provides integrations with various electricity pricing APIs worldwide
 */

const axios = require('axios');
const moment = require('moment-timezone');

/**
 * Global country configuration with timezones and market operators
 */
const COUNTRY_CONFIG = {
  // Europe
  'DE': { timezone: 'Europe/Berlin', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'FR': { timezone: 'Europe/Paris', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'ES': { timezone: 'Europe/Madrid', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'IT': { timezone: 'Europe/Rome', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'UK': { timezone: 'Europe/London', market: 'ENTSO-E', currency: 'GBP', operator: 'National Grid ESO' },
  'NL': { timezone: 'Europe/Amsterdam', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'BE': { timezone: 'Europe/Brussels', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'AT': { timezone: 'Europe/Vienna', market: 'AWATTAR', currency: 'EUR', operator: 'aWATTar' },
  'CH': { timezone: 'Europe/Zurich', market: 'ENTSO-E', currency: 'CHF', operator: 'Swissgrid' },
  'DK': { timezone: 'Europe/Copenhagen', market: 'NORDPOOL', currency: 'DKK', operator: 'Nordpool' },
  'NO': { timezone: 'Europe/Oslo', market: 'NORDPOOL', currency: 'NOK', operator: 'Nordpool' },
  'SE': { timezone: 'Europe/Stockholm', market: 'NORDPOOL', currency: 'SEK', operator: 'Nordpool' },
  'FI': { timezone: 'Europe/Helsinki', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'PL': { timezone: 'Europe/Warsaw', market: 'ENTSO-E', currency: 'PLN', operator: 'ENTSO-E' },
  'CZ': { timezone: 'Europe/Prague', market: 'ENTSO-E', currency: 'CZK', operator: 'ENTSO-E' },
  'SK': { timezone: 'Europe/Bratislava', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'HU': { timezone: 'Europe/Budapest', market: 'ENTSO-E', currency: 'HUF', operator: 'ENTSO-E' },
  'RO': { timezone: 'Europe/Bucharest', market: 'ENTSO-E', currency: 'RON', operator: 'ENTSO-E' },
  'BG': { timezone: 'Europe/Sofia', market: 'ENTSO-E', currency: 'BGN', operator: 'ENTSO-E' },
  'GR': { timezone: 'Europe/Athens', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'PT': { timezone: 'Europe/Lisbon', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'IE': { timezone: 'Europe/Dublin', market: 'SEMO', currency: 'EUR', operator: 'SEMO' },
  'EE': { timezone: 'Europe/Tallinn', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'LV': { timezone: 'Europe/Riga', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'LT': { timezone: 'Europe/Vilnius', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'SI': { timezone: 'Europe/Ljubljana', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'HR': { timezone: 'Europe/Zagreb', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'RS': { timezone: 'Europe/Belgrade', market: 'SEEPEX', currency: 'RSD', operator: 'SEEPEX' },
  'BA': { timezone: 'Europe/Sarajevo', market: 'SEEPEX', currency: 'BAM', operator: 'SEEPEX' },
  'MK': { timezone: 'Europe/Skopje', market: 'SEEPEX', currency: 'MKD', operator: 'SEEPEX' },
  'AL': { timezone: 'Europe/Tirane', market: 'SEEPEX', currency: 'ALL', operator: 'SEEPEX' },
  'ME': { timezone: 'Europe/Podgorica', market: 'SEEPEX', currency: 'EUR', operator: 'SEEPEX' },
  'IS': { timezone: 'Atlantic/Reykjavik', market: 'NORDPOOL', currency: 'ISK', operator: 'Nordpool' },
  
  // North America
  'US': { timezone: 'America/New_York', market: 'PJM', currency: 'USD', operator: 'PJM/CAISO/ERCOT' },
  'CA': { timezone: 'America/Toronto', market: 'IESO', currency: 'CAD', operator: 'IESO/AESO' },
  'MX': { timezone: 'America/Mexico_City', market: 'CENACE', currency: 'MXN', operator: 'CENACE' },
  
  // South America
  'BR': { timezone: 'America/Sao_Paulo', market: 'ONS', currency: 'BRL', operator: 'ONS' },
  'AR': { timezone: 'America/Argentina/Buenos_Aires', market: 'CAMMESA', currency: 'ARS', operator: 'CAMMESA' },
  'CL': { timezone: 'America/Santiago', market: 'CNE', currency: 'CLP', operator: 'Coordinador Eléctrico Nacional' },
  'CO': { timezone: 'America/Bogota', market: 'XM', currency: 'COP', operator: 'XM' },
  'PE': { timezone: 'America/Lima', market: 'COES', currency: 'PEN', operator: 'COES' },
  'UY': { timezone: 'America/Montevideo', market: 'UTE', currency: 'UYU', operator: 'UTE' },
  'PY': { timezone: 'America/Asuncion', market: 'ANDE', currency: 'PYG', operator: 'ANDE' },
  'BO': { timezone: 'America/La_Paz', market: 'CNDC', currency: 'BOB', operator: 'CNDC' },
  'EC': { timezone: 'America/Guayaquil', market: 'CENACE_EC', currency: 'USD', operator: 'CENACE Ecuador' },
  'VE': { timezone: 'America/Caracas', market: 'CORPOELEC', currency: 'VES', operator: 'CORPOELEC' },
  
  // Asia-Pacific
  'AU': { timezone: 'Australia/Sydney', market: 'AEMO', currency: 'AUD', operator: 'AEMO' },
  'NZ': { timezone: 'Pacific/Auckland', market: 'EA', currency: 'NZD', operator: 'Electricity Authority' },
  'JP': { timezone: 'Asia/Tokyo', market: 'JEPX', currency: 'JPY', operator: 'JEPX' },
  'KR': { timezone: 'Asia/Seoul', market: 'KPX', currency: 'KRW', operator: 'KPX' },
  'CN': { timezone: 'Asia/Shanghai', market: 'SGCC', currency: 'CNY', operator: 'State Grid' },
  'IN': { timezone: 'Asia/Kolkata', market: 'IEX', currency: 'INR', operator: 'IEX' },
  'SG': { timezone: 'Asia/Singapore', market: 'EMC', currency: 'SGD', operator: 'EMC' },
  'MY': { timezone: 'Asia/Kuala_Lumpur', market: 'TNB', currency: 'MYR', operator: 'TNB' },
  'TH': { timezone: 'Asia/Bangkok', market: 'EGAT', currency: 'THB', operator: 'EGAT' },
  'PH': { timezone: 'Asia/Manila', market: 'WESM', currency: 'PHP', operator: 'WESM' },
  'ID': { timezone: 'Asia/Jakarta', market: 'PLN', currency: 'IDR', operator: 'PLN' },
  'VN': { timezone: 'Asia/Ho_Chi_Minh', market: 'EVN', currency: 'VND', operator: 'EVN' },
  'HK': { timezone: 'Asia/Hong_Kong', market: 'CLP', currency: 'HKD', operator: 'CLP/HEC' },
  'TW': { timezone: 'Asia/Taipei', market: 'TAIPOWER', currency: 'TWD', operator: 'Taipower' },
  'PK': { timezone: 'Asia/Karachi', market: 'NPCC', currency: 'PKR', operator: 'NPCC' },
  'BD': { timezone: 'Asia/Dhaka', market: 'BPDB', currency: 'BDT', operator: 'BPDB' },
  'LK': { timezone: 'Asia/Colombo', market: 'CEB', currency: 'LKR', operator: 'CEB' },
  
  // Middle East
  'SA': { timezone: 'Asia/Riyadh', market: 'SEC', currency: 'SAR', operator: 'SEC' },
  'AE': { timezone: 'Asia/Dubai', market: 'ADWEC', currency: 'AED', operator: 'ADWEC/DEWA' },
  'QA': { timezone: 'Asia/Qatar', market: 'KAHRAMAA', currency: 'QAR', operator: 'KAHRAMAA' },
  'KW': { timezone: 'Asia/Kuwait', market: 'MEW', currency: 'KWD', operator: 'MEW' },
  'BH': { timezone: 'Asia/Bahrain', market: 'EWA', currency: 'BHD', operator: 'EWA' },
  'OM': { timezone: 'Asia/Muscat', market: 'OPWP', currency: 'OMR', operator: 'OPWP' },
  'IL': { timezone: 'Asia/Jerusalem', market: 'IEC', currency: 'ILS', operator: 'IEC' },
  'JO': { timezone: 'Asia/Amman', market: 'NEPCO', currency: 'JOD', operator: 'NEPCO' },
  'LB': { timezone: 'Asia/Beirut', market: 'EDL', currency: 'LBP', operator: 'EDL' },
  'TR': { timezone: 'Europe/Istanbul', market: 'EPIAS', currency: 'TRY', operator: 'EPİAŞ' },
  'IR': { timezone: 'Asia/Tehran', market: 'IGMC', currency: 'IRR', operator: 'IGMC' },
  
  // Africa
  'ZA': { timezone: 'Africa/Johannesburg', market: 'ESKOM', currency: 'ZAR', operator: 'Eskom' },
  'EG': { timezone: 'Africa/Cairo', market: 'EETC', currency: 'EGP', operator: 'EETC' },
  'NG': { timezone: 'Africa/Lagos', market: 'NBET', currency: 'NGN', operator: 'NBET' },
  'KE': { timezone: 'Africa/Nairobi', market: 'KPLC', currency: 'KES', operator: 'KPLC' },
  'GH': { timezone: 'Africa/Accra', market: 'ECG', currency: 'GHS', operator: 'ECG' },
  'MA': { timezone: 'Africa/Casablanca', market: 'ONEE', currency: 'MAD', operator: 'ONEE' },
  'TN': { timezone: 'Africa/Tunis', market: 'STEG', currency: 'TND', operator: 'STEG' },
  'DZ': { timezone: 'Africa/Algiers', market: 'SONELGAZ', currency: 'DZD', operator: 'SONELGAZ' },
  'ET': { timezone: 'Africa/Addis_Ababa', market: 'EEP', currency: 'ETB', operator: 'EEP' },
  'TZ': { timezone: 'Africa/Dar_es_Salaam', market: 'TANESCO', currency: 'TZS', operator: 'TANESCO' },
  'UG': { timezone: 'Africa/Kampala', market: 'UETCL', currency: 'UGX', operator: 'UETCL' },
  'ZW': { timezone: 'Africa/Harare', market: 'ZETDC', currency: 'USD', operator: 'ZETDC' },
  'BW': { timezone: 'Africa/Gaborone', market: 'BPC', currency: 'BWP', operator: 'BPC' },
  'NA': { timezone: 'Africa/Windhoek', market: 'NAMPOWER', currency: 'NAD', operator: 'NamPower' },
  'MU': { timezone: 'Indian/Mauritius', market: 'CEB_MU', currency: 'MUR', operator: 'CEB Mauritius' },
  'SC': { timezone: 'Indian/Mahe', market: 'PUC', currency: 'SCR', operator: 'PUC' },
  'MG': { timezone: 'Indian/Antananarivo', market: 'JIRAMA', currency: 'MGA', operator: 'JIRAMA' },
  
  // Caribbean
  'KY': { timezone: 'America/Cayman', market: 'CUC', currency: 'KYD', operator: 'Caribbean Utilities Company' },
  'JM': { timezone: 'America/Jamaica', market: 'JPS', currency: 'JMD', operator: 'JPS' },
  'BB': { timezone: 'America/Barbados', market: 'BL&P', currency: 'BBD', operator: 'Barbados Light & Power' },
  'TT': { timezone: 'America/Port_of_Spain', market: 'T&TEC', currency: 'TTD', operator: 'T&TEC' },
  'BS': { timezone: 'America/Nassau', market: 'BPL', currency: 'BSD', operator: 'Bahamas Power & Light' },
  'BM': { timezone: 'Atlantic/Bermuda', market: 'BELCO', currency: 'BMD', operator: 'BELCO' },
  'CU': { timezone: 'America/Havana', market: 'UNE', currency: 'CUP', operator: 'Unión Eléctrica' },
  'DO': { timezone: 'America/Santo_Domingo', market: 'CDEEE', currency: 'DOP', operator: 'CDEEE' },
  'PR': { timezone: 'America/Puerto_Rico', market: 'PREPA', currency: 'USD', operator: 'PREPA' },
  
  // Pacific Islands
  'FJ': { timezone: 'Pacific/Fiji', market: 'EFL', currency: 'FJD', operator: 'Energy Fiji Limited' },
  'PG': { timezone: 'Pacific/Port_Moresby', market: 'PPL', currency: 'PGK', operator: 'PNG Power' },
  'NC': { timezone: 'Pacific/Noumea', market: 'EEC', currency: 'XPF', operator: 'EEC' },
  'PF': { timezone: 'Pacific/Tahiti', market: 'EDT', currency: 'XPF', operator: 'EDT' },
  'GU': { timezone: 'Pacific/Guam', market: 'GPA', currency: 'USD', operator: 'Guam Power Authority' },
  
  // Additional territories and dependencies
  'MT': { timezone: 'Europe/Malta', market: 'ENEMALTA', currency: 'EUR', operator: 'Enemalta' },
  'CY': { timezone: 'Asia/Nicosia', market: 'EAC', currency: 'EUR', operator: 'EAC' },
  'LU': { timezone: 'Europe/Luxembourg', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'IS': { timezone: 'Atlantic/Reykjavik', market: 'LANDSVIRKJUN', currency: 'ISK', operator: 'Landsvirkjun' },
  'AD': { timezone: 'Europe/Andorra', market: 'FEDA', currency: 'EUR', operator: 'FEDA' },
  'MC': { timezone: 'Europe/Monaco', market: 'SMEG', currency: 'EUR', operator: 'SMEG' },
  'SM': { timezone: 'Europe/San_Marino', market: 'AASS', currency: 'EUR', operator: 'AASS' },
  'VA': { timezone: 'Europe/Vatican', market: 'SCV', currency: 'EUR', operator: 'Vatican' },
  'LI': { timezone: 'Europe/Vaduz', market: 'LKW', currency: 'CHF', operator: 'LKW' }
};

/**
 * ENTSO-E area codes for European countries
 */
const ENTSO_E_AREA_CODES = {
  'DE': '10Y1001A1001A83F', // Germany
  'FR': '10Y1001A1001A39I', // France
  'ES': '10YES-REE------0', // Spain
  'IT': '10Y1001A1001A73I', // Italy
  'UK': '10Y1001A1001A92E', // UK
  'NL': '10Y1001A1001A16H', // Netherlands
  'BE': '10YBE----------2', // Belgium
  'AT': '10YAT-APG------L', // Austria
  'CH': '10YCH-SWISSGRIDZ', // Switzerland
  'DK': '10Y1001A1001A65H', // Denmark
  'NO': '10YNO-0--------C', // Norway
  'SE': '10YSE-1--------K', // Sweden
  'FI': '10YFI-1--------U', // Finland
  'PL': '10YPL-AREA-----S', // Poland
  'CZ': '10YCZ-CEPS-----N', // Czech Republic
  'SK': '10YSK-SEPS-----K', // Slovakia
  'HU': '10YHU-MAVIR----U', // Hungary
  'RO': '10YRO-TEL------P', // Romania
  'BG': '10YCA-BULGARIA-R', // Bulgaria
  'GR': '10YGR-HTSO-----Y', // Greece
  'PT': '10YPT-REN------W', // Portugal
  'IE': '10Y1001A1001A59C', // Ireland
  'EE': '10Y1001A1001A39I', // Estonia
  'LV': '10YLV-1001A00074', // Latvia
  'LT': '10YLT-1001A0008Q', // Lithuania
  'SI': '10YSI-ELES-----O', // Slovenia
  'HR': '10YHR-HEP------M', // Croatia
  'MT': '10Y1001A1001A93C', // Malta
  'CY': '10YCY-1001A0003J', // Cyprus
  'LU': '10YLU-CEGEDEL-NQ'  // Luxembourg
};

/**
 * Fetch electricity prices from ENTSO-E API
 * @param {Object} config - Configuration with apiKey and country settings
 * @returns {Array} Price data points
 */
async function fetchEntsoeElectricityPrices(config) {
  if (!config.apiKey) {
    console.error('API key for ENTSO-E is missing');
    return [];
  }
  
  try {
    const countryConfig = COUNTRY_CONFIG[config.country] || COUNTRY_CONFIG['DE'];
    const timezone = countryConfig.timezone;
    
    const today = moment().tz(timezone).format('YYYYMMDD');
    const tomorrow = moment().tz(timezone).add(1, 'day').format('YYYYMMDD');
    
    const areaCode = ENTSO_E_AREA_CODES[config.country] || ENTSO_E_AREA_CODES['DE'];
    
    const url = `https://transparency.entsoe.eu/api?documentType=A44&in_Domain=${areaCode}&out_Domain=${areaCode}&periodStart=${today}0000&periodEnd=${tomorrow}2300&securityToken=${config.apiKey}`;
    
    const response = await axios.get(url, { 
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000
    });
    
    return parseEntsoeXmlResponse(response.data, timezone, countryConfig.currency);
  } catch (error) {
    console.error('Error fetching ENTSO-E electricity prices:', error.message);
    return generateSamplePriceData(config.country);
  }
}

/**
 * Parse ENTSO-E XML response with timezone support
 * @param {String} xmlData - XML data from ENTSO-E API
 * @param {String} timezone - Target timezone
 * @param {String} currency - Currency code
 * @returns {Array} Parsed price data points
 */
function parseEntsoeXmlResponse(xmlData, timezone, currency) {
  try {
    const prices = [];
    
    const timePeriodPattern = /<time_Period>\s*<timeInterval>\s*<start>(.*?)<\/start>\s*<end>(.*?)<\/end>\s*<\/timeInterval>\s*<\/time_Period>/s;
    const timePeriodMatch = xmlData.match(timePeriodPattern);
    
    if (!timePeriodMatch) {
      console.error('Failed to extract time period from ENTSO-E response');
      return [];
    }
    
    const startTime = moment.tz(timePeriodMatch[1], timezone);
    
    const pointPattern = /<Point>\s*<position>(.*?)<\/position>\s*<price\.amount>(.*?)<\/price\.amount>\s*<\/Point>/g;
    let pointMatch;
    
    while ((pointMatch = pointPattern.exec(xmlData)) !== null) {
      const position = parseInt(pointMatch[1]);
      const priceAmount = parseFloat(pointMatch[2]);
      
      // Convert from EUR/MWh to local currency per kWh
      const pricePerKwh = priceAmount / 1000;
      
      const timestamp = moment(startTime).add(position - 1, 'hours');
      
      prices.push({
        timestamp: timestamp.toISOString(),
        price: pricePerKwh,
        currency: currency,
        unit: 'kWh',
        timezone: timezone
      });
    }
    
    return prices.length > 0 ? prices : generateSamplePriceData();
  } catch (error) {
    console.error('Error parsing ENTSO-E XML response:', error.message);
    return generateSamplePriceData();
  }
}

/**
 * Fetch prices from AWATTAR API (Germany and Austria)
 * @param {Object} config - Configuration with country settings
 * @returns {Array} Price data points
 */
async function fetchAwattarPrices(config) {
  try {
    const countryConfig = COUNTRY_CONFIG[config.country];
    const countryDomain = config.country.toLowerCase() === 'at' ? 'at' : 'de';
    const url = `https://api.awattar.${countryDomain}/v1/marketdata`;
    
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data && response.data.data) {
      return response.data.data.map(item => ({
        timestamp: moment(item.start_timestamp).tz(countryConfig.timezone).toISOString(),
        price: item.marketprice / 1000, // Convert from EUR/MWh to EUR/kWh
        currency: countryConfig.currency,
        unit: 'kWh',
        timezone: countryConfig.timezone
      }));
    }
    
    return [];
  } catch (error) {
    console.error('Error fetching aWATTar prices:', error.message);
    return generateSamplePriceData(config.country);
  }
}

/**
 * Fetch prices from Australian Energy Market Operator (AEMO)
 * @param {Object} config - Configuration with state/region settings
 * @returns {Array} Price data points
 */
async function fetchAemoPrices(config) {
  try {
    // AEMO provides wholesale electricity prices for Australian states
    // For a real implementation, you would need to use AEMO's API
    // States: NSW, VIC, QLD, SA, WA, TAS, NT, ACT
    
    const stateMap = {
      'NSW': 'NSW1',
      'VIC': 'VIC1', 
      'QLD': 'QLD1',
      'SA': 'SA1',
      'WA': 'WA1',
      'TAS': 'TAS1',
      'NT': 'NT1',
      'ACT': 'ACT1'
    };
    
    console.warn('AEMO API integration not fully implemented, returning sample data');
    return generateSamplePriceData('AU');
  } catch (error) {
    console.error('Error fetching AEMO prices:', error.message);
    return generateSamplePriceData('AU');
  }
}

/**
 * Fetch prices for US markets (PJM, CAISO, ERCOT, etc.)
 * @param {Object} config - Configuration with market settings
 * @returns {Array} Price data points
 */
async function fetchUsPrices(config) {
  try {
    // Different US markets:
    // PJM - Mid-Atlantic and Midwest
    // CAISO - California
    // ERCOT - Texas
    // NYISO - New York
    // ISO-NE - New England
    // MISO - Midwest
    // SPP - Southwest Power Pool
    
    console.warn('US market APIs not fully implemented, returning sample data');
    return generateSamplePriceData('US');
  } catch (error) {
    console.error('Error fetching US electricity prices:', error.message);
    return generateSamplePriceData('US');
  }
}

/**
 * Fetch prices for emerging markets and developing countries
 * @param {Object} config - Configuration with country settings
 * @returns {Array} Price data points
 */
async function fetchEmergingMarketPrices(config) {
  try {
    // Many emerging markets don't have real-time pricing APIs
    // This would typically involve:
    // 1. Government utility websites
    // 2. Regional power pool data
    // 3. Third-party data providers
    
    console.warn(`${config.country} market API not fully implemented, returning sample data`);
    return generateSamplePriceData(config.country);
  } catch (error) {
    console.error(`Error fetching ${config.country} electricity prices:`, error.message);
    return generateSamplePriceData(config.country);
  }
}

/**
 * Generate sample price data for testing or fallback with country-specific patterns
 * @param {String} countryCode - ISO country code
 * @returns {Array} Sample price data points
 */
function generateSamplePriceData(countryCode = 'DE') {
  const prices = [];
  const countryConfig = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG['DE'];
  const timezone = countryConfig.timezone;
  const currency = countryConfig.currency;
  
  const now = moment().tz(timezone).startOf('hour');
  
  // Country-specific price patterns
  const pricePatterns = {
    // High-cost countries
    'DE': { base: 0.30, peak: 0.45, valley: 0.20 },
    'DK': { base: 0.28, peak: 0.42, valley: 0.18 },
    'BE': { base: 0.26, peak: 0.38, valley: 0.16 },
    
    // Medium-cost countries  
    'US': { base: 0.12, peak: 0.18, valley: 0.08 },
    'CA': { base: 0.10, peak: 0.15, valley: 0.06 },
    'AU': { base: 0.20, peak: 0.30, valley: 0.12 },
    'UK': { base: 0.22, peak: 0.32, valley: 0.14 },
    'JP': { base: 0.25, peak: 0.35, valley: 0.18 },
    'KR': { base: 0.10, peak: 0.15, valley: 0.07 },
    
    // Low-cost countries
    'ZA': { base: 0.08, peak: 0.12, valley: 0.05 },
    'MX': { base: 0.09, peak: 0.13, valley: 0.06 },
    'BR': { base: 0.15, peak: 0.22, valley: 0.10 },
    'IN': { base: 0.07, peak: 0.10, valley: 0.04 },
    'CN': { base: 0.08, peak: 0.12, valley: 0.05 },
    'RU': { base: 0.05, peak: 0.08, valley: 0.03 },
    
    // Caribbean and Island nations (typically higher due to import costs)
    'KY': { base: 0.25, peak: 0.35, valley: 0.18 }, // Cayman Islands
    'MU': { base: 0.20, peak: 0.28, valley: 0.15 }, // Mauritius
    'JM': { base: 0.30, peak: 0.42, valley: 0.22 }, // Jamaica
    'BB': { base: 0.32, peak: 0.45, valley: 0.24 }, // Barbados
    'BS': { base: 0.28, peak: 0.38, valley: 0.20 }, // Bahamas
    'BM': { base: 0.40, peak: 0.55, valley: 0.30 }, // Bermuda
    'FJ': { base: 0.22, peak: 0.30, valley: 0.16 }, // Fiji
    
    // Middle East (often subsidized)
    'SA': { base: 0.05, peak: 0.08, valley: 0.03 },
    'AE': { base: 0.06, peak: 0.09, valley: 0.04 },
    'QA': { base: 0.04, peak: 0.06, valley: 0.03 },
    'KW': { base: 0.03, peak: 0.05, valley: 0.02 },
    
    // Nordic countries (hydro-heavy)
    'NO': { base: 0.15, peak: 0.20, valley: 0.08 },
    'SE': { base: 0.18, peak: 0.25, valley: 0.10 },
    'FI': { base: 0.16, peak: 0.22, valley: 0.12 },
    'IS': { base: 0.12, peak: 0.16, valley: 0.08 },
    
    // African countries
    'NG': { base: 0.06, peak: 0.09, valley: 0.04 },
    'KE': { base: 0.12, peak: 0.18, valley: 0.08 },
    'GH': { base: 0.10, peak: 0.15, valley: 0.07 },
    'EG': { base: 0.04, peak: 0.06, valley: 0.03 },
    'MA': { base: 0.11, peak: 0.16, valley: 0.08 },
    'ET': { base: 0.03, peak: 0.05, valley: 0.02 }
  };
  
  const pattern = pricePatterns[countryCode] || pricePatterns['DE'];
  
  // Generate 48 hourly price points (24 hours x 2 days)
  for (let i = 0; i < 48; i++) {
    const timestamp = moment(now).add(i, 'hours');
    
    // Create realistic price patterns based on local conditions
    const hour = timestamp.hour();
    const isWeekend = timestamp.day() === 0 || timestamp.day() === 6;
    const dayOfYear = timestamp.dayOfYear();
    
    let basePrice = pattern.base;
    
    // Time-of-day pricing
    if (hour >= 7 && hour <= 9) {
      // Morning peak
      basePrice = pattern.peak;
    } else if (hour >= 17 && hour <= 21) {
      // Evening peak  
      basePrice = pattern.peak;
    } else if (hour >= 1 && hour <= 5) {
      // Night valley
      basePrice = pattern.valley;
    } else if (hour >= 11 && hour <= 14) {
      // Midday (varies by solar penetration)
      const solarCountries = ['AU', 'ES', 'IT', 'GR', 'SA', 'AE', 'ZA', 'CL'];
      if (solarCountries.includes(countryCode)) {
        basePrice = pattern.valley; // Solar abundance
      } else {
        basePrice = pattern.base;
      }
    }
    
    // Weekend patterns
    if (isWeekend) {
      basePrice *= 0.85; // Generally lower demand
    }
    
    // Seasonal variations
    const isWinter = (dayOfYear < 80) || (dayOfYear > 350); // Rough winter months
    const isSummer = (dayOfYear > 150) && (dayOfYear < 250); // Rough summer months
    
    if (isWinter) {
      // Higher prices in winter for heating-dominant countries
      const heatingCountries = ['DE', 'NO', 'SE', 'FI', 'PL', 'RU', 'CA', 'US'];
      if (heatingCountries.includes(countryCode)) {
        basePrice *= 1.2;
      }
    } else if (isSummer) {
      // Higher prices in summer for cooling-dominant countries
      const coolingCountries = ['SA', 'AE', 'QA', 'KW', 'US', 'AU', 'MX', 'IN'];
      if (coolingCountries.includes(countryCode)) {
        basePrice *= 1.15;
      }
    }
    
    // Add market volatility (-20% to +20%)
    const volatilityFactor = 0.8 + (Math.random() * 0.4);
    const finalPrice = basePrice * volatilityFactor;
    
    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(finalPrice.toFixed(4)),
      currency: currency,
      unit: 'kWh',
      timezone: timezone,
      market: countryConfig.operator
    });
  }
  
  return prices;
}

/**
 * Get currency exchange rate for price conversion
 * @param {String} fromCurrency - Source currency
 * @param {String} toCurrency - Target currency  
 * @returns {Number} Exchange rate
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1.0;
  
  try {
    // In a real implementation, you'd use a currency API like:
    // - ExchangeRate-API
    // - Fixer.io
    // - CurrencyLayer
    // - Alpha Vantage
    
    // For now, return approximate rates (would need real-time data)
    const exchangeRates = {
      'EUR': { 'USD': 1.08, 'GBP': 0.86, 'JPY': 158, 'CAD': 1.47, 'AUD': 1.65, 'CHF': 0.94 },
      'USD': { 'EUR': 0.93, 'GBP': 0.79, 'JPY': 146, 'CAD': 1.36, 'AUD': 1.53, 'CHF': 0.87 },
      'GBP': { 'EUR': 1.16, 'USD': 1.27, 'JPY': 185, 'CAD': 1.73, 'AUD': 1.94, 'CHF': 1.10 }
    };
    
    if (exchangeRates[fromCurrency] && exchangeRates[fromCurrency][toCurrency]) {
      return exchangeRates[fromCurrency][toCurrency];
    }
    
    return 1.0; // Fallback
  } catch (error) {
    console.error('Error fetching exchange rate:', error.message);
    return 1.0;
  }
}

/**
 * Convert prices to different currency
 * @param {Array} prices - Price data points
 * @param {String} targetCurrency - Target currency code
 * @returns {Array} Converted price data points
 */
async function convertPricesToCurrency(prices, targetCurrency) {
  if (!prices.length) return prices;
  
  const sourceCurrency = prices[0].currency;
  if (sourceCurrency === targetCurrency) return prices;
  
  const exchangeRate = await getExchangeRate(sourceCurrency, targetCurrency);
  
  return prices.map(pricePoint => ({
    ...pricePoint,
    price: parseFloat((pricePoint.price * exchangeRate).toFixed(4)),
    currency: targetCurrency,
    originalPrice: pricePoint.price,
    originalCurrency: sourceCurrency,
    exchangeRate: exchangeRate
  }));
}

/**
 * Main function to fetch electricity prices from the appropriate source
 * @param {Object} config - Configuration object with API settings
 * @returns {Array} Price data points
 */
async function fetchElectricityPrices(config) {
  const countryCode = config.country || 'DE';
  const countryConfig = COUNTRY_CONFIG[countryCode];
  
  if (!countryConfig) {
    console.warn(`Country ${countryCode} not supported, using sample data`);
    return generateSamplePriceData(countryCode);
  }
  
  let prices = [];
  
  try {
    // Route to appropriate market API based on country configuration
    switch (countryConfig.market) {
      case 'ENTSO-E':
        prices = await fetchEntsoeElectricityPrices(config);
        break;
        
      case 'AWATTAR':
        prices = await fetchAwattarPrices(config);
        break;
        
      case 'NORDPOOL':
        prices = await fetchNordpoolPrices(config);
        break;
        
      case 'AEMO':
        prices = await fetchAemoPrices(config);
        break;
        
      case 'PJM':
      case 'CAISO':
      case 'ERCOT':
      case 'NYISO':
      case 'ISO-NE':
      case 'MISO':
      case 'SPP':
        prices = await fetchUsPrices(config);
        break;
        
      case 'IESO':
      case 'AESO':
        prices = await fetchCanadianPrices(config);
        break;
        
      default:
        // For countries without specific API implementations
        prices = await fetchEmergingMarketPrices(config);
        break;
    }
    
    // Fallback to sample data if API fails
    if (!prices || prices.length === 0) {
      console.warn(`No data returned from ${countryConfig.market}, using sample data`);
      prices = generateSamplePriceData(countryCode);
    }
    
    // Convert currency if requested
    if (config.targetCurrency && config.targetCurrency !== countryConfig.currency) {
      prices = await convertPricesToCurrency(prices, config.targetCurrency);
    }
    
    // Add metadata
    prices = prices.map(price => ({
      ...price,
      country: countryCode,
      market: countryConfig.market,
      operator: countryConfig.operator
    }));
    
    return prices;
    
  } catch (error) {
    console.error(`Error fetching electricity prices for ${countryCode}:`, error.message);
    return generateSamplePriceData(countryCode);
  }
}

/**
 * Fetch prices for Canadian markets
 * @param {Object} config - Configuration with province settings
 * @returns {Array} Price data points
 */
async function fetchCanadianPrices(config) {
  try {
    // Canadian provinces have different market operators:
    // Ontario - IESO
    // Alberta - AESO  
    // Others typically have regulated rates
    
    console.warn('Canadian market APIs not fully implemented, returning sample data');
    return generateSamplePriceData('CA');
  } catch (error) {
    console.error('Error fetching Canadian electricity prices:', error.message);
    return generateSamplePriceData('CA');
  }
}

/**
 * Fetch prices from Nordpool API (Nordic and Baltic countries)
 * @param {Object} config - Configuration with country settings
 * @returns {Array} Price data points
 */
async function fetchNordpoolPrices(config) {
  try {
    // Nordpool areas: NO1-NO5, SE1-SE4, FI, DK1, DK2, EE, LV, LT
    // For a real implementation, you would need:
    // 1. Commercial API access to Nordpool data
    // 2. Web scraping (with permission)
    // 3. Third-party data provider
    
    console.warn('Nordpool API not fully implemented, returning sample data');
    return generateSamplePriceData(config.country);
  } catch (error) {
    console.error('Error fetching Nordpool prices:', error.message);
    return generateSamplePriceData(config.country);
  }
}

/**
 * Get supported countries and their market information
 * @returns {Object} Country configuration data
 */
function getSupportedCountries() {
  return Object.keys(COUNTRY_CONFIG).map(countryCode => ({
    code: countryCode,
    ...COUNTRY_CONFIG[countryCode]
  }));
}

/**
 * Validate country code and configuration
 * @param {String} countryCode - ISO country code
 * @returns {Boolean} Whether country is supported
 */
function isCountrySupported(countryCode) {
  return COUNTRY_CONFIG.hasOwnProperty(countryCode);
}

/**
 * Get timezone for a country
 * @param {String} countryCode - ISO country code
 * @returns {String} Timezone identifier
 */
function getCountryTimezone(countryCode) {
  const config = COUNTRY_CONFIG[countryCode];
  return config ? config.timezone : 'UTC';
}

/**
 * Get market operator for a country
 * @param {String} countryCode - ISO country code
 * @returns {String} Market operator name
 */
function getMarketOperator(countryCode) {
  const config = COUNTRY_CONFIG[countryCode];
  return config ? config.operator : 'Unknown';
}

module.exports = {
  fetchElectricityPrices,
  fetchEntsoeElectricityPrices,
  fetchAwattarPrices,
  fetchNordpoolPrices,
  fetchAemoPrices,
  fetchUsPrices,
  fetchCanadianPrices,
  fetchEmergingMarketPrices,
  generateSamplePriceData,
  convertPricesToCurrency,
  getExchangeRate,
  getSupportedCountries,
  isCountrySupported,
  getCountryTimezone,
  getMarketOperator,
  COUNTRY_CONFIG,
  ENTSO_E_AREA_CODES
};