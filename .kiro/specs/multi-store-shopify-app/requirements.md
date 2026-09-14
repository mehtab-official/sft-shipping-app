# Requirements Document

## Introduction

The SFT Shipping Rates backend is currently a single-store Node.js/Express service hardcoded to one merchant's Shopify store. This feature converts it into a public, multi-tenant Shopify app that any merchant can install from the Shopify App Store. The conversion adds OAuth 2.0 installation flow, per-store persistent storage (Postgres/SQLite via Prisma), HMAC-verified CarrierService callbacks, automatic post-install CarrierService registration, webhook handling for uninstalls, and a per-shop admin panel — while fully preserving the existing business logic: dimensional weight calculation, SFT Rate Inquiry API integration, currency conversion, and mock modes for development.

## Glossary

- **App**: The multi-tenant Shopify application being built, installable from the Shopify App Store.
- **Shop**: A single Shopify merchant store that has installed the App (identified by its `myshopify.com` domain).
- **OAuth_Handler**: The component responsible for Shopify OAuth 2.0 install and callback flows.
- **Token_Store**: The database layer (Prisma) that persists per-shop access tokens and settings.
- **Rates_Handler**: The Express route handler for `POST /rates`, the Shopify CarrierService callback.
- **HMAC_Verifier**: The middleware that verifies Shopify's HMAC signature on incoming requests.
- **CarrierService_Registrar**: The component that registers the `/rates` callback URL with Shopify after install.
- **Webhook_Handler**: The component that processes Shopify webhook events sent to the App.
- **Admin_Panel**: The per-shop settings UI served at `/admin`, allowing merchants to configure currency exchange rates and the dimensional weight divisor.
- **Settings_Store**: The per-shop database-backed store for currency exchange rates and dimensional weight divisor (replaces the flat-file `data/settings.json`).
- **SFT_Client**: The service that calls SmartCourier's Rate Inquiry API (`GET /v2/tarrif`).
- **Shopify_Admin_Client**: The service that fetches product dimension metafields from a shop's Shopify Admin GraphQL API.
- **Dimensional_Weight_Calculator**: The service that computes chargeable weight as `max(actual_weight, (L×W×H)/divisor)`.
- **Mapper**: The service that translates between Shopify's CarrierService contract and SFT's API request/response shapes.
- **CarrierService**: The Shopify resource that registers a third-party shipping rate provider callback with a merchant's store.
- **HMAC**: Hash-based Message Authentication Code — Shopify's mechanism for signing webhook and CarrierService callback payloads.
- **Scopes**: OAuth permission scopes required from the merchant: `write_shipping`, `read_products`.
- **PKR**: Pakistani Rupee — the currency SFT returns prices in.

---

## Requirements

### Requirement 1: Shopify OAuth 2.0 Installation Flow

**User Story:** As a Shopify merchant, I want to install the App from the Shopify App Store, so that the App is authorized to access my store's shipping configuration and product data.

#### Acceptance Criteria

1. WHEN a merchant initiates app installation, THE OAuth_Handler SHALL redirect the merchant's browser to Shopify's OAuth authorization URL with the `write_shipping` and `read_products` scopes requested.
2. WHEN Shopify redirects to `GET /auth/callback` with a `code` and `shop` parameter, THE OAuth_Handler SHALL exchange the authorization code for a per-shop access token using Shopify's token endpoint.
3. WHEN the OAuth callback contains a `state` parameter, THE OAuth_Handler SHALL verify the `state` value matches the value generated at the start of the OAuth flow before exchanging the code.
4. IF the OAuth callback `state` parameter does not match the expected value, THEN THE OAuth_Handler SHALL reject the request with HTTP 403 AND SHALL NOT store any access token; if either the HTTP 403 response or the prevention of token storage fails, THE OAuth_Handler SHALL treat the failure as a system error.
5. WHEN a per-shop access token is successfully obtained, THE Token_Store SHALL persist the shop domain, access token, and installation timestamp in the `shops` database table.
6. WHEN a shop that previously uninstalled the App reinstalls it, THE Token_Store SHALL update the existing shop record with the new access token and installation timestamp rather than creating a duplicate record.
7. WHEN the OAuth flow completes successfully, THE OAuth_Handler SHALL trigger the CarrierService_Registrar to register the `/rates` callback URL with the newly installed shop.
8. WHEN the OAuth flow completes, THE OAuth_Handler SHALL redirect the merchant to the App's Admin_Panel for their shop.

---

### Requirement 2: Per-Shop Persistent Storage

**User Story:** As a system operator, I want each shop's data stored in a database scoped to that shop, so that settings from one merchant never affect another merchant.

#### Acceptance Criteria

1. THE Token_Store SHALL use a Prisma-managed relational database (Postgres in production, SQLite for local development) as the persistent storage backend.
2. THE Token_Store SHALL maintain a `shops` table with columns: `shop_domain` (unique, primary key), `access_token`, `installed_at`, `uninstalled_at` (nullable).
3. THE Token_Store SHALL maintain a `settings` table with columns: `shop_domain` (foreign key to `shops`), `currencies` (JSON), `dimensional_weight_divisor` (numeric), and default values matching `data/settings.default.json`.
4. THE Token_Store SHALL maintain a `carrier_services` table with columns: `shop_domain` (foreign key to `shops`), `carrier_service_id` (the ID returned by Shopify when registering the CarrierService).
5. WHEN a shop's settings are read and no settings row exists for that shop, THE Settings_Store SHALL return the default values (`currencies` as defined in `data/settings.default.json`, `dimensional_weight_divisor` of 5000).
6. THE Settings_Store SHALL read and write settings exclusively from the database, replacing all use of `data/settings.json` flat file; writing settings to the database without subsequently reading them satisfies this requirement.
7. FOR ALL shops with settings persisted and then read back, THE Settings_Store SHALL return settings objects equivalent to what was saved (round-trip property).

---

### Requirement 3: HMAC Verification on POST /rates

**User Story:** As a system operator, I want every incoming `/rates` request verified as genuinely from Shopify, so that the endpoint cannot be abused by unauthorized callers.

#### Acceptance Criteria

1. WHEN a `POST /rates` request is received, THE HMAC_Verifier SHALL always attempt to verify the `X-Shopify-Hmac-Sha256` header against the raw request body using the App's client secret before any business logic runs; verification must be attempted for every such request without exception.
2. IF the `X-Shopify-Hmac-Sha256` header is absent or does not match the computed HMAC, THEN THE HMAC_Verifier SHALL reject the request with HTTP 401; no downstream rate calculation logic SHALL run once verification fails, even if the HTTP response has not yet been sent.
3. WHEN a `POST /rates` request passes HMAC verification, THE Rates_Handler SHALL identify the originating shop from the `X-Shopify-Shop-Domain` header included in the request.
4. IF the shop identified by `X-Shopify-Shop-Domain` is not found in the `shops` table or has been uninstalled, THEN THE Rates_Handler SHALL return `{"rates": []}` with HTTP 200 rather than erroring the checkout.
5. WHEN computing HMAC verification, THE HMAC_Verifier SHALL use the raw, unparsed request body bytes — not the parsed JSON — to match Shopify's signing behavior.

---

### Requirement 4: Automatic CarrierService Registration

**User Story:** As a Shopify merchant, I want the App to automatically configure carrier-calculated shipping on my store after I install it, so that I don't need to run any manual scripts.

#### Acceptance Criteria

1. WHEN the OAuth flow completes successfully for a shop, THE CarrierService_Registrar SHALL call Shopify's `POST /admin/api/{version}/carrier_services.json` endpoint using that shop's access token to register the App's `/rates` URL as a CarrierService.
2. WHEN the CarrierService is successfully registered, THE Token_Store SHALL persist the returned `carrier_service.id` in the `carrier_services` table for that shop; IF registration fails for any reason, THE Token_Store SHALL store nothing in the `carrier_services` table for that attempt.
3. IF the CarrierService registration API call fails because the merchant's Shopify plan does not support carrier-calculated shipping (Advanced or Plus plan required), THEN THE CarrierService_Registrar SHALL log the error with the shop domain and SHALL NOT block the OAuth flow from completing.
4. IF a CarrierService record already exists for a shop in the `carrier_services` table, THEN THE CarrierService_Registrar SHALL skip re-registration to avoid creating duplicate CarrierService entries on that shop.
5. THE CarrierService registered for each shop SHALL have `service_discovery: true` set so Shopify probes the endpoint for available services.

---

### Requirement 5: Webhook Handling — App Uninstalled

**User Story:** As a system operator, I want the App to clean up shop data when a merchant uninstalls it, so that orphaned access tokens are not retained indefinitely.

#### Acceptance Criteria

1. WHEN Shopify sends a `POST /webhooks/app/uninstalled` event for a shop, THE Webhook_Handler SHALL verify the `X-Shopify-Hmac-Sha256` signature on the webhook payload before processing.
2. IF the HMAC signature on a webhook request is invalid, THEN THE Webhook_Handler SHALL validate the signature before any processing begins and, upon failure, SHALL return HTTP 401 without modifying any shop data.
3. WHEN a verified `app/uninstalled` webhook is received for a shop, THE Token_Store SHALL mark the shop as uninstalled by setting `uninstalled_at` to the current timestamp and SHALL nullify the stored access token for that shop.
4. WHEN a shop is marked as uninstalled, THE Rates_Handler SHALL return `{"rates": []}` for any subsequent `/rates` requests from that shop domain.
5. WHEN an `app/uninstalled` webhook is received, THE Webhook_Handler SHALL respond with HTTP 200 within 5 seconds to acknowledge receipt to Shopify.
6. WHILE the App is installed on a shop, THE Webhook_Handler SHALL maintain the `app/uninstalled` webhook subscription for that shop's domain.

---

### Requirement 6: Per-Shop Admin Panel

**User Story:** As a Shopify merchant, I want to configure currency exchange rates and the dimensional weight divisor for my store through an admin panel, so that my shipping rates are calculated correctly for my specific business.

#### Acceptance Criteria

1. THE Admin_Panel SHALL be accessible at `GET /admin?shop={shop_domain}` and SHALL scope all settings reads and writes to the shop identified by the `shop` query parameter.
2. WHEN a merchant accesses the Admin_Panel, THE Admin_Panel SHALL verify the request is authenticated for that shop before serving the settings page.
3. THE Admin_Panel SHALL support session-based authentication scoped to the installing shop, replacing the global Basic Auth mechanism used in the single-store version.
4. WHEN a merchant submits updated settings via `POST /admin/settings`, THE Settings_Store SHALL validate that `currencies` is a non-empty object with all values being positive numbers, and that `dimensional_weight_divisor` is a positive number greater than zero.
5. IF settings validation fails, THEN THE Admin_Panel SHALL return HTTP 400 with a descriptive error message identifying the invalid field.
6. WHEN valid settings are submitted for a shop, THE Settings_Store SHALL persist the updated settings to the database for that shop only, without affecting any other shop's settings; THE Admin_Panel MAY return HTTP 400 if an error occurs during the request even when persistence itself has succeeded.
7. WHEN a merchant loads the Admin_Panel, THE Admin_Panel SHALL display the shop's current settings pre-populated in the form, fetched from the database.

---

### Requirement 7: Shop-Aware Rate Calculation

**User Story:** As a Shopify merchant, I want shipping rates calculated using my store's specific settings (currency rates, dimensional weight divisor), so that rates accurately reflect my business configuration.

#### Acceptance Criteria

1. WHEN `POST /rates` is received and HMAC-verified, THE Rates_Handler SHALL load the originating shop's settings from the Settings_Store using the shop domain identified from `X-Shopify-Shop-Domain`.
2. WHEN fetching product dimension metafields, THE Shopify_Admin_Client SHALL use the access token stored for the originating shop rather than a globally configured token.
3. WHEN computing chargeable weight, THE Dimensional_Weight_Calculator SHALL use the `dimensional_weight_divisor` from the originating shop's settings.
4. WHEN converting SFT prices to the checkout currency, THE Mapper SHALL use the currency exchange rates from the originating shop's settings.
5. WHEN the SFT_Client is in mock mode (`SFT_MOCK_MODE=true`), THE Rates_Handler SHALL use mock SFT responses for all shops to support development and testing without real SFT credentials.
6. WHEN the Shopify_Admin_Client is in mock mode (`SHOPIFY_ADMIN_MOCK_MODE=true`), THE Rates_Handler SHALL use mock product dimension data for all shops to support development and testing.
7. WHEN a `POST /rates` request is received, THE Rates_Handler SHALL return a response within 10 seconds, including all downstream API calls to Shopify Admin and SFT.

---

### Requirement 8: Business Logic Preservation

**User Story:** As a system operator, I want all existing shipping calculation logic preserved unchanged during the multi-store conversion, so that merchants experience the same rate accuracy as the original single-store backend.

#### Acceptance Criteria

1. THE Dimensional_Weight_Calculator SHALL compute chargeable weight as `max(actual_weight_kg, (length_cm × width_cm × height_cm) / divisor)` summed across all cart line items.
2. WHEN a cart item is missing one or more dimension metafields, THE Dimensional_Weight_Calculator SHALL fall back to the item's actual weight for that item and SHALL log a warning identifying the product, without failing the request.
3. THE Mapper SHALL convert SFT `pkAmount` (PKR) to the checkout currency by computing `pkAmount / pkrPerUsd * usdToTargetRate` using the shop's configured exchange rates.
4. WHEN SFT returns multiple services in the `data` array, THE Mapper SHALL include all services in the `rates` array returned to Shopify.
5. THE Mapper SHALL express `total_price` as a string of the price in the checkout currency's minor unit (cents/paise), rounded to the nearest integer.
6. IF SFT returns a response where `success` is not `true` or `data` is not an array, THEN THE Mapper SHALL return an empty `rates` array without throwing an error.
7. FOR ALL valid SFT response payloads, THE Mapper SHALL produce a `rates` array where every entry contains `service_name`, `service_code`, `total_price`, `currency`, and `description` fields.

---

### Requirement 9: Deployment and Public HTTPS

**User Story:** As a Shopify merchant, I want to install the App from a publicly accessible, HTTPS-secured URL, so that Shopify can reach the App's OAuth callback and CarrierService endpoint.

#### Acceptance Criteria

1. THE App SHALL be deployable to a platform that provides a stable public HTTPS URL (such as Railway or Render).
2. THE App SHALL read all secrets (Shopify API key, API secret, SFT credentials, database URL) from environment variables, with no secrets committed to the repository.
3. THE App SHALL expose a `GET /health` endpoint that returns HTTP 200 with a JSON body indicating the app's status and mock mode flags, usable as a deployment health check.
4. WHERE a `DATABASE_URL` environment variable is set to a Postgres connection string, THE Token_Store SHALL connect to Postgres; WHERE it is absent or set to a SQLite path, THE Token_Store SHALL connect to a local SQLite file; IF the app is configured for Postgres mode and `DATABASE_URL` is missing entirely, THE App SHALL fail startup with a clear error message requiring the variable.
5. THE App SHALL include a Prisma migration that creates the `shops`, `settings`, and `carrier_services` tables on first deploy.
