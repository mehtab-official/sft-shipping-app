'use strict';

const express = require('express');
const path = require('path');
const storeAdminAuth = require('../middleware/storeAdminAuth');
const settingsStore = require('../services/settingsStore');
const storeRegistry = require('../services/storeRegistry');
const sftClient = require('../services/sftClient');
const { StoreNotFoundError } = require('../services/storeRegistry');

// Defaults used to sample SFT's courier catalog for one destination country
// via the "Discover services" admin action. doctype/weight are fixed
// benchmarks; countryCode is supplied by the caller (see the discover route).
const DISCOVERY_SAMPLE_DEFAULTS = { doctype: 'NON-DOX', weight: 1 };

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
  const { currencies, dimensionalWeightDivisor, disabledServiceCodesByCountry } = req.body || {};

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

  // Validate disabledServiceCodesByCountry: optional; when present must be a
  // plain object mapping country code -> array of service_code strings, e.g.
  // { "US": ["01", "15"], "GB": ["UK DHL"] }. Omitted entirely is NOT treated
  // as "no change" — the admin UI always sends the full current map, since
  // this save replaces the whole settings row. Defaults to {} (nothing hidden
  // anywhere) if absent, matching today's behavior for every existing store.
  let hiddenByCountry = {};
  if (disabledServiceCodesByCountry !== undefined) {
    if (typeof disabledServiceCodesByCountry !== 'object' || disabledServiceCodesByCountry === null || Array.isArray(disabledServiceCodesByCountry)) {
      return res.status(400).json({ error: '"disabledServiceCodesByCountry" must be an object of country code -> array of service_code strings' });
    }
    for (const [country, codes] of Object.entries(disabledServiceCodesByCountry)) {
      if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
        return res.status(400).json({ error: `"disabledServiceCodesByCountry.${country}" must be an array of service_code strings` });
      }
    }
    hiddenByCountry = disabledServiceCodesByCountry;
  }

  try {
    const updated = settingsStore.saveSettings(req.params.shopDomain, {
      currencies,
      dimensionalWeightDivisor: divisor,
      disabledServiceCodesByCountry: hiddenByCountry,
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof StoreNotFoundError) {
      return res.status(404).json({ error: 'Store not found' });
    }
    throw err;
  }
});

// GET /admin/:shopDomain/known-services/countries — list every destination
// country code we have any recorded services for, so the admin UI's country
// picker only ever offers countries with real data behind them.
router.get('/admin/:shopDomain/known-services/countries', storeAdminAuth, (req, res) => {
  res.json(storeRegistry.listKnownServiceCountries());
});

// GET /admin/:shopDomain/known-services?country=US — list courier services
// ever seen from SFT for one destination country, for the admin UI's
// per-country hide/show checklist. Omit ?country to get the full catalog
// across every country (each entry carries its own countryCode). The catalog
// is shared across stores (SFT's rate table isn't store-specific), but this
// stays behind the same per-store auth as everything else under /admin/:shopDomain.
router.get('/admin/:shopDomain/known-services', storeAdminAuth, (req, res) => {
  const country = typeof req.query.country === 'string' ? req.query.country : undefined;
  res.json(storeRegistry.listKnownServices(country));
});

// POST /admin/:shopDomain/known-services/discover — run a one-off sample
// query against SFT for ONE destination country (body: { countryCode }, e.g.
// "GB") so that country's catalog is populated immediately, rather than
// waiting for real checkout traffic from that country to fill it in. Returns
// the catalog for that country after recording anything new.
router.post('/admin/:shopDomain/known-services/discover', storeAdminAuth, async (req, res) => {
  const countryCode = typeof (req.body && req.body.countryCode) === 'string' ? req.body.countryCode.trim().toUpperCase() : '';
  if (!countryCode) {
    return res.status(400).json({ error: '"countryCode" is required, e.g. "US"' });
  }
  try {
    const sftResponse = await sftClient.getRates({ ...DISCOVERY_SAMPLE_DEFAULTS, countryCode });
    if (sftResponse && sftResponse.success === true && Array.isArray(sftResponse.data)) {
      for (const entry of sftResponse.data) {
        storeRegistry.recordKnownService({
          countryCode,
          serviceCode: entry.serviceCode,
          courierName: entry.courierName,
          serviceName: entry.serviceName,
        });
      }
    }
    res.json(storeRegistry.listKnownServices(countryCode));
  } catch (err) {
    console.error('[admin] service discovery failed:', err.message);
    res.status(502).json({ error: 'Could not reach SFT to discover services. Try again shortly.' });
  }
});

module.exports = router;
