/**
 * One-time script: registers this backend's /rates endpoint as a CarrierService
 * on a Shopify store, so it shows up as a shipping option at checkout.
 *
 * Prerequisites before running this:
 *   1. The store's Shopify plan supports carrier-calculated shipping.
 *   2. A custom app exists on the store with the `write_shipping` Admin API scope,
 *      and you have its Admin API access token.
 *   3. This backend is deployed and publicly reachable over HTTPS (Shopify calls it live —
 *      no localhost/ngrok URLs in production).
 *
 * Usage:
 *   node scripts/registerCarrierService.js \
 *     --shop-domain=example.myshopify.com \
 *     --admin-api-token=shpat_xxx \
 *     --callback-url=https://your-app.example.com/rates
 *
 * Or set environment variables and run without flags:
 *   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_API_TOKEN=... CARRIER_SERVICE_CALLBACK_URL=... npm run register-carrier-service
 */

require('dotenv').config();
const fetch = require('node-fetch');
const config = require('../src/config');

const API_VERSION = '2024-10';

/**
 * Parse CLI arguments from process.argv.
 * Supports both --key=value and --key value forms.
 * @param {string[]} argv - process.argv slice (starting from index 2)
 * @returns {Object} parsed key→value map (keys are camelCase)
 */
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --key=value form
    const eqMatch = arg.match(/^--([a-zA-Z0-9-]+)=(.*)$/);
    if (eqMatch) {
      result[eqMatch[1]] = eqMatch[2];
      continue;
    }
    // --key value form
    const flagMatch = arg.match(/^--([a-zA-Z0-9-]+)$/);
    if (flagMatch && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      result[flagMatch[1]] = argv[i + 1];
      i++;
    }
  }
  return result;
}

async function registerCarrierService() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve each required value: CLI arg first, then env var fallback.
  const shopDomain =
    args['shop-domain'] ||
    process.env.SHOPIFY_STORE_DOMAIN ||
    '';

  const adminApiToken =
    args['admin-api-token'] ||
    process.env.SHOPIFY_ADMIN_API_TOKEN ||
    '';

  const callbackUrl =
    args['callback-url'] ||
    process.env.CARRIER_SERVICE_CALLBACK_URL ||
    config.shopify.carrierServiceCallbackUrl ||
    '';

  // Validate — all three are required.
  if (!shopDomain) {
    console.error('Error: --shop-domain (or SHOPIFY_STORE_DOMAIN env var) is required.');
    process.exit(1);
  }
  if (!adminApiToken) {
    console.error('Error: --admin-api-token (or SHOPIFY_ADMIN_API_TOKEN env var) is required.');
    process.exit(1);
  }
  if (!callbackUrl) {
    console.error('Error: --callback-url (or CARRIER_SERVICE_CALLBACK_URL env var) is required.');
    process.exit(1);
  }

  const url = `https://${shopDomain}/admin/api/${API_VERSION}/carrier_services.json`;

  const body = {
    carrier_service: {
      name: 'SmartCourier Live Rates',
      callback_url: callbackUrl,
      service_discovery: true,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminApiToken,
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error('Failed to register CarrierService:', response.status, result);
    process.exit(1);
  }

  const carrierId = result.carrier_service && result.carrier_service.id;
  console.log(`CarrierService registered successfully. ID: ${carrierId}`);
  console.log('Full response:', result);
}

registerCarrierService();
