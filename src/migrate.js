'use strict';

/**
 * migrate.js — Startup migration for backward compatibility.
 *
 * Reads legacy single-store env vars and, if no Store_Record already exists
 * for the domain, auto-registers it as the first store in the database.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */

const fs = require('fs');
const path = require('path');
const storeRegistry = require('./services/storeRegistry');
const { saveSettings } = require('./services/settingsStore');

/**
 * Runs the legacy env-var → Store_Record migration exactly once.
 *
 * - If SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_TOKEN are absent, returns
 *   silently (nothing to migrate).
 * - If the domain is already registered, returns silently (idempotent).
 * - Validates ADMIN_USERNAME and ADMIN_PASSWORD; logs an error and returns
 *   without registering if either is missing/empty.
 * - Seeds settings from data/settings.json if it exists, otherwise falls
 *   back to data/settings.default.json.
 * - Calls registerStore() (which seeds default settings internally) and then
 *   overrides with the parsed settings.json content via saveSettings() when
 *   settings.json was found.
 */
function runMigration() {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminApiToken = process.env.SHOPIFY_ADMIN_API_TOKEN;

  // Requirement 12.1: both env vars must be present to trigger migration
  if (!shopDomain || !adminApiToken) {
    return; // nothing to migrate — log nothing
  }

  // Requirement 12.4: idempotent — skip if store already registered
  const existing = storeRegistry.findStore(shopDomain);
  if (existing) {
    return;
  }

  // Requirement 12.2: validate admin credentials before registering
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUsername || adminUsername.trim() === '') {
    console.error('[migrate] Migration skipped: ADMIN_USERNAME environment variable is missing or empty. ' +
      'Set ADMIN_USERNAME and restart to complete migration.');
    return;
  }

  if (!adminPassword || adminPassword.trim() === '') {
    console.error('[migrate] Migration skipped: ADMIN_PASSWORD environment variable is missing or empty. ' +
      'Set ADMIN_PASSWORD and restart to complete migration.');
    return;
  }

  // Requirement 12.3: try settings.json first, fall back to settings.default.json
  const settingsJsonPath = path.join(__dirname, '..', 'data', 'settings.json');
  const settingsDefaultPath = path.join(__dirname, '..', 'data', 'settings.default.json');

  let customSettings = null;
  if (fs.existsSync(settingsJsonPath)) {
    try {
      const raw = fs.readFileSync(settingsJsonPath, 'utf8');
      customSettings = JSON.parse(raw);
    } catch (err) {
      console.error(`[migrate] Failed to parse data/settings.json: ${err.message}. Falling back to defaults.`);
      customSettings = null;
    }
  }

  // Register the store — registerStore seeds store_settings from settings.default.json internally
  storeRegistry.registerStore({
    shopDomain,
    adminApiToken,
    adminUsername,
    adminPassword,
  });

  // If settings.json was found and parsed, override the default-seeded settings
  if (customSettings) {
    saveSettings(shopDomain, customSettings);
  }

  console.log(`[migrate] Store "${shopDomain}" successfully registered from environment variables.`);
}

module.exports = { runMigration };
