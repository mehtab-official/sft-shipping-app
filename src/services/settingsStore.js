/**
 * Simple file-based settings store for currency exchange rates and the
 * dimensional-weight divisor, editable via the /admin settings page without
 * a redeploy. Swap for a real database before this needs to scale/cluster —
 * a single JSON file is fine for one backend instance.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULTS_FILE = path.join(DATA_DIR, 'settings.default.json');

function ensureSettingsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) {
    const seed = fs.existsSync(DEFAULTS_FILE)
      ? fs.readFileSync(DEFAULTS_FILE, 'utf8')
      : JSON.stringify({ currencies: { USD: 1 }, dimensionalWeightDivisor: 5000 }, null, 2);
    fs.writeFileSync(SETTINGS_FILE, seed);
  }
}

function getSettings() {
  ensureSettingsFile();
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

function saveSettings(newSettings) {
  ensureSettingsFile();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));
  return newSettings;
}

/**
 * @param {string} currencyCode - from the incoming Shopify rate request's `currency` field
 * @returns {{code: string, rate: number}} rate = units of that currency per 1 USD
 */
function getCurrencyRate(currencyCode) {
  const settings = getSettings();
  const code = (currencyCode || 'USD').toUpperCase();
  const pkrPerUsd = (settings.currencies && settings.currencies['PKR']) || 280;

  if (settings.currencies && settings.currencies[code] !== undefined) {
    return { code, rate: settings.currencies[code], pkrPerUsd };
  }
  console.warn(`[settingsStore] no configured rate for currency "${code}", falling back to USD`);
  return { code: 'USD', rate: 1, pkrPerUsd };
}

function getDimensionalWeightDivisor() {
  const settings = getSettings();
  return settings.dimensionalWeightDivisor || 5000;
}

module.exports = { getSettings, saveSettings, getCurrencyRate, getDimensionalWeightDivisor };
