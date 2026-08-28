# Requirements Document

## Introduction

The SFT Shipping Rates app currently supports a single Shopify store, with the store domain and Admin API token hardcoded via environment variables. This feature adds multi-store support so that one running instance of the app can serve multiple Shopify merchants. Each store gets its own isolated settings (currency rates, dimensional weight divisor), its own Shopify Admin API token, and its own admin credentials. The `/rates` endpoint routes each incoming request to the correct store context using the shop domain supplied by Shopify in the rate request. Stores are onboarded manually by an app operator (no OAuth), matching the existing static-token approach. SFT API credentials remain shared across all stores. Data is persisted in a SQLite database (one file, no external server) to replace the current single flat-file store.

## Glossary

- **App**: The SFT Shipping Rates Express backend (this service).
- **Store**: A single Shopify merchant installation identified by its `.myshopify.com` domain.
- **Shop_Domain**: The `.myshopify.com` hostname that uniquely identifies a Store (e.g., `example.myshopify.com`). Used as the primary key for all per-store data.
- **Store_Record**: The persisted data for a single Store: Shop_Domain, Shopify Admin API token, admin credentials (username + hashed password), and per-store settings.
- **Store_Settings**: The per-store configurable values: currency exchange rates map and dimensional weight divisor.
- **App_Operator**: The person who deploys and operates the App (i.e., the developer/agency, not the merchant). The App_Operator registers new stores and manages the store list.
- **Merchant**: The owner of a Shopify store. The Merchant interacts with the per-store admin UI to manage Store_Settings.
- **Store_Registry**: The component that persists and retrieves Store_Records.
- **Rate_Router**: The component within the `/rates` handler that resolves which Store_Record to use for an incoming rate request.
- **Per_Store_Admin**: The admin UI and API scoped to a single Store, protected by that store's own credentials.
- **SFT**: SmartCourier (the external shipping rate API). Credentials are shared across all stores.
- **Carrier_Service_Callback_URL**: The URL Shopify calls at checkout to request shipping rates. In multi-store mode this is the same `/rates` endpoint for all stores; the shop domain in the request body identifies which store to use.
- **Database**: A SQLite file (`data/stores.db`) used to persist Store_Records.

---

## Requirements

### Requirement 1: Store Registration

**User Story:** As an App_Operator, I want to register a new Shopify store with the App, so that the App can serve shipping rates for that store's checkouts.

#### Acceptance Criteria

1. THE Store_Registry SHALL persist a Store_Record containing the Shop_Domain, Shopify Admin API token, admin username, and admin password for each registered Store.
2. WHEN a registration request is received with a Shop_Domain that is already registered, THE Store_Registry SHALL reject the request with an error indicating the store already exists.
3. WHEN a registration request is received with a missing or empty Shop_Domain, THE Store_Registry SHALL reject the request with a descriptive validation error.
4. WHEN a registration request is received with a missing or empty Shopify Admin API token, THE Store_Registry SHALL reject the request with a descriptive validation error.
5. WHEN a registration request is received with a missing or empty admin password, THE Store_Registry SHALL reject the request with a descriptive validation error.
6. THE Store_Registry SHALL initialize a newly registered Store's Store_Settings from the default settings values (currencies and dimensional weight divisor from `settings.default.json`).
7. THE Store_Registry SHALL store admin passwords as bcrypt hashes; THE Store_Registry SHALL NOT persist plaintext passwords.

---

### Requirement 2: Store Listing and Removal

**User Story:** As an App_Operator, I want to list and remove registered stores, so that I can manage which stores the App serves.

#### Acceptance Criteria

1. THE Store_Registry SHALL return a list of all registered Shop_Domains when queried.
2. WHEN a removal request is received for a Shop_Domain that is registered, THE Store_Registry SHALL delete the corresponding Store_Record and its Store_Settings.
3. WHEN a removal request is received for a Shop_Domain that is not registered, THE Store_Registry SHALL return an error indicating the store was not found.
4. THE Store_Registry SHALL NOT include Shopify Admin API tokens or admin password hashes in store listing responses.

---

### Requirement 3: Rate Request Routing

**User Story:** As a Shopify store merchant, I want the App to return correct shipping rates for my store's checkouts, so that my customers see accurate rates based on my store's settings.

#### Acceptance Criteria

1. WHEN Shopify POSTs a rate request to `/rates`, THE Rate_Router SHALL extract the Shop_Domain from the request body field `rate.shop_domain`.
2. WHEN the extracted Shop_Domain matches a registered Store_Record, THE Rate_Router SHALL load that Store's settings and Shopify Admin API token for use in the rate calculation pipeline.
3. WHEN the extracted Shop_Domain does not match any registered Store_Record, THE Rate_Router SHALL return an empty rates array (`{ "rates": [] }`) without calling the SFT API.
4. WHEN the `rate.shop_domain` field is absent from the rate request body, THE Rate_Router SHALL return an empty rates array without calling the SFT API.
5. WHEN the `rate.shop_domain` field is present but cannot be parsed or extracted into a valid domain string (e.g., malformed value, unexpected type), THE Rate_Router SHALL return an empty rates array, log the parsing error including the raw field value, and SHALL NOT call the SFT API.
6. THE Rate_Router SHALL resolve each incoming `/rates` request to exactly one Store_Record, using only the Shop_Domain present in that request.

---

### Requirement 4: Per-Store Settings Management

**User Story:** As a Merchant, I want to manage currency exchange rates and the dimensional weight divisor for my own store, so that shipping costs are calculated correctly for my store's currency and packaging.

#### Acceptance Criteria

1. THE Per_Store_Admin SHALL expose a settings API at `GET /admin/:shopDomain/settings` that returns the Store_Settings for the specified Store.
2. THE Per_Store_Admin SHALL expose a settings API at `POST /admin/:shopDomain/settings` that updates and persists the Store_Settings for the specified Store.
3. WHEN a settings update request contains a `currencies` value that is not a non-empty object, THE Per_Store_Admin SHALL reject the request with a 400 status and a descriptive error.
4. WHEN a settings update request contains a currency rate that is not a positive number, THE Per_Store_Admin SHALL reject the request with a 400 status and a descriptive error identifying the offending currency code.
5. WHEN a settings update request contains a `dimensionalWeightDivisor` that is not a positive number, THE Per_Store_Admin SHALL reject the request with a 400 status and a descriptive error.
6. THE Per_Store_Admin SHALL apply updated Store_Settings only to the Store identified by the `:shopDomain` path parameter; THE Per_Store_Admin SHALL NOT modify another Store's settings.
7. WHEN a request targets a `:shopDomain` that is not registered, THE Per_Store_Admin SHALL return a 404 status.

---

### Requirement 5: Per-Store Admin Authentication

**User Story:** As a Merchant, I want my store's admin settings to be protected by credentials specific to my store, so that other merchants cannot view or modify my settings.

#### Acceptance Criteria

1. THE Per_Store_Admin SHALL require HTTP Basic Auth credentials (username and password) for all requests to `/admin/:shopDomain/settings` and `GET /admin/:shopDomain`.
2. WHEN presented credentials match the admin username and bcrypt-hashed password stored in the Store_Record for the requested `:shopDomain`, THE Per_Store_Admin SHALL grant access.
3. WHEN presented credentials do not match the Store_Record for the requested `:shopDomain`, THE Per_Store_Admin SHALL respond with HTTP 401 and a `WWW-Authenticate: Basic` header.
4. WHEN credentials for Shop_Domain A are presented on a request targeting Shop_Domain B, THE Per_Store_Admin SHALL deny access and return HTTP 401, because credentials are validated against the domain-associated Store_Record of the requested shop only.
5. WHEN a request for `GET /admin/:shopDomain` provides valid credentials for the specified Store, THE Per_Store_Admin SHALL serve the admin UI scoped to that store's Shop_Domain.

---

### Requirement 6: Per-Store Admin UI

**User Story:** As a Merchant, I want an admin UI that lets me manage my store's settings, so that I can update currency rates and the dimensional weight divisor without editing files or calling APIs directly.

#### Acceptance Criteria

1. THE Per_Store_Admin SHALL serve the admin HTML page at `GET /admin/:shopDomain` for each registered Store.
2. WHEN the admin UI loads, THE Per_Store_Admin SHALL pre-populate the settings form with the current Store_Settings for the Shop_Domain in the URL.
3. WHEN the Merchant submits updated settings through the admin UI, THE Per_Store_Admin SHALL save the settings to the correct Store_Record and display a confirmation to the Merchant.
4. THE Per_Store_Admin SHALL NOT display settings or data from any Store other than the one identified by the `:shopDomain` path parameter.

---

### Requirement 7: Per-Store Shopify Admin API Calls

**User Story:** As a Merchant, I want the App to use my store's own Shopify Admin API token when fetching product dimension metafields, so that it can access my store's product data correctly.

#### Acceptance Criteria

1. WHEN processing a rate request for a Store, THE App SHALL use the Shopify Admin API token from that Store's Store_Record to authenticate requests to the Shopify Admin GraphQL API.
2. THE App SHALL NOT use one Store's Shopify Admin API token when processing a rate request for a different Store.
3. WHEN the Shopify Admin API token for a Store is absent or invalid, THE App SHALL fall back to returning an empty rates array for that request and log a warning identifying the Shop_Domain.

---

### Requirement 8: Data Persistence

**User Story:** As an App_Operator, I want store data to survive application restarts, so that registered stores and their settings do not need to be re-entered after a deployment or crash.

#### Acceptance Criteria

1. THE Store_Registry SHALL persist all Store_Records and Store_Settings in a SQLite database file at `data/stores.db`.
2. WHEN the App starts and `data/stores.db` does not exist, THE Store_Registry SHALL create the database file and initialize the required schema.
3. WHEN the App starts and `data/stores.db` already exists, THE Store_Registry SHALL load existing Store_Records without modifying them.
4. WHEN a Store_Settings update is saved, THE Store_Registry SHALL write the updated settings to `data/stores.db` within the same synchronous transaction as any related record updates.
5. THE Store_Registry SHALL ensure each Shop_Domain is unique within the database; duplicate Shop_Domain inserts SHALL fail with a constraint error that the registration handler converts to a user-facing error.

---

### Requirement 9: Store Registration Script (Carrier Service)

**User Story:** As an App_Operator, I want a CLI script that registers a store's `/rates` callback URL with Shopify, so that I can onboard new stores without manually calling the Shopify API.

#### Acceptance Criteria

1. THE Registration_Script SHALL accept `--shop-domain`, `--admin-api-token`, and `--callback-url` as CLI arguments or read them from environment variables.
2. WHEN all required parameters are provided and the Shopify API call succeeds, THE Registration_Script SHALL print a confirmation message including the Shopify CarrierService ID.
3. WHEN a required parameter is missing, THE Registration_Script SHALL print a descriptive error and exit with a non-zero exit code.
4. WHEN the Shopify API call fails, THE Registration_Script SHALL print the HTTP status and error body, then exit with a non-zero exit code.
5. THE Registration_Script SHALL register the same `/rates` endpoint URL for all stores; THE Registration_Script SHALL NOT require a different callback URL per store.

---

### Requirement 10: SFT Credentials

**User Story:** As an App_Operator, I want to configure SFT API credentials once for the whole App, so that I do not need to provision separate SFT credentials for each store.

#### Acceptance Criteria

1. THE App SHALL read SFT API credentials (`SFT_API_KEY`, `SFT_CREDENTIALS`) from environment variables shared across all stores.
2. THE App SHALL use the same SFT API credentials for rate requests originating from any registered Store.
3. WHEN SFT credentials are absent or empty at startup, THE App SHALL log a warning and continue in mock mode.

---

### Requirement 11: Store Isolation and Security

**User Story:** As a Merchant, I want assurance that my store's settings and API tokens cannot be read or modified by another store's requests, so that my store's data remains private.

#### Acceptance Criteria

1. THE App SHALL scope all data reads and writes by Shop_Domain; THE App SHALL NOT return or modify data for a Shop_Domain other than the one explicitly named in the request.
2. WHEN a rate request arrives for Shop_Domain A, THE App SHALL NOT load or use any data from Shop_Domain B during that request's lifecycle.
3. THE App SHALL NOT expose Shopify Admin API tokens in any HTTP response body, log line, or admin UI output.
4. THE App SHALL NOT expose admin password hashes in any HTTP response body or admin UI output.
5. WHEN the operator management API is present, THE App SHALL protect it with a separate operator-level credential configured via environment variable, distinct from any per-store admin credentials.

---

### Requirement 12: Backward Compatibility and Migration

**User Story:** As an App_Operator, I want existing single-store configuration to work after upgrading to multi-store support, so that I do not need to immediately re-register the existing store.

#### Acceptance Criteria

1. WHEN environment variables `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_API_TOKEN` are present at startup and no Store_Record for that domain exists in the database, THE App SHALL automatically register that domain as a Store_Record using those values.
2. WHEN the automatic migration in criterion 1 runs, THE App SHALL use `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables as the admin credentials for the migrated Store. WHEN either `ADMIN_USERNAME` or `ADMIN_PASSWORD` is absent or empty during migration, THE App SHALL NOT register the store with blank credentials; instead, THE App SHALL log a clear error identifying the missing variable and skip the migration for that store, leaving it unregistered until the credentials are supplied and the App is restarted.
3. WHEN the automatic migration in criterion 1 runs, THE App SHALL seed the migrated Store's Store_Settings from `data/settings.json` if that file exists, otherwise from `data/settings.default.json`.
4. WHEN the automatic migration has already run (Store_Record already exists), THE App SHALL NOT overwrite the existing Store_Record on subsequent startups.
