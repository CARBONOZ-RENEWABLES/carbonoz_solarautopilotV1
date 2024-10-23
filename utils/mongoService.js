const axios = require('axios');

const url = `http://192.168.160.190/api/v1/auth/authenticate`;

const AuthenticateUser = async (options) => {
  const clientId = options.clientId;
  const clientSecret = options.clientSecret;

  try {
    const response = await axios.post(url, {
      clientId: clientId,
      clientSecret: clientSecret,
    });

    if (response.data && response.data.userId) {
      return response.data.userId;
    }

    return null;

  } catch (error) {
    console.error('Error authenticating user:', error.message);
    return null;
  }
};

module.exports = { AuthenticateUser };
