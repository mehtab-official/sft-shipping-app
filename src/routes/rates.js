const express = require('express');
const sftClient = require('../services/sftClient');
const shopifyAdmin = require('../services/shopifyAdmin');
const settingsStore = require('../services/settingsStore');
const storeRegistry = require('../services/storeRegistry');
const { computeChargeableWeightKg } = require('../services/dimensionalWeight');
const { mapShopifyRequestToSftParams, mapSftResponseToShopifyRates } = require('../services/mapper');

const router = express.Router();

/**
 * Shopify CarrierService callback.
 * Shopify POSTs { rate: { origin, destination, items, currency, locale } } at checkout
 * and expects { rates: [...] } back within ~10 seconds.
 * https://shopify.dev/docs/apps/build/shipping/carrier-calculated-rates
 *
 * IMPORTANT: Shopify's rate request body does NOT include which store/shop is
 * calling (no shop_domain field, no X-Shopify-Shop-Domain header) — this is
 * confirmed by Shopify's own CarrierService docs. In a multi-store setup, each
 * store's CarrierService MUST be registered with a callback_url that encodes
 * its own shop domain as a query string, e.g.
 *   https://<app>/rates?shop=<shop-domain>.myshopify.com
 * See scripts/registerCarrierService.js. We read that query param below; the
 * body's shop_domain (never actually sent by Shopify) is kept only as a
 * legacy/test fallback.
 */
router.post('/rates', async (req, res) => {
  try {
    const shopifyRateRequest = req.body && req.body.rate;
    if (!shopifyRateRequest) {
      return res.status(400).json({ rates: [] });
    }

    // 0. Resolve shop domain → Store_Record.
    // Primary source: the ?shop= query param on the callback URL (Shopify echoes
    // the callback_url exactly as registered, including its query string, on every
    // rate request). Fallback: rate.shop_domain in the body, for any legacy/manual
    // callers that still send it — Shopify itself never populates this field.
    const shopDomain = (req.query && req.query.shop) || shopifyRateRequest.shop_domain;
    if (!shopDomain || typeof shopDomain !== 'string') {
      console.warn('[rates] missing or non-string shop domain in rate request (checked ?shop= and body.shop_domain):', typeof shopDomain);
      return res.json({ rates: [] });
    }

    const storeRecord = storeRegistry.findStoreFull(shopDomain);
    if (!storeRecord) {
      // Unknown store — expected for unregistered domains, no log needed
      return res.json({ rates: [] });
    }

    const items = shopifyRateRequest.items || [];

    // 1. Fetch product dimensions (mandatory metafields: dimensions.length_cm/width_cm/height_cm)
    const productIds = [...new Set(items.map((item) => item.product_id).filter(Boolean))];
    const storeContext = {
      storeDomain: storeRecord.shopDomain,
      adminApiToken: storeRecord.adminApiToken,
    };
    const dimensionsByProductId = await shopifyAdmin.fetchProductDimensions(productIds, storeContext);

    // 2. Chargeable weight = max(actual weight, dimensional weight)
    const divisor = settingsStore.getDimensionalWeightDivisor(shopDomain);
    const { chargeableWeightKg } = computeChargeableWeightKg(items, dimensionsByProductId, divisor);

    // 3. Build SFT request params
    const sftParams = mapShopifyRequestToSftParams(shopifyRateRequest, chargeableWeightKg);

    if (!sftParams.countryCode || !sftParams.weight) {
      // Not enough info to quote — return no rates rather than erroring the checkout.
      return res.json({ rates: [] });
    }

    // 4. Call SFT
    const sftResponse = await sftClient.getRates(sftParams);

    // 5. Convert to the checkout's currency (customer-selected, via Shopify) using
    //    admin-configured exchange rates, then map to Shopify's rate contract
    const targetCurrency = settingsStore.getCurrencyRate(shopDomain, shopifyRateRequest.currency);
    const rates = mapSftResponseToShopifyRates(sftResponse, targetCurrency);

    return res.json({ rates });
  } catch (err) {
    console.error('[rates] failed to fetch SFT rates:', err.message);
    // Fail soft: an empty rates array just means this shipping option doesn't show,
    // rather than breaking the customer's checkout.
    return res.json({ rates: [] });
  }
});

module.exports = router;
