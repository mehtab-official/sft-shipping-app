# Implementation Plan: Multi-Store Support

## Overview

Extend the SFT Shipping Rates backend from a single-store architecture to a multi-store architecture backed by SQLite. The implementation proceeds in layers: database foundation first, then authentication middleware, then operator and per-store APIs, then migration/wiring, and finally the removal of legacy globals.

## Tasks

- [x] 1. Install dependencies and set up test infrastructure
  - Run `npm install better-sqlite3 bcryptjs` to add runtime dependencies
  - Run `npm install --save-dev fast-check vitest` to add test dependencies
  - Add a `"test"` script to `package.json`: `"test": "vitest --run"`
  - Create `vitest.config.js` (or add vitest config to `package.json`) that targets `test/**/*.test.js`
  - _Requirements: 8.1_

- [x] 2. Implement `src/services/storeRegistry.js` — SQLite data-access layer
  - [x] 2.1 Create `src/services/storeRegistry.js` with `initDb()`, schema creation, and all CRUD exports
    - Open/create `data/stores.db` using `better-sqlite3`
    - `CREATE TABLE IF NOT EXISTS stores` and `store_settings` with the schema from the design (including `ON DELETE CASCADE`)
    - Implement `findStore(shopDomain)` returning `StorePublicRecord | null` (no token, no hash)
    - Implement `findStoreFull(shopDomain)` returning `StoreFullRecord | null` (includes token and hash)
    - Implement `listStores()` returning `[{ shopDomain }]` — no tokens or hashes
    - Implement `registerStore({ shopDomain, adminApiToken, adminUsername, adminPassword })`: hash password with `bcryptjs.hash(password, 10)`, seed `store_settings` from `settings.default.json` in the same transaction; throw `StoreDuplicateError` on UNIQUE constraint violation; throw on missing/empty required fields
    - Implement `deleteStore(shopDomain)`: delete in a transaction; throw `StoreNotFoundError` if not found
    - Define and export `StoreNotFoundError` and `StoreDuplicateError` as Error subclasses
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 8.1, 8.2, 8.3, 8.4, 8.5, 11.3, 11.4_

  - [ ]* 2.2 Write property test for Store Registration Round-Trip (Property 1)
    - **Property 1: Store Registration Round-Trip**
    - Generate random `shopDomain` (e.g. `<uuid>.myshopify.com`), random token, username, password
    - Assert `findStoreFull(domain).shopDomain === domain`, `.adminApiToken === token`, `.adminUsername === username`, `.passwordHash !== password`, and `passwordHash` starts with `$2b$`
    - Use an in-memory or temp-file DB per test run to avoid cross-test pollution
    - **Validates: Requirements 1.1, 1.7, 8.1**

  - [ ]* 2.3 Write property test for Default Settings Seeded on Registration (Property 2)
    - **Property 2: Default Settings Seeded on Registration**
    - Generate random valid `shopDomain`; call `registerStore()`; call `getSettings(shopDomain)` (via `settingsStore`)
    - Assert result deep-equals parsed `data/settings.default.json`
    - **Validates: Requirements 1.6**

  - [ ]* 2.4 Write property test for Duplicate Registration Rejected (Property 3)
    - **Property 3: Duplicate Registration Rejected**
    - Generate random valid `shopDomain` and credentials
    - Assert first `registerStore()` succeeds; second throws/rejects with message containing "already" or "exists"; original record unchanged
    - **Validates: Requirements 1.2**

  - [ ]* 2.5 Write property test for Password Stored as bcrypt Hash (Property 4)
    - **Property 4: Password Stored as bcrypt Hash**
    - Generate random plaintext passwords (varying length, special chars, unicode via `fc.string()`)
    - Assert `bcrypt.compare(plaintext, storedHash) === true` and `storedHash !== plaintext`
    - **Validates: Requirements 1.7**

  - [ ]* 2.6 Write property test for Store Listing Completeness and Safety (Property 5)
    - **Property 5: Store Listing Completeness and Safety**
    - Generate 1–20 distinct `shopDomain` strings; register all; call `listStores()`
    - Assert returned array contains exactly those domains (set equality)
    - Assert no element has `adminApiToken` or `passwordHash` keys
    - **Validates: Requirements 2.1, 2.4, 11.3, 11.4**

  - [ ]* 2.7 Write property test for Delete Then Lookup Returns Not-Found (Property 6)
    - **Property 6: Delete Then Lookup Returns Not-Found**
    - Generate random valid `shopDomain`; `registerStore()` then `deleteStore()`
    - Assert `findStore(domain) === null`
    - Assert `getSettings(domain) === null` (via `settingsStore`)
    - **Validates: Requirements 2.2**

- [x] 3. Checkpoint — Ensure all storeRegistry tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement `src/services/settingsStore.js` — rewrite for SQLite
  - [x] 4.1 Rewrite `src/services/settingsStore.js` to read/write from SQLite via `storeRegistry`
    - Replace all `fs.readFileSync` / `fs.writeFileSync` calls with SQLite queries against `store_settings`
    - `getSettings(shopDomain)`: `SELECT settings_json FROM store_settings WHERE shop_domain = ?`; return parsed JSON or `null` if not found
    - `saveSettings(shopDomain, newSettings)`: `UPDATE store_settings SET settings_json = ? WHERE shop_domain = ?`; throw `StoreNotFoundError` if no row updated; return saved object
    - `getCurrencyRate(shopDomain, currencyCode)`: call `getSettings(shopDomain)` then apply existing lookup logic
    - `getDimensionalWeightDivisor(shopDomain)`: call `getSettings(shopDomain)` then apply existing lookup logic
    - Remove `ensureSettingsFile()` — no longer needed
    - _Requirements: 4.1, 4.2, 8.1, 8.4_

  - [ ]* 4.2 Write property test for Settings Update Isolation (Property 9)
    - **Property 9: Settings Update Isolation**
    - Generate two distinct stores A and B with independent settings; call `saveSettings(A, newSettings)`
    - Assert `getSettings(B)` returns B's original settings unchanged
    - **Validates: Requirements 4.6, 11.1**

- [x] 5. Implement operator and store-admin authentication middleware
  - [x] 5.1 Create `src/middleware/operatorAuth.js`
    - Read `Authorization: Bearer <token>` header
    - Compare against `process.env.OPERATOR_API_KEY` (exact string match)
    - Return `401 { error: "Unauthorized" }` if missing or invalid
    - Return `500 { error: "Operator API not configured" }` if `OPERATOR_API_KEY` env var is not set
    - _Requirements: 11.5_

  - [x] 5.2 Create `src/middleware/storeAdminAuth.js`
    - Read `:shopDomain` from `req.params.shopDomain`
    - Call `storeRegistry.findStoreFull(shopDomain)`; return `404 { error: "Store not found" }` if null
    - Decode `Authorization: Basic <base64>` header; return `401 + WWW-Authenticate: Basic` if absent
    - Call `bcryptjs.compare(submittedPassword, record.passwordHash)`; return `401` if false
    - Set `req.storeRecord = record` on success so downstream handlers don't re-query
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 5.3 Write property test for Cross-Store Credential Denial (Property 11)
    - **Property 11: Cross-Store Credential Denial**
    - Generate two distinct stores A and B with independent random credentials
    - Assert HTTP Basic Auth request to `/admin/B/settings` using A's credentials returns 401
    - **Validates: Requirements 5.4, 11.1**

- [x] 6. Implement `src/routes/operator.js` — Operator CRUD API
  - [x] 6.1 Create `src/routes/operator.js` with all three operator endpoints
    - All routes use `operatorAuth` middleware
    - `POST /operator/stores`: validate `shop_domain`, `shopify_admin_api_token`, `admin_username`, `admin_password` present and non-empty (400 on missing); call `storeRegistry.registerStore()`; return `201 { shop_domain }` on success; catch `StoreDuplicateError` → `409 { error: "Store already registered" }`
    - `GET /operator/stores`: call `storeRegistry.listStores()`; return `200 [{ shop_domain }]`
    - `DELETE /operator/stores/:shopDomain`: call `storeRegistry.deleteStore(shopDomain)`; return `200 { deleted: true }`; catch `StoreNotFoundError` → `404 { error: "Store not found" }`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 11.5_

- [x] 7. Implement `src/migrate.js` — startup migration for legacy env-var single-store config
  - [x] 7.1 Create `src/migrate.js` with `runMigration()` function
    - Read `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_API_TOKEN` from `process.env`
    - If either is absent, log nothing and return (no migration needed)
    - Call `storeRegistry.findStore(domain)`; if already present, return (idempotent)
    - Validate `ADMIN_USERNAME` and `ADMIN_PASSWORD` are non-empty; log a clear error and return if either is missing
    - Read `data/settings.json` if it exists, else fall back to `data/settings.default.json`, parse JSON
    - Call `storeRegistry.registerStore({ shopDomain, adminApiToken, adminUsername, adminPassword })` — note: seeding from default JSON happens inside `registerStore`, but override with the parsed `settings.json` content via a follow-up `saveSettings()` call if `settings.json` was found
    - Log success confirmation on completion
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

- [x] 8. Update `src/routes/admin.js` — per-store admin routes
  - [x] 8.1 Rewrite `src/routes/admin.js` to use `:shopDomain` path param and `storeAdminAuth`
    - Replace `adminAuth` import with `storeAdminAuth`
    - Change `GET /admin` → `GET /admin/:shopDomain` — serve `admin.html` (storeAdminAuth)
    - Change `GET /admin/settings` → `GET /admin/:shopDomain/settings` — call `settingsStore.getSettings(req.params.shopDomain)`; return `404` if null
    - Change `POST /admin/settings` → `POST /admin/:shopDomain/settings` — validate currencies and `dimensionalWeightDivisor` (keep existing validation logic); call `settingsStore.saveSettings(req.params.shopDomain, { currencies, dimensionalWeightDivisor })`; catch `StoreNotFoundError` → `404`
    - Use `req.storeRecord` (set by `storeAdminAuth`) instead of re-querying the registry
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1_

  - [ ]* 8.2 Write property test for Currency Validation Rejects Non-Positive Rates (Property 10)
    - **Property 10: Currency Validation Rejects Non-Positive Rates**
    - Generate random `currencies` object where at least one value is ≤ 0 or non-number
    - Assert `POST /admin/:shopDomain/settings` returns 400 with error body identifying the offending currency code
    - Assert `getSettings(shopDomain)` still returns pre-existing settings unchanged
    - **Validates: Requirements 4.3, 4.4**

- [x] 9. Update `src/services/shopifyAdmin.js` — accept per-store context parameter
  - [x] 9.1 Modify `fetchProductDimensions` to accept `storeContext` as second parameter
    - Change signature to `fetchProductDimensions(productIds, storeContext)` where `storeContext = { storeDomain, adminApiToken, adminMockMode? }`
    - Replace `config.shopify.storeDomain` with `storeContext.storeDomain`
    - Replace `config.shopify.adminApiToken` with `storeContext.adminApiToken`
    - Replace `config.shopify.adminMockMode` with `storeContext.adminMockMode ?? bool(process.env.SHOPIFY_ADMIN_MOCK_MODE, true)`
    - Remove `const config = require('../config')` import (no longer needed for shopify fields)
    - _Requirements: 7.1, 7.2_

- [x] 10. Update `src/routes/rates.js` — multi-store routing
  - [x] 10.1 Rewrite the `/rates` handler to resolve `shop_domain` → Store_Record before delegating
    - Import `storeRegistry` from `../services/storeRegistry`
    - Extract `rate.shop_domain`: if absent or not a string, return `{ rates: [] }` (log warning for wrong type)
    - Call `storeRegistry.findStoreFull(shopDomain)`; return `{ rates: [] }` if null
    - Call `settingsStore.getSettings(shopDomain)` — pass `shopDomain`
    - Pass `{ storeDomain: storeRecord.shopDomain, adminApiToken: storeRecord.adminApiToken }` as second arg to `shopifyAdmin.fetchProductDimensions()`
    - Pass `shopDomain` to `settingsStore.getDimensionalWeightDivisor()` and `settingsStore.getCurrencyRate()`
    - Keep all existing error handling (soft-fail → `{ rates: [] }`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 7.1, 7.2_

  - [ ]* 10.2 Write property test for Store Isolation in Rate Routing (Property 7)
    - **Property 7: Store Isolation in Rate Routing**
    - Register two stores A and B with different tokens; mock `shopifyAdmin.fetchProductDimensions` to record which `adminApiToken` was passed
    - Assert mock `/rates` request for store A always passes A's token (never B's) and loads A's settings row
    - **Validates: Requirements 3.2, 3.6, 7.1, 7.2, 11.1, 11.2**

  - [ ]* 10.3 Write property test for Unknown Domain Returns Empty Rates (Property 8)
    - **Property 8: Unknown Domain Returns Empty Rates**
    - Generate random domain string guaranteed not in the registry (e.g. unique UUID prefix per run)
    - Assert mock POST to `/rates` returns `{ rates: [] }` and the mock SFT client was never called
    - **Validates: Requirements 3.3**

- [x] 11. Update `src/config.js` — remove per-store globals, add operator key
  - [x] 11.1 Modify `src/config.js` to remove per-store fields and add `operator.apiKey`
    - Remove `shopify.storeDomain` and `shopify.adminApiToken` (now per-store in DB)
    - Remove `admin.username` and `admin.password` (now per-store in DB)
    - Add `operator: { apiKey: process.env.OPERATOR_API_KEY || '' }` to the config object
    - Keep `sft.*`, `shopify.apiVersion`, `shopify.adminMockMode`, and `port`
    - _Requirements: 11.5_

- [x] 12. Update `src/server.js` — wire up DB init, migration, and operator router
  - [x] 12.1 Modify `src/server.js` to initialize the database and mount new routes
    - Import `storeRegistry` from `./services/storeRegistry` and call `storeRegistry.initDb()` before `app.listen()`
    - Import `runMigration` from `./migrate` and call `runMigration()` after `initDb()`
    - Import and mount `operatorRouter` from `./routes/operator` at `/`
    - Update the `/health` response to include `registeredStores: storeRegistry.listStores().length`
    - Update startup log: remove reference to `/admin (Basic Auth)` — store-specific admin is now at `/admin/:shopDomain`
    - _Requirements: 8.2, 8.3, 12.1_

- [x] 13. Update `scripts/registerCarrierService.js` — add CLI argument parsing
  - [x] 13.1 Add `--shop-domain`, `--admin-api-token`, and `--callback-url` CLI argument support
    - Parse `process.argv` for `--shop-domain=<value>`, `--admin-api-token=<value>`, `--callback-url=<value>` (use `=`-separated or space-separated patterns)
    - Fall back to `process.env.SHOPIFY_STORE_DOMAIN`, `process.env.SHOPIFY_ADMIN_API_TOKEN`, `process.env.CARRIER_SERVICE_CALLBACK_URL` respectively when CLI args not provided
    - Remove dependency on `config.shopify.storeDomain` and `config.shopify.adminApiToken` (use resolved local variables instead)
    - Print descriptive error and `process.exit(1)` if any required value is still missing after fallback
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 14. Update `public/admin.html` — prepend `/:shopDomain` to all fetch URLs
  - [x] 14.1 Update API fetch calls in `public/admin.html` to include the `shopDomain` path segment
    - Read `shopDomain` from the URL path (e.g. `window.location.pathname.split('/')[2]`)
    - Replace `/admin/settings` fetch URLs with `/admin/${shopDomain}/settings`
    - Ensure the settings form loads and saves via the new per-store routes
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 15. Deprecate `src/middleware/adminAuth.js`
  - [x] 15.1 Delete `src/middleware/adminAuth.js`
    - Confirm no remaining `require('../middleware/adminAuth')` or `require('./adminAuth')` references exist in the codebase before deleting
    - Delete the file
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- `better-sqlite3` uses a synchronous API — no `async/await` needed in `storeRegistry.js`
- Use a fresh temp SQLite file per property-test run (e.g. `tmp-<uuid>.db`) to guarantee test isolation; clean up in `afterEach`/`afterAll`
- Property tests require a minimum of 100 iterations (fast-check default)
- Tag format for each property test file: `// Feature: multi-store-support, Property N: <property_text>`
- The `storeAdminAuth` middleware sets `req.storeRecord` — downstream route handlers should use it to avoid a second DB round-trip
- `operatorAuth` returns `500` (not `401`) when `OPERATOR_API_KEY` is not configured — this is intentional fail-safe behavior

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1", "5.2", "7.1"] },
    { "id": 4, "tasks": ["5.3", "6.1", "9.1"] },
    { "id": 5, "tasks": ["8.1", "10.1", "11.1"] },
    { "id": 6, "tasks": ["8.2", "10.2", "10.3", "12.1"] },
    { "id": 7, "tasks": ["13.1", "14.1", "15.1"] }
  ]
}
```
