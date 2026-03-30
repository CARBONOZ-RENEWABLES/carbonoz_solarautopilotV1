const axios = require('axios');
const dns = require('dns');
const https = require('https');

// Force IPv4 to avoid IPv6 timeout issues
dns.setDefaultResultOrder('ipv4first');

// Create axios instance with custom agent
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ 
    keepAlive: false,
    family: 4  // Force IPv4
  }),
  timeout: 30000  // Increase timeout to 30 seconds
});

const url = process.env.API_URL || `https://login.carbonoz.com/api/v1/auth/authenticate`;
const subscriptionUrl = process.env.SUBSCRIPTION_URL || `https://login.carbonoz.com/api/v1/billing/me/subscription`;

// Cache authentication results to avoid duplicate calls
const authCache = new Map();
const CACHE_TTL = 60000; // 1 minute

// Subscription status tracking
let subscriptionCheckInterval = null;
let currentSubscriptionStatus = null;
let subscriptionCallbacks = [];

const AuthenticateUser = async (options, retries = 3) => {
  const cacheKey = `${options.clientId}:${options.clientSecret}`;
  const cached = authCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('✅ Using cached authentication');
    return cached.userId;
  }
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;
  
  console.log('Attempting Authentication with:', { 
    clientId, 
    clientSecretProvided: !!clientSecret 
  });
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await axiosInstance.post(url, {
        clientId: clientId,
        clientSecret: clientSecret,
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    
    console.log('Authentication Response:', {
      status: response.status,
      data: response.data
    });
    
    if (response.data && response.data.userId) {
      const userId = response.data.userId;
      
      // Cache successful authentication
      authCache.set(cacheKey, { userId, timestamp: Date.now() });
      
      console.log('✅ Authentication successful for user:', userId);
      return userId;
    }
    return null;
    } catch (error) {
      const isLastAttempt = attempt === retries;
      
      console.error(`Authentication Error (attempt ${attempt + 1}/${retries + 1}):`, {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        code: error.code
      });
      
      // Don't retry on authentication failures (401, 403)
      if (error.response?.status === 401 || error.response?.status === 403) {
        console.error('❌ Invalid credentials');
        return null;
      }
      
      // If timeout or network error and not last attempt, retry
      if (!isLastAttempt && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED')) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.log(`⏳ Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (isLastAttempt) {
        console.error('❌ Authentication failed after all retries');
        return null;
      }
    }
  }
  return null;
};

// Check subscription status - authentication response indicates access
const CheckSubscriptionStatus = async (clientId, clientSecret) => {
  try {
    const response = await axiosInstance.post(url, {
      clientId: clientId,
      clientSecret: clientSecret,
    }, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (response.data && response.data.userId) {
      console.log('Subscription check: User has access');
      currentSubscriptionStatus = {
        hasAccess: true,
        userId: response.data.userId,
        checkedAt: new Date()
      };
      return true;
    }
    
    currentSubscriptionStatus = {
      hasAccess: false,
      checkedAt: new Date(),
      reason: 'no_user_id'
    };
    return false;
  } catch (error) {
    // Don't change status on network errors - keep previous status
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
      console.warn('⚠️  Subscription check timeout/network error - keeping previous status');
      // Return previous status if available
      if (currentSubscriptionStatus && currentSubscriptionStatus.hasAccess !== undefined) {
        return currentSubscriptionStatus.hasAccess;
      }
    }
    
    console.error('Subscription check failed:', error.message);
    currentSubscriptionStatus = {
      hasAccess: false,
      error: error.message,
      checkedAt: new Date()
    };
    return false;
  }
};

// Start periodic subscription checking
const StartSubscriptionMonitoring = (options, onStatusChange) => {
  if (subscriptionCheckInterval) {
    clearInterval(subscriptionCheckInterval);
  }
  
  if (onStatusChange) {
    subscriptionCallbacks.push(onStatusChange);
  }
  
  console.log('🔄 Starting subscription monitoring (checks every 1 minute)');
  
  // Track previous status to detect changes
  let previousStatus = null;
  
  // Do an immediate check to establish initial state
  CheckSubscriptionStatus(options.clientId, options.clientSecret).then(hasAccess => {
    previousStatus = hasAccess;
    console.log(`📊 Initial subscription status: ${hasAccess ? '✅ Active' : '❌ Inactive'}`);
  });
  
  subscriptionCheckInterval = setInterval(async () => {
    console.log('🔍 Checking subscription status...');
    const hasAccess = await CheckSubscriptionStatus(options.clientId, options.clientSecret);
    
    // Detect status change
    const statusChanged = previousStatus !== null && previousStatus !== hasAccess;
    
    if (!hasAccess) {
      if (statusChanged) {
        console.error('❌❌❌ Subscription expired or revoked! ❌❌❌');
      } else {
        console.error('❌ Subscription expired or revoked!');
      }
      
      // Notify all callbacks
      subscriptionCallbacks.forEach(callback => {
        try {
          callback(false);
        } catch (err) {
          console.error('Error in subscription callback:', err);
        }
      });
    } else {
      if (statusChanged) {
        console.log('✅✅✅ Subscription restored! ✅✅✅');
        
        // Notify all callbacks about restoration
        subscriptionCallbacks.forEach(callback => {
          try {
            callback(true);
          } catch (err) {
            console.error('Error in subscription callback:', err);
          }
        });
      } else {
        console.log('✅ Subscription still active');
      }
    }
    
    previousStatus = hasAccess;
  }, CACHE_TTL); // Check every 1 minute
};

// Stop subscription monitoring
const StopSubscriptionMonitoring = () => {
  if (subscriptionCheckInterval) {
    clearInterval(subscriptionCheckInterval);
    subscriptionCheckInterval = null;
    console.log('⏹️  Stopped subscription monitoring');
  }
};

// Get current subscription status
const GetSubscriptionStatus = () => {
  return currentSubscriptionStatus;
};

module.exports = { 
  AuthenticateUser, 
  CheckSubscriptionStatus,
  StartSubscriptionMonitoring,
  StopSubscriptionMonitoring,
  GetSubscriptionStatus
};
