# SFT Shipping Rates — Shopify CarrierService Backend

Node.js/Express service that plugs SmartCourier's (SFT) Rate Inquiry API into
Shopify checkout as a live, carrier-calculated shipping rate — with
dimensional-weight pricing and multi-currency conversion.

## Architecture

```
Shopify Checkout (customer picks currency via Shopify)
      │  POST /rates  (cart, origin, destination, currency)
      ▼
This backend (Express)
      │
      ├─▶ Shopify Admin API (GraphQL)         — fetch product dimension metafields
      │      per item: length_cm / width_cm / height_cm
      │
      ├─▶ dimensionalWeight.js                — chargeable weight =
      │      max(actual weight, (L×W×H)/divisor), summed across cart
      │
      ├─▶ SFT Rate Inquiry API                — GET /v2/tarrif?countryCode&doctype&weight&zipcode
      │      (JSON response, confirmed)
      │
      └─▶ settingsStore.js                    — convert SFT's `amount` (USD) into
             the checkout's currency using an admin-configured exchange rate
      ▼
Mapped to Shopify's { rates: [...] } contract, in the customer's checkout currency
      ▼
Shown as a shipping option at checkout
```

Two moving pieces beyond the original backend-only plan:
- **`/admin`** — a Basic-Auth-protected settings page (not inside Shopify admin)
  where currency exchange rates and the dimensional-weight divisor can be updated
  without a redeploy.
- **Shopify Admin API calls** — the backend now calls back into Shopify at rate-request
  time to read each product's dimension metafields (needs `read_products` scope).

## Project layout

```
src/
  config.js                 env var loading
  server.js                 Express app entry, health check
  routes/
    rates.js                POST /rates — the Shopify CarrierService callback
    admin.js                GET /admin (settings page), GET/POST /admin/settings (API)
  middleware/
    adminAuth.js            Basic Auth gate for /admin routes
  services/
    sftClient.js            talks to SFT's /v2/tarrif (mock + real modes)
    shopifyAdmin.js          fetches product dimension metafields (mock + real modes)
    dimensionalWeight.js     chargeable weight = max(actual, dimensional)
    settingsStore.js         currency rates + divisor, persisted to data/settings.json
    mapper.js                Shopify <-> SFT field + currency mapping
public/
  admin.html                 settings page UI (vanilla JS, no build step)
data/
  settings.default.json      seed values, copied to settings.json on first run
scripts/
  registerCarrierService.js  one-time: registers /rates with the client's store
test/
  sample-request.json        example Shopify CarrierService POST body, 2 items
                              (one with mock dimensions, one without — tests both paths)
```

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Health check: `GET http://localhost:3000/health`

Settings page: `http://localhost:3000/admin` (login with `ADMIN_USERNAME`/`ADMIN_PASSWORD`
from `.env` — change the default password before deploying anywhere public).

Test the rates endpoint locally:
```bash
curl -X POST http://localhost:3000/rates \
  -H "Content-Type: application/json" \
  -d @test/sample-request.json
```

With `SFT_MOCK_MODE=true` and `SHOPIFY_ADMIN_MOCK_MODE=true` (both default) this
runs the full pipeline — dimension lookup, chargeable weight, SFT call, currency
conversion — against mock data, no real credentials needed.

## Product setup required in Shopify (mandatory dimensions)

Every product needs three metafields, namespace `dimensions`:

| Key | Type | Description |
|---|---|---|
| `length_cm` | number_decimal | Length in cm |
| `width_cm` | number_decimal | Width in cm |
| `height_cm` | number_decimal | Height in cm |

Set these up once under Shopify Admin → Settings → Custom data → Products →
Add definition (mark as "required" if your Shopify plan supports enforcing that
at the product-editor level). If a product is missing dimensions at rate-request
time, this backend soft-fails that item back to actual weight only and logs a
warning — it will NOT break checkout, but it also won't get dimensional-weight
pricing until the merchant fills them in.

## Currency handling

Shopify already tells us the checkout's currency in the incoming rate request
(`rate.currency`) — that's driven by Shopify's own multi-currency/Markets
settings, so there's no need to build a separate currency picker. This backend:

1. Reads `rate.currency` from the incoming request (e.g. `CAD`).
2. Looks up the admin-configured rate for that currency via `/admin` (units of
   that currency per 1 USD).
3. Converts SFT's `amount` (USD) by that rate, returns `total_price` + `currency`
   matching the checkout.

If the checkout currency isn't one of the configured ones, it falls back to USD
(rate 1) rather than failing the whole checkout — logged as a warning.

## Status

### Confirmed
| # | Question | Answer |
|---|----------|--------|
| 1 | Weight unit | KG — Shopify provides grams, divided by 1000 in `dimensionalWeight.js` |
| 2 | Response format | JSON (the "PDF" line on doc page 1 was wrong/outdated) |
| 3 | Checkout price field | `amount` = foreign currency (treated as USD — see note below) |
| 4 | Multiple services in `data`? | Yes — all shown at checkout, already implemented |
| 8 | Endpoint spelling `/v2/tarrif` | Correct as-is |

### Still open — do not flip `SFT_MOCK_MODE=false` / `SHOPIFY_ADMIN_MOCK_MODE=false` until relevant items land
| # | Question | Where it matters in code |
|---|----------|---------------------------|
| 2b | Is `amount` (foreign currency) always USD, regardless of destination country? | `src/services/mapper.js` — `priceInUsd`. Likely yes (Pakistani courier "FC" convention is USD), but one explicit confirmation would remove all doubt before high-volume launch. |
| 5 | Should `doctype` always be `NON-DOX`? | `src/services/mapper.js` — `DEFAULT_DOCTYPE`. Very likely yes, low risk either way. |
| 6 | Shape of the no-rate / error response | `src/services/mapper.js` — early-return branch. **Action: contact SFT's Rate department directly** (per their instruction). |
| 7 | Test credentials/API key | Still not provided — needed before any real SFT call can be tested. |
| 9 | Dimensional weight divisor (SFT's actual value) | `data/settings.default.json` / `/admin` page. Defaulted to 5000 (common international courier standard) — needs SFT confirmation. |
| 10 | Does SFT expect per-shipment (packed) dimensional weight, or is summing each item's dimensional weight across the cart acceptable? | `src/services/dimensionalWeight.js` — flagged assumption in the file's header comment. |

## Next steps (in order)

1. Get SFT test credentials (#7) — biggest remaining blocker to real testing.
2. Contact SFT's Rate department for the error/no-rate response shape (#6).
3. Get confirmation on weight unit (#1), dimensional weight divisor (#9), and the
   `amount` currency question (#2b).
4. Set real exchange rates via `/admin` (defaults are placeholders).
5. Add `dimensions.length_cm/width_cm/height_cm` metafields to real products in Shopify.
6. Once SFT credentials exist, flip `SFT_MOCK_MODE=false` and test against the real endpoint.
7. Create Shopify Partner account + development store (independent, can happen anytime).
8. Deploy this backend with a stable public HTTPS URL (Railway/Render recommended);
   set a strong `ADMIN_PASSWORD` before it's internet-reachable.
9. Get a Shopify Admin API token with `write_shipping` + `read_products` scopes on
   the client's store, set `SHOPIFY_ADMIN_MOCK_MODE=false`.
10. Once the client's store plan is upgraded, run `npm run register-carrier-service`.
11. Test a real checkout end-to-end with a real destination address and real currency.

## Security

SFT API key, portal credentials, and the Shopify Admin API token live only in
`.env` / hosting provider secrets — never in Shopify theme code, never in frontend
JS, never committed to git (`.env` and `data/settings.json` are gitignored). All
calls to SFT and Shopify Admin happen server-side, in this backend. The `/admin`
settings page is Basic-Auth protected — set a real password before deploying.
