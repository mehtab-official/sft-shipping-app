/**
 * Minimal Shopify Admin GraphQL client, used only to fetch product dimension
 * metafields (length_cm/width_cm/height_cm) for dimensional-weight calculation.
 *
 * Requires SHOPIFY_ADMIN_API_TOKEN with the `read_products` scope, in addition
 * to the `write_shipping` scope scripts/registerCarrierService.js needs — the
 * same custom app token can hold both scopes.
 *
 * Expected metafields on each Product (merchant must set these):
 *   namespace: "dimensions"
 *   keys: length_cm, width_cm, height_cm   (numeric, in centimeters)
 */

const fetch = require('node-fetch');
const config = require('../config');

// Used only when SHOPIFY_ADMIN_MOCK_MODE=true, so the dimensional-weight
// pipeline can be built/tested before the real store + credentials exist.
const MOCK_DIMENSIONS_BY_PRODUCT_ID = {
  '1234567890': { lengthCm: 30, widthCm: 20, heightCm: 15 },
};

/**
 * @param {string[]} productIds - Shopify numeric product IDs (as strings), from
 *   each cart item's `product_id` field in the CarrierService rate request.
 * @returns {Promise<Record<string, {lengthCm:number,widthCm:number,heightCm:number}|null>>}
 */
async function fetchProductDimensions(productIds) {
  if (productIds.length === 0) return {};

  if (config.shopify.adminMockMode) {
    const result = {};
    for (const id of productIds) {
      result[id] = MOCK_DIMENSIONS_BY_PRODUCT_ID[id] || null;
    }
    return result;
  }

  const gids = productIds.map((id) => `gid://shopify/Product/${id}`);
  const query = `
    query GetProductDimensions($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          metafields(namespace: "dimensions", first: 10) {
            edges { node { key value } }
          }
        }
      }
    }
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); // 5s — leaves room for SFT call within Shopify's 10s deadline

  let response;
  try {
    response = await fetch(
      `https://${config.shopify.storeDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.shopify.adminApiToken,
        },
        body: JSON.stringify({ query, variables: { ids: gids } }),
        signal: controller.signal,
      }
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Shopify Admin API request timed out after 5s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Shopify Admin API error: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const result = {};

  productIds.forEach((productId, i) => {
    const node = body.data && body.data.nodes && body.data.nodes[i];
    if (!node || !node.metafields) {
      result[productId] = null;
      return;
    }

    const fields = {};
    for (const edge of node.metafields.edges) {
      fields[edge.node.key] = parseFloat(edge.node.value);
    }

    if (fields.length_cm && fields.width_cm && fields.height_cm) {
      result[productId] = { lengthCm: fields.length_cm, widthCm: fields.width_cm, heightCm: fields.height_cm };
    } else {
      result[productId] = null;
    }
  });

  return result;
}

module.exports = { fetchProductDimensions };
