/**
 * Client for SmartCourier's (SFT) Rate Inquiry API.
 *
 * CONFIRMED:
 *   - Base URL:      https://smartcourier.pk/api
 *   - Endpoint:      GET /v2/tarrif  (spelling confirmed correct)
 *   - Headers:       X-API-KEY, credentials
 *   - credentials =  Base64( username + ":" + Base64(password) )
 *   - Query params:  countryCode (req), doctype (req), weight (req), zipcode (opt)
 *   - Response format: JSON (the "PDF document" line on doc page 1 was wrong/outdated)
 *   - `data` can contain multiple services — all should be shown at checkout
 *   - Checkout price uses `amount`, displayed in USD (see mapper.js for the residual
 *     risk note on `amount`'s currency denomination)
 *
 * STILL OPEN (tracked in README.md):
 *   1. Exact weight unit (working assumption: KG, decimal = grams — see mapper.js)
 *   2. Shape of the no-rate / error response
 *   3. Test credentials — not yet available, so SFT_MOCK_MODE stays true for now
 */

const fetch = require('node-fetch');
const config = require('../config');

// Mock response mirrors the sample JSON from the API PDF exactly, so the rest
// of the pipeline can be built and tested now, without needing live test
// credentials (still pending — see open question #3 above).
const MOCK_RESPONSE = {
  data: [
    {
      countryCode: 'GB',
      countryName: '',
      courierName: 'DPD UK',
      doxType: 'NON-DOX',
      wefDate: null,
      currency: 'PKR',
      exRate: 1.0,
      amount: 1.0,
      pkAmount: 1,
      fcRatePerKg: 1.0,
      pkRatePerKg: 1,
      zone: 'GB',
      serviceCode: 'UK',
      serviceName: 'VIA UK LOCAL DPD EXPRESS',
      transitTime: 0,
    },
  ],
  success: true,
  responseCode: 0,
};

/**
 * @param {{countryCode: string, doctype: string, weight: number, zipcode?: string}} params
 * @returns {Promise<object>} raw SFT response body (JSON, confirmed)
 */
async function getRates(params) {
  if (config.sft.mockMode) {
    return MOCK_RESPONSE;
  }

  const url = new URL(`${config.sft.baseUrl}/v2/tarrif`);
  url.searchParams.set('countryCode', params.countryCode);
  url.searchParams.set('doctype', params.doctype);
  url.searchParams.set('weight', String(params.weight));
  if (params.zipcode) url.searchParams.set('zipcode', params.zipcode);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-API-KEY': config.sft.apiKey,
        'credentials': config.sft.credentials,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('SFT API request timed out after 7s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`SFT API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

module.exports = { getRates };
