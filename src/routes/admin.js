'use strict';

const express = require('express');
const path = require('path');
const storeAdminAuth = require('../middleware/storeAdminAuth');
const settingsStore = require('../services/settingsStore');
const { StoreNotFoundError } = require('../services/storeRegistry');

const router = express.Router();

// GET /admin/:shopDomain — serve the admin SPA (protected by per-store Basic Auth)
router.get('/admin/:shopDomain', storeAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin.html'));
});

// GET /admin/:shopDomain/settings — return current settings for the store
router.get('/admin/:shopDomain/settings', storeAdminAuth, (req, res) => {
  const settings = settingsStore.getSettings(req.params.shopDomain);
  if (settings === null) {
    return res.status(404).json({ error: 'Store not found' });
  }
  res.json(settings);
});

// POST /admin/:shopDomain/settings — validate and save settings for the store
router.post('/admin/:shopDomain/settings', storeAdminAuth, (req, res) => {
  const { currencies, dimensionalWeightDivisor } = req.body || {};

  // Validate currencies: must be a non-array object
  if (!currencies || typeof currencies !== 'object' || Array.isArray(currencies)) {
    return res.status(400).json({ error: 'Body must include a "currencies" object, e.g. { "USD": 1, "CAD": 1.36 }' });
  }

  // Validate currencies: must have at least one key
  if (Object.keys(currencies).length === 0) {
    return res.status(400).json({ error: '"currencies" must contain at least one currency entry' });
  }

  // Validate each currency rate
  for (const [code, rate] of Object.entries(currencies)) {
    if (typeof rate !== 'number' || rate <= 0) {
      return res.status(400).json({ error: `Invalid rate for ${code}: must be a positive number` });
    }
  }

  // Validate dimensionalWeightDivisor: must be a positive number (reject 0, negative, non-numeric)
  const divisor = Number(dimensionalWeightDivisor);
  if (dimensionalWeightDivisor === undefined || dimensionalWeightDivisor === null ||
      isNaN(divisor) || divisor <= 0) {
    return res.status(400).json({ error: '"dimensionalWeightDivisor" must be a positive number' });
  }

  try {
    const updated = settingsStore.saveSettings(req.params.shopDomain, {
      currencies,
      dimensionalWeightDivisor: divisor,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof StoreNotFoundError) {
      return res.status(404).json({ error: 'Store not found' });
    }
    throw err;
  }
});

module.exports = router;
