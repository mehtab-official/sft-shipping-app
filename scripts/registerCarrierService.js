/**
 * One-time script: registers this backend's /rates endpoint as a CarrierService
 * on the CLIENT's live Shopify store, so it shows up as a shipping option at checkout.
 *
 * Prerequisites before running this:
 *   1. Client's Shopify plan is upgraded to support carrier-calculated shipping.
 *   2. A custom app exists on the client's store with the `write_shipping` Admin API scope,
 *      and you have its Admin API access token.
 *   3. This backend is deployed and publicly reachable over HTTPS (Shopify calls it live —
 *      no localhost/ngrok URLs in production).
 *   4. .env has SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, CARRIER_SERVICE_CALLBACK_URL set.
 *
 * Run: npm run register-carrier-service
 */

require('dotenv').config();
const fetch = require('node-fetch');
const config = require('../src/config');

const API_VERSION = '2024-10';

async function registerCarrierService() {
  const { storeDomain, adminApiToken, carrierServiceCallbackUrl } = config.shopify;

  if (!storeDomain || !adminApiToken || !carrierServiceCallbackUrl) {
    console.error('Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, or CARRIER_SERVICE_CALLBACK_URL in .env');
    process.exit(1);
  }

  const url = `https://${storeDomain}/admin/api/${API_VERSION}/carrier_services.json`;

  const body = {
    carrier_service: {
      name: 'SmartCourier Live Rates',
      callback_url: carrierServiceCallbackUrl,
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

  console.log('CarrierService registered:', result);
}

registerCarrierService();
