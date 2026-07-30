/**
 * Translates between Shopify's CarrierService contract and SFT's Rate Inquiry API.
 *
 * Shopify -> SFT request mapping:
 *   Customer country        -> countryCode
 *   Product/shipment type   -> doctype
 *   Chargeable weight (kg)  -> weight   (max of actual vs dimensional — see dimensionalWeight.js)
 *   Customer postal code    -> zipcode
 *
 * SFT -> Shopify response mapping:
 *   courierName + serviceName -> service_name
 *   serviceCode                -> service_code
 *   amount (converted)         -> total_price
 *   target currency             -> currency
 *   transitTime                -> description
 */

// Very likely correct (Shopify store only sells physical parcels, never documents),
// but not yet explicitly confirmed by the group — low risk either way.
const DEFAULT_DOCTYPE = 'NON-DOX';

/**
 * @param {object} shopifyRateRequest - the `rate` object Shopify POSTs to the callback URL
 * @param {number} chargeableWeightKg - max(actual weight, dimensional weight), precomputed
 * @returns {{countryCode: string, doctype: string, weight: number, zipcode?: string}}
 */
function mapShopifyRequestToSftParams(shopifyRateRequest, chargeableWeightKg) {
  const destination = shopifyRateRequest.destination || {};

  return {
    countryCode: destination.country_code || destination.country,
    doctype: DEFAULT_DOCTYPE,
    weight: chargeableWeightKg,
    zipcode: destination.postal_code || undefined,
  };
}

/**
 * @param {object} sftResponse - raw response body from SFT's /v2/tarrif (JSON, confirmed)
 * @param {{code: string, rate: number}} targetCurrency - checkout currency + its
 *   admin-configured exchange rate (units of that currency per 1 USD)
 * @returns {Array<object>} Shopify-shaped rate objects for the `rates` array
 */
function mapSftResponseToShopifyRates(sftResponse, targetCurrency) {
  if (!sftResponse || sftResponse.success !== true || !Array.isArray(sftResponse.data)) {
    // TODO (open question, still pending — contact SFT's Rate department): confirm
    // the actual no-rate / error response shape instead of just guessing here.
    return [];
  }

  // CONFIRMED: multiple services in `data` should all be shown at checkout —
  // every entry is mapped below, not just the first.
  return sftResponse.data.map((entry) => {
    // `currency` is "PKR" and `amount` = `pkAmount` (PKR-denominated).
    // `exRate` is the PKR-to-FC (foreign currency) rate SFT uses internally.
    // To get USD: pkAmount / exRate gives the FC amount when exRate > 1,
    // but since exRate=1 here and currency=PKR, we convert PKR→USD directly
    // using a fixed divisor. The PKR/USD rate needs to be admin-configurable
    // just like other currencies — we use the "PKR" entry from settings if present,
    // otherwise fall back to a hardcoded approximate rate.
    // NOTE: amount == pkAmount in real responses, so we use pkAmount for clarity.
    const pkrAmount = entry.pkAmount || entry.amount;

    // targetCurrency.pkrRate = how many PKR per 1 unit of targetCurrency.
    // We go PKR -> target currency directly:
    //   priceInTargetCurrency = pkrAmount / pkrPerTargetUnit
    // targetCurrency.pkrRate must be set in admin settings as "PKR per 1 <target>"
    // e.g. if 1 CAD = 200 PKR, set PKR_PER_CAD = 200 in settings.
    // For now we convert via USD: pkrAmount / pkrPerUsd * usdToTargetRate
    const pkrPerUsd = targetCurrency.pkrPerUsd || 280; // fallback: ~280 PKR = 1 USD
    const priceInUsd = pkrAmount / pkrPerUsd;
    const convertedPrice = priceInUsd * targetCurrency.rate;
    const totalPriceInSubunit = Math.round(convertedPrice * 100); // Shopify expects cents as a string

    return {
      service_name: `${entry.courierName} - ${entry.serviceName}`,
      service_code: entry.serviceCode,
      total_price: String(totalPriceInSubunit),
      currency: targetCurrency.code,
      description: `Estimated transit time: ${entry.transitTime} day(s)`,
    };
  });
}

module.exports = { mapShopifyRequestToSftParams, mapSftResponseToShopifyRates, DEFAULT_DOCTYPE };
