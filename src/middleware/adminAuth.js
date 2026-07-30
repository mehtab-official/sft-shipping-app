/**
 * HTTP Basic Auth gate for the /admin settings page + API.
 * Deliberately simple (no sessions/JWT) since this only needs to keep the
 * currency/divisor settings away from the public internet, not serve a
 * multi-user permission system.
 */

const config = require('../config');

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);

  if (user === config.admin.username && pass === config.admin.password) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Invalid credentials');
}

module.exports = adminAuth;
