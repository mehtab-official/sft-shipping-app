'use strict';

const express = require('express');
const operatorAuth = require('../middleware/operatorAuth');
const storeRegistry = require('../services/storeRegistry');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /operator/stores — register a new store
// ---------------------------------------------------------------------------

/**
 * Registers a new store with the provided credentials.
 *
 * Body: { shop_domain, shopify_admin_api_token, admin_username, admin_password }
 * Response: 201 { shop_domain } | 400 { error } | 409 { error }
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 11.5
 */
router.post('/operator/stores', operatorAuth, (req, res) => {
  const { shop_domain, shopify_admin_api_token, admin_username, admin_password } = req.body || {};

  // Validate all required fields are present and non-empty
  if (!shop_domain || typeof shop_domain !== 'string' || shop_domain.trim() === '') {
    return res.status(400).json({ error: 'shop_domain is required' });
  }
  if (!shopify_admin_api_token || typeof shopify_admin_api_token !== 'string' || shopify_admin_api_token.trim() === '') {
    return res.status(400).json({ error: 'shopify_admin_api_token is required' });
  }
  if (!admin_username || typeof admin_username !== 'string' || admin_username.trim() === '') {
    return res.status(400).json({ error: 'admin_username is required' });
  }
  if (!admin_password || typeof admin_password !== 'string' || admin_password.trim() === '') {
    return res.status(400).json({ error: 'admin_password is required' });
  }

  try {
    storeRegistry.registerStore({
      shopDomain: shop_domain.trim(),
      adminApiToken: shopify_admin_api_token.trim(),
      adminUsername: admin_username.trim(),
      adminPassword: admin_password,
    });

    return res.status(201).json({ shop_domain: shop_domain.trim() });
  } catch (err) {
    if (err instanceof storeRegistry.StoreDuplicateError) {
      return res.status(409).json({ error: 'Store already registered' });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /operator/stores — list all registered stores
// ---------------------------------------------------------------------------

/**
 * Returns all registered stores (no tokens or hashes).
 *
 * Response: 200 [ { shop_domain } ]
 *
 * Validates: Requirements 2.1, 2.3, 11.5
 */
router.get('/operator/stores', operatorAuth, (req, res) => {
  // listStores() returns [{ shopDomain }] (camelCase) — map to snake_case for API response
  const stores = storeRegistry.listStores().map(({ shopDomain }) => ({ shop_domain: shopDomain }));
  return res.status(200).json(stores);
});

// ---------------------------------------------------------------------------
// DELETE /operator/stores/:shopDomain — delete a store
// ---------------------------------------------------------------------------

/**
 * Deletes a store and its associated settings.
 *
 * Response: 200 { deleted: true } | 404 { error }
 *
 * Validates: Requirements 2.2, 2.3, 11.5
 */
router.delete('/operator/stores/:shopDomain', operatorAuth, (req, res) => {
  const { shopDomain } = req.params;

  try {
    storeRegistry.deleteStore(shopDomain);
    return res.status(200).json({ deleted: true });
  } catch (err) {
    if (err instanceof storeRegistry.StoreNotFoundError) {
      return res.status(404).json({ error: 'Store not found' });
    }
    throw err;
  }
});

module.exports = router;
