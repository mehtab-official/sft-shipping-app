const express = require('express');
const path = require('path');
const adminAuth = require('../middleware/adminAuth');
const settingsStore = require('../services/settingsStore');

const router = express.Router();

router.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'admin.html'));
});

router.get('/admin/settings', adminAuth, (req, res) => {
  res.json(settingsStore.getSettings());
});

router.post('/admin/settings', adminAuth, (req, res) => {
  const { currencies, dimensionalWeightDivisor } = req.body || {};

  if (!currencies || typeof currencies !== 'object' || Array.isArray(currencies)) {
    return res.status(400).json({ error: 'Body must include a "currencies" object, e.g. { "USD": 1, "CAD": 1.36 }' });
  }

  for (const [code, rate] of Object.entries(currencies)) {
    if (typeof rate !== 'number' || rate <= 0) {
      return res.status(400).json({ error: `Invalid rate for ${code}: must be a positive number` });
    }
  }

  const updated = settingsStore.saveSettings({
    currencies,
    dimensionalWeightDivisor: Number(dimensionalWeightDivisor) || 5000,
  });

  res.json(updated);
});

module.exports = router;
