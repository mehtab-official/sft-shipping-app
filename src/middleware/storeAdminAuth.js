'use strict';

/**
 * Per-store HTTP Basic Auth middleware for /admin/:shopDomain/* routes.
 *
 * For each request:
 *  1. Reads :shopDomain from req.params.shopDomain.
 *  2. Calls storeRegistry.findStoreFull(shopDomain) — returns 404 if not found.
 *  3. Decodes the Authorization: Basic <base64> header — returns 401 + WWW-Authenticate if absent.
 *  4. Runs bcryptjs.compare(submittedPassword, record.passwordHash) — returns 401 if false.
 *  5. Sets req.storeRecord = record so downstream handlers don't re-query.
 *
 * This ensures credentials for store A cannot authenticate to store B's routes:
 * the hash in step 4 comes from B's Store_Record, not A's.
 */

const bcrypt = require('bcryptjs');
const storeRegistry = require('../services/storeRegistry');

/**
 * Express middleware that authenticates a request against the per-store
 * bcrypt password hash stored in the Store_Record.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function storeAdminAuth(req, res, next) {
  const { shopDomain } = req.params;

  // Step 1 & 2: Look up the store record (full, including passwordHash)
  const record = storeRegistry.findStoreFull(shopDomain);
  if (!record) {
    return res.status(404).json({ error: 'Store not found' });
  }

  // Step 3: Decode Authorization: Basic <base64> header
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required');
  }

  const base64Credentials = auth.slice('Basic '.length);
  const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');

  // Split on the first colon — password may contain colons
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required');
  }

  const submittedPassword = decoded.slice(separatorIndex + 1);

  // Step 4: Compare submitted password against the store's bcrypt hash (async)
  const passwordValid = await bcrypt.compare(submittedPassword, record.passwordHash);
  if (!passwordValid) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Invalid credentials');
  }

  // Step 5: Attach the full store record to the request for downstream handlers
  req.storeRecord = record;
  return next();
}

module.exports = storeAdminAuth;
