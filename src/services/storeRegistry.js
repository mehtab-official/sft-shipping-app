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

  PRAGMA foreign_keys = ON;
`;

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
  StoreNotFoundError,
  StoreDuplicateError,
};
