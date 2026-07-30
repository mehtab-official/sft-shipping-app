require('dotenv').config();

function bool(val, fallback) {
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

const config = {
  port: process.env.PORT || 3000,

  sft: {
    baseUrl: process.env.SFT_BASE_URL || 'https://smartcourier.pk/api',
    apiKey: process.env.SFT_API_KEY || '',
    credentials: process.env.SFT_CREDENTIALS || '',
    // Stays true until real test credentials exist (see README open questions).
    mockMode: bool(process.env.SFT_MOCK_MODE, true),
  },

  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || '',
    adminApiToken: process.env.SHOPIFY_ADMIN_API_TOKEN || '',
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-10',
    carrierServiceCallbackUrl: process.env.CARRIER_SERVICE_CALLBACK_URL || '',
    // Stays true until the store + product dimension metafields are real and
    // SHOPIFY_ADMIN_API_TOKEN has the read_products scope.
    adminMockMode: bool(process.env.SHOPIFY_ADMIN_MOCK_MODE, true),
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  },
};

module.exports = config;
