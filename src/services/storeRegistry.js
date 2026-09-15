'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

class StoreNotFoundError extends Error {
  constructor(shopDomain) {
    super(`Store not found: ${shopDomain}`);
    this.name = 'StoreNotFoundError';
    this.shopDomain = shopDomain;
  }
}

class StoreDuplicateError extends Error {
  constructor(shopDomain) {
    super(`Store already exists: ${shopDomain}`);
    this.name = 'StoreDuplicateError';
    this.shopDomain = shopDomain;
  }
}

// ---------------------------------------------------------------------------
// Module-level DB handle (set by initDb)
// ---------------------------------------------------------------------------

/** @type {import('better-sqlite3').Database | null} */
let db = null;

/**
 * Resolve the path to the SQLite database file.
 * Can be overridden for tests by setting the DB_PATH env var.
 */
function resolveDbPath() {
  return process.env.STORE_REGISTRY_DB_PATH ||
    path.join(__dirname, '..', '..', 'data', 'stores.db');
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS stores (
    shop_domain       TEXT PRIMARY KEY NOT NULL,
    admin_api_token   TEXT NOT NULL,
    admin_username    TEXT NOT NULL,
    password_hash     TEXT NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS store_settings (
    shop_domain   TEXT PRIMARY KEY NOT NULL
                    REFERENCES stores(shop_domain) ON DELETE CASCADE,
    settings_json TEXT NOT NULL
  );

  -- Catalog of courier services SFT has ever returned to us, across all stores
  -- (SFT's rate table isn't store-specific, so this is shared). Keyed by
  -- (country_code, service_code) because SFT quotes a different set of
  -- couriers per destination country — the same service_code is not assumed
  -- to mean the same thing in two different countries. Populated
  -- automatically as real rate responses come in, and on-demand via the
  -- "Discover services" admin action. Used to render the per-country
  -- enable/hide checklist in each store's admin dashboard — see routes/admin.js.
  CREATE TABLE IF NOT EXISTS known_services (
    country_code   TEXT NOT NULL,
    service_code   TEXT NOT NULL,
    courier_name   TEXT NOT NULL,
    service_name   TEXT NOT NULL,
    first_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (country_code, service_code)
  );

  PRAGMA foreign_keys = ON;
`;

// ---------------------------------------------------------------------------
// Defensive migration: upgrade a known_services table created by an earlier
// version of this schema (service_code-only primary key, no country_code) to
// the current (country_code, service_code) shape. Only matters once the
// database lives on persistent storage across deploys — safe/no-op otherwise
// since CREATE TABLE IF NOT EXISTS already produces the right shape on a
// fresh database.
// ---------------------------------------------------------------------------

function migrateKnownServicesTable(dbHandle) {
  const columns = dbHandle.prepare("PRAGMA table_info(known_services)").all();
  const hasCountryCode = columns.some((c) => c.name === 'country_code');
  if (hasCountryCode || columns.length === 0) return; // already current, or table didn't exist yet

  console.log('[storeRegistry] migrating known_services to (country_code, service_code) schema');
  dbHandle.exec(`
    ALTER TABLE known_services RENAME TO known_services_old;
    CREATE TABLE known_services (
      country_code   TEXT NOT NULL,
      service_code   TEXT NOT NULL,
      courier_name   TEXT NOT NULL,
      service_name   TEXT NOT NULL,
      first_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (country_code, service_code)
    );
    INSERT INTO known_services (country_code, service_code, courier_name, service_name, first_seen_at)
      SELECT '', service_code, courier_name, service_name, first_seen_at FROM known_services_old;
    DROP TABLE known_services_old;
  `);
}

// ---------------------------------------------------------------------------
// initDb
// ---------------------------------------------------------------------------

/**
 * Opens (or creates) the SQLite database and runs the schema migrations.
 * Must be called once during server startup before any other function.
 *
 * @param {string} [dbPath] - Optional path override (used by tests).
 */
function initDb(dbPath) {
  const resolvedPath = dbPath || resolveDbPath();
  db = new Database(resolvedPath);
  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  // Ensure foreign-key enforcement is on for this connection
  db.pragma('foreign_keys = ON');
  // Run schema creation (idempotent)
  db.exec(SCHEMA_SQL);
  // Upgrade older known_services tables in place, if needed (see above)
  migrateKnownServicesTable(db);
}

// ---------------------------------------------------------------------------
// Internal helper: require the db to be initialised
// ---------------------------------------------------------------------------

function requireDb() {
  if (!db) {
    throw new Error('storeRegistry: initDb() has not been called');
  }
  return db;
}

// ---------------------------------------------------------------------------
// Row → record mappers
// ---------------------------------------------------------------------------

/**
 * Maps a raw DB row to a StorePublicRecord (no token, no hash).
 * @param {Object} row
 * @returns {{ shopDomain: string, adminUsername: string, createdAt: number }}
 */
function toPublicRecord(row) {
  return {
    shopDomain: row.shop_domain,
    adminUsername: row.admin_username,
    createdAt: row.created_at,
  };
}

/**
 * Maps a raw DB row to a StoreFullRecord (includes token and hash).
 * @param {Object} row
 * @returns {{ shopDomain: string, adminApiToken: string, adminUsername: string, passwordHash: string, createdAt: number }}
 */
function toFullRecord(row) {
  return {
    shopDomain: row.shop_domain,
    adminApiToken: row.admin_api_token,
    adminUsername: row.admin_username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// findStore
// ---------------------------------------------------------------------------

/**
 * Returns a store's public record (no token, no password hash), or null if
 * the store does not exist.
 *
 * @param {string} shopDomain
 * @returns {{ shopDomain: string, adminUsername: string, createdAt: number } | null}
 */
function findStore(shopDomain) {
  const row = requireDb()
    .prepare('SELECT shop_domain, admin_username, created_at FROM stores WHERE shop_domain = ?')
    .get(shopDomain);
  return row ? toPublicRecord(row) : null;
}

// ---------------------------------------------------------------------------
// findStoreFull
// ---------------------------------------------------------------------------

/**
 * Returns the full store record including admin API token and password hash,
 * or null if the store does not exist.
 *
 * Intended only for use by auth middleware and the rates router.
 *
 * @param {string} shopDomain
 * @returns {{ shopDomain: string, adminApiToken: string, adminUsername: string, passwordHash: string, createdAt: number } | null}
 */
function findStoreFull(shopDomain) {
  const row = requireDb()
    .prepare('SELECT * FROM stores WHERE shop_domain = ?')
    .get(shopDomain);
  return row ? toFullRecord(row) : null;
}

// ---------------------------------------------------------------------------
// listStores
// ---------------------------------------------------------------------------

/**
 * Returns an array of { shopDomain } objects for every registered store.
 * Never includes tokens or hashes.
 *
 * @returns {Array<{ shopDomain: string }>}
 */
function listStores() {
  const rows = requireDb()
    .prepare('SELECT shop_domain FROM stores ORDER BY created_at ASC')
    .all();
  return rows.map((r) => ({ shopDomain: r.shop_domain }));
}

// ---------------------------------------------------------------------------
// registerStore
// ---------------------------------------------------------------------------

/**
 * Registers a new store.
 *
 * - Validates that all required fields are present and non-empty.
 * - Hashes the plaintext password with bcrypt (cost factor 10).
 * - Inserts the store row and seeds `store_settings` from
 *   `data/settings.default.json`, all in a single transaction.
 *
 * @param {{ shopDomain: string, adminApiToken: string, adminUsername: string, adminPassword: string }} params
 * @throws {StoreDuplicateError} if a store with that domain already exists
 * @throws {Error} if any required field is missing or empty
 */
function registerStore({ shopDomain, adminApiToken, adminUsername, adminPassword }) {
  // --- Validate inputs ---
  if (!shopDomain || typeof shopDomain !== 'string' || shopDomain.trim() === '') {
    throw new Error('registerStore: shopDomain is required and must be a non-empty string');
  }
  if (!adminApiToken || typeof adminApiToken !== 'string' || adminApiToken.trim() === '') {
    throw new Error('registerStore: adminApiToken is required and must be a non-empty string');
  }
  if (!adminUsername || typeof adminUsername !== 'string' || adminUsername.trim() === '') {
    throw new Error('registerStore: adminUsername is required and must be a non-empty string');
  }
  if (!adminPassword || typeof adminPassword !== 'string' || adminPassword.trim() === '') {
    throw new Error('registerStore: adminPassword is required and must be a non-empty string');
  }

  // --- Hash password synchronously (better-sqlite3 is synchronous) ---
  const passwordHash = bcrypt.hashSync(adminPassword, 10);

  // --- Load default settings seed ---
  const defaultSettingsPath = path.join(__dirname, '..', '..', 'data', 'settings.default.json');
  const defaultSettings = require(defaultSettingsPath);
  const settingsJson = JSON.stringify(defaultSettings);

  // --- Insert in a transaction ---
  const insertStore = requireDb().prepare(
    'INSERT INTO stores (shop_domain, admin_api_token, admin_username, password_hash) VALUES (?, ?, ?, ?)'
  );
  const insertSettings = requireDb().prepare(
    'INSERT INTO store_settings (shop_domain, settings_json) VALUES (?, ?)'
  );

  const runTransaction = requireDb().transaction(() => {
    insertStore.run(shopDomain, adminApiToken, adminUsername, passwordHash);
    insertSettings.run(shopDomain, settingsJson);
  });

  try {
    runTransaction();
  } catch (err) {
    // SQLite UNIQUE constraint violation error code
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err.message && err.message.includes('UNIQUE constraint failed'))) {
      throw new StoreDuplicateError(shopDomain);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// deleteStore
// ---------------------------------------------------------------------------

/**
 * Deletes a store and its associated settings (cascaded automatically by the
 * foreign-key constraint, but we also delete explicitly for clarity).
 *
 * @param {string} shopDomain
 * @throws {StoreNotFoundError} if no store with that domain exists
 */
function deleteStore(shopDomain) {
  const deleteStmt = requireDb().prepare('DELETE FROM stores WHERE shop_domain = ?');

  const runTransaction = requireDb().transaction(() => {
    const result = deleteStmt.run(shopDomain);
    if (result.changes === 0) {
      throw new StoreNotFoundError(shopDomain);
    }
  });

  runTransaction();
}

// ---------------------------------------------------------------------------
// recordKnownService / listKnownServices
// ---------------------------------------------------------------------------

/**
 * Records a courier service in the shared catalog if this (country, service_code)
 * pair hasn't been seen before. Best-effort: callers should not let a failure
 * here break a rate response.
 *
 * @param {{ countryCode: string, serviceCode: string, courierName: string, serviceName: string }} service
 */
function recordKnownService({ countryCode, serviceCode, courierName, serviceName }) {
  if (!serviceCode || !countryCode) return;
  requireDb()
    .prepare(
      'INSERT OR IGNORE INTO known_services (country_code, service_code, courier_name, service_name) VALUES (?, ?, ?, ?)'
    )
    .run(countryCode.toUpperCase(), serviceCode, courierName || '', serviceName || '');
}

/**
 * Returns every courier service ever recorded. Pass countryCode to scope to
 * one destination country (case-insensitive); omit to get the full catalog
 * across every country seen so far.
 *
 * @param {string} [countryCode]
 * @returns {Array<{ countryCode: string, serviceCode: string, courierName: string, serviceName: string }>}
 */
function listKnownServices(countryCode) {
  const rows = countryCode
    ? requireDb()
        .prepare('SELECT country_code, service_code, courier_name, service_name FROM known_services WHERE country_code = ? ORDER BY courier_name ASC, service_name ASC')
        .all(countryCode.toUpperCase())
    : requireDb()
        .prepare('SELECT country_code, service_code, courier_name, service_name FROM known_services ORDER BY country_code ASC, courier_name ASC, service_name ASC')
        .all();
  return rows.map((r) => ({
    countryCode: r.country_code,
    serviceCode: r.service_code,
    courierName: r.courier_name,
    serviceName: r.service_name,
  }));
}

/**
 * Returns the distinct list of destination country codes we have any
 * recorded services for, alphabetically. Used to populate the country
 * picker in the admin dashboard.
 *
 * @returns {string[]}
 */
function listKnownServiceCountries() {
  const rows = requireDb()
    .prepare("SELECT DISTINCT country_code FROM known_services WHERE country_code != '' ORDER BY country_code ASC")
    .all();
  return rows.map((r) => r.country_code);
}

// ---------------------------------------------------------------------------
// getDb — expose the db handle for modules that need to share the connection
// ---------------------------------------------------------------------------

/**
 * Returns the initialised better-sqlite3 Database handle.
 * Throws if `initDb()` has not been called yet.
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb() {
  return requireDb();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  initDb,
  getDb,
  findStore,
  findStoreFull,
  listStores,
  registerStore,
  deleteStore,
  recordKnownService,
  listKnownServices,
  listKnownServiceCountries,
  StoreNotFoundError,
  StoreDuplicateError,
};
