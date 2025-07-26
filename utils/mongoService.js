const axios = require('axios');

const url = `https://api.carbonoz.com/api/v1/auth/authenticate`;

const AuthenticateUser = async (options) => {
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;
  
  console.log('Attempting Authentication with:', { 
    clientId, 
    clientSecretProvided: !!clientSecret 
  });
  
  try {
    const response = await axios.post(url, {
      clientId: clientId,
      clientSecret: clientSecret,
    }, {
      timeout: 10000, // Add timeout
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Authentication Response:', {
      status: response.status,
      data: response.data
    });
    
    if (response.data && response.data.userId) {
      return response.data.userId;
    }
    return null;
  } catch (error) {
    console.error('Authentication Error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    return null;
  }
};

module.exports = { AuthenticateUser };
