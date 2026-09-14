'use strict';

const express = require('express');
const path = require('path');
const storeAdminAuth = require('../middleware/storeAdminAuth');
const settingsStore = require('../services/settingsStore');
const storeRegistry = require('../services/storeRegistry');
const sftClient = require('../services/sftClient');
const { StoreNotFoundError } = require('../services/storeRegistry');

// Benchmark params used only to sample SFT's courier catalog for the
// "Discover services" admin action. SFT's rate table isn't store- or
// route-specific in a way that changes *which* couriers exist, so a single
// representative destination/weight is enough to surface the current catalog.
const DISCOVERY_SAMPLE_PARAMS = { countryCode: 'US', doctype: 'NON-DOX', weight: 1 };

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
  const { currencies, dimensionalWeightDivisor, disabledServiceCodes } = req.body || {};

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

  // Validate disabledServiceCodes: optional; when present must be an array of strings.
  // Omitted entirely means "no change to hidden services" is NOT assumed here —
  // callers (the admin UI) always send the full current list, since this save
  // replaces the whole settings row. Defaults to [] (nothing hidden) if absent.
  let hiddenCodes = [];
  if (disabledServiceCodes !== undefined) {
    if (!Array.isArray(disabledServiceCodes) || disabledServiceCodes.some((c) => typeof c !== 'string')) {
      return res.status(400).json({ error: '"disabledServiceCodes" must be an array of service_code strings' });
    }
    hiddenCodes = disabledServiceCodes;
  }

  try {
    const updated = settingsStore.saveSettings(req.params.shopDomain, {
      currencies,
      dimensionalWeightDivisor: divisor,
      disabledServiceCodes: hiddenCodes,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof StoreNotFoundError) {
      return res.status(404).json({ error: 'Store not found' });
    }
    throw err;
  }
});

// GET /admin/:shopDomain/known-services — list every courier service ever
// seen from SFT, for the admin UI's hide/show checklist. The catalog is
// shared across stores (SFT's rate table isn't store-specific), but this
// stays behind the same per-store auth as everything else under /admin/:shopDomain.
router.get('/admin/:shopDomain/known-services', storeAdminAuth, (req, res) => {
  res.json(storeRegistry.listKnownServices());
});

// POST /admin/:shopDomain/known-services/discover — run a one-off sample
// query against SFT so the catalog is populated immediately (rather than
// waiting for real checkout traffic to fill it in). Returns the full catalog
// after recording anything new.
router.post('/admin/:shopDomain/known-services/discover', storeAdminAuth, async (req, res) => {
  try {
    const sftResponse = await sftClient.getRates(DISCOVERY_SAMPLE_PARAMS);
    if (sftResponse && sftResponse.success === true && Array.isArray(sftResponse.data)) {
      for (const entry of sftResponse.data) {
        storeRegistry.recordKnownService({
          serviceCode: entry.serviceCode,
          courierName: entry.courierName,
          serviceName: entry.serviceName,
        });
      }
    }
    res.json(storeRegistry.listKnownServices());
  } catch (err) {
    console.error('[admin] service discovery failed:', err.message);
    res.status(502).json({ error: 'Could not reach SFT to discover services. Try again shortly.' });
  }
});

module.exports = router;
