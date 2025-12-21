// Production-safe session configuration
const session = require('express-session');

module.exports = session({
  secret: process.env.SESSION_SECRET || 'carbonoz-solar-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: false 
  },
  // Prevent memory leaks by limiting session store
  store: new session.MemoryStore({
    checkPeriod: 86400000 // Prune expired entries every 24h
  })
});