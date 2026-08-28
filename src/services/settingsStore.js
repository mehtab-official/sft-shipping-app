'use strict';

/**
 * Per-store settings store backed by SQLite (store_settings table).
 *
 * All functions are synchronous (better-sqlite3 is synchronous).
 * The database connection is shared via storeRegistry.getDb().
 *
 * Replaces the previous flat-file (data/settings.json) implementation.
 */

const { getDb, StoreNotFoundError } = require('./storeRegistry');

// ---------------------------------------------------------------------------
// getSettings
// ---------------------------------------------------------------------------

/**
 * Returns the parsed settings object for a store, or null if the store (or
 * its settings row) does not exist.
 *
 * @param {string} shopDomain
 * @returns {{ currencies: Object, dimensionalWeightDivisor: number } | null}
 */
function getSettings(shopDomain) {
  const row = getDb()
    .prepare('SELECT settings_json FROM store_settings WHERE shop_domain = ?')
    .get(shopDomain);
  if (!row) return null;
  return JSON.parse(row.settings_json);
}

// ---------------------------------------------------------------------------
// saveSettings
// ---------------------------------------------------------------------------

/**
 * Persists the settings object for a store. Throws StoreNotFoundError if no
 * row exists for the given shopDomain (i.e. the store hasn't been registered).
 * Returns the saved settings object.
 *
 * @param {string} shopDomain
 * @param {{ currencies: Object, dimensionalWeightDivisor: number }} newSettings
 * @returns {{ currencies: Object, dimensionalWeightDivisor: number }}
 * @throws {StoreNotFoundError}
 */
function saveSettings(shopDomain, newSettings) {
  const result = getDb()
    .prepare('UPDATE store_settings SET settings_json = ? WHERE shop_domain = ?')
    .run(JSON.stringify(newSettings), shopDomain);

  if (result.changes === 0) {
    throw new StoreNotFoundError(shopDomain);
  }

  return newSettings;
}

// ---------------------------------------------------------------------------
// getCurrencyRate
// ---------------------------------------------------------------------------

/**
 * Returns the currency rate info for the given store and currency code.
 * Falls back to USD if the currency isn't configured for the store.
 *
 * @param {string} shopDomain
 * @param {string} currencyCode - from the incoming Shopify rate request's `currency` field
 * @returns {{ code: string, rate: number, pkrPerUsd: number }}
 */
function getCurrencyRate(shopDomain, currencyCode) {
  const settings = getSettings(shopDomain);
  const code = (currencyCode || 'USD').toUpperCase();
  const pkrPerUsd = (settings && settings.currencies && settings.currencies['PKR']) || 280;

  if (settings && settings.currencies && settings.currencies[code] !== undefined) {
    return { code, rate: settings.currencies[code], pkrPerUsd };
  }
  console.warn(`[settingsStore] no configured rate for currency "${code}" on store "${shopDomain}", falling back to USD`);
  return { code: 'USD', rate: 1, pkrPerUsd };
}

// ---------------------------------------------------------------------------
// getDimensionalWeightDivisor
// ---------------------------------------------------------------------------

/**
 * Returns the dimensional weight divisor for the given store.
 * Falls back to 5000 if not configured.
 *
 * @param {string} shopDomain
 * @returns {number}
 */
function getDimensionalWeightDivisor(shopDomain) {
  const settings = getSettings(shopDomain);
  return (settings && settings.dimensionalWeightDivisor) || 5000;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { getSettings, saveSettings, getCurrencyRate, getDimensionalWeightDivisor };
