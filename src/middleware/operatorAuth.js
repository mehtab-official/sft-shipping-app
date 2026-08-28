'use strict';

/**
 * Operator API authentication middleware.
 *
 * Protects operator-level routes with a Bearer token read from the
 * `Authorization` header. The expected token is set via the
 * `OPERATOR_API_KEY` environment variable.
 *
 * Behaviour:
 *  - If `OPERATOR_API_KEY` is not set in the environment → 500 (fail-safe)
 *  - If the `Authorization: Bearer <token>` header is missing or the token
 *    does not exactly match `OPERATOR_API_KEY` → 401
 *  - Otherwise → calls next()
 *
 * Validates: Requirements 11.5
 */
function operatorAuth(req, res, next) {
  const apiKey = process.env.OPERATOR_API_KEY;

  // Fail-safe: if the operator key has not been configured, refuse every call
  // with 500 rather than silently granting access.
  if (!apiKey) {
    return res.status(500).json({ error: 'Operator API not configured' });
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length);

  if (token !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = operatorAuth;
