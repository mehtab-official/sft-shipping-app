'use strict';
/**
 * End-to-end API test script — runs against the local server on port 3000.
 * Run with: node test/api-test.js
 */

const http = require('http');

const BASE = 'http://localhost:3000';
const OPERATOR_KEY = '2a2fb5b1f89dfe81432707c72bac2c9b8a2c2fd617ae14e947ed0e28ec700fec';

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function run() {
  console.log('\n========================================');
  console.log(' SFT Shipping App — Live API Test Suite');
  console.log('========================================\n');

  // ── 1. Health ──────────────────────────────────────────────────────────────
  console.log('── Health ──');
  const health = await request('GET', '/health');
  assert('GET /health → 200', health.status === 200);
  assert('/health status=ok', health.body?.status === 'ok');
  assert('/health has registeredStores', typeof health.body?.registeredStores === 'number');
  console.log(`     registeredStores: ${health.body?.registeredStores}`);

  // ── 2. Operator auth ───────────────────────────────────────────────────────
  console.log('\n── Operator Auth ──');
  const noAuth = await request('GET', '/operator/stores');
  assert('No auth header → 401 (key configured)', noAuth.status === 401);

  const badAuth = await request('GET', '/operator/stores', { headers: { Authorization: 'Bearer wrongkey' } });
  assert('Wrong operator key → 401', badAuth.status === 401);

  // ── 3. List stores ─────────────────────────────────────────────────────────
  console.log('\n── Operator: Store List ──');
  const listRes = await request('GET', '/operator/stores', { headers: { Authorization: `Bearer ${OPERATOR_KEY}` } });
  assert('GET /operator/stores → 200', listRes.status === 200);
  assert('Response is array', Array.isArray(listRes.body));
  const hasMigrated = listRes.body?.some(s => s.shop_domain === 'sft-test-store.myshopify.com');
  assert('Migrated store present', hasMigrated);
  console.log(`     Stores: ${JSON.stringify(listRes.body)}`);

  // ── 4. Register test store ─────────────────────────────────────────────────
  console.log('\n── Operator: Register Store ──');
  const regRes = await request('POST', '/operator/stores', {
    headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
    body: { shop_domain: 'apitest.myshopify.com', shopify_admin_api_token: 'shpat_test', admin_username: 'testadmin', admin_password: 'testpass123' },
  });
  assert('POST /operator/stores (new) → 201', regRes.status === 201, `got ${regRes.status}`);
  assert('Response has shop_domain', regRes.body?.shop_domain === 'apitest.myshopify.com');

  // ── 5. Duplicate registration → 409 ───────────────────────────────────────
  const dupRes = await request('POST', '/operator/stores', {
    headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
    body: { shop_domain: 'apitest.myshopify.com', shopify_admin_api_token: 'shpat_test', admin_username: 'testadmin', admin_password: 'testpass123' },
  });
  assert('Duplicate registration → 409', dupRes.status === 409, `got ${dupRes.status}`);

  // ── 6. Admin settings ─────────────────────────────────────────────────────
  console.log('\n── Per-Store Admin Settings ──');

  const unknownStore = await request('GET', '/admin/doesnotexist.myshopify.com/settings', {
    headers: { Authorization: basicAuth('testadmin', 'testpass123') },
  });
  assert('Unknown store → 404', unknownStore.status === 404, `got ${unknownStore.status}`);

  const badPass = await request('GET', '/admin/apitest.myshopify.com/settings', {
    headers: { Authorization: basicAuth('testadmin', 'wrongpassword') },
  });
  assert('Wrong password → 401', badPass.status === 401, `got ${badPass.status}`);

  const getSettings = await request('GET', '/admin/apitest.myshopify.com/settings', {
    headers: { Authorization: basicAuth('testadmin', 'testpass123') },
  });
  assert('Correct credentials → 200', getSettings.status === 200, `got ${getSettings.status}`);
  assert('Settings has currencies', typeof getSettings.body?.currencies === 'object');
  assert('Settings has dimensionalWeightDivisor', typeof getSettings.body?.dimensionalWeightDivisor === 'number');
  console.log(`     Settings: ${JSON.stringify(getSettings.body)}`);

  const updateSettings = await request('POST', '/admin/apitest.myshopify.com/settings', {
    headers: { Authorization: basicAuth('testadmin', 'testpass123') },
    body: { currencies: { USD: 1, CAD: 1.45, PKR: 280 }, dimensionalWeightDivisor: 6000 },
  });
  assert('POST settings update → 200', updateSettings.status === 200, `got ${updateSettings.status}`);
  assert('Updated divisor = 6000', updateSettings.body?.dimensionalWeightDivisor === 6000);

  const badRate = await request('POST', '/admin/apitest.myshopify.com/settings', {
    headers: { Authorization: basicAuth('testadmin', 'testpass123') },
    body: { currencies: { USD: -1 }, dimensionalWeightDivisor: 5000 },
  });
  assert('Negative currency rate → 400', badRate.status === 400, `got ${badRate.status}`);
  console.log(`     Error: ${badRate.body?.error}`);

  // ── 7. Cross-store credential denial ──────────────────────────────────────
  console.log('\n── Store Isolation ──');
  const crossStore = await request('GET', '/admin/sft-test-store.myshopify.com/settings', {
    headers: { Authorization: basicAuth('testadmin', 'testpass123') },
  });
  assert('apitest creds on migrated store → 401', crossStore.status === 401, `got ${crossStore.status}`);

  // ── 8. /rates routing ─────────────────────────────────────────────────────
  console.log('\n── /rates Routing ──');

  const noShop = await request('POST', '/rates', {
    body: { rate: { items: [], destination: { country_code: 'GB' }, currency: 'USD' } },
  });
  assert('No shop_domain → {rates:[]}', Array.isArray(noShop.body?.rates) && noShop.body.rates.length === 0);

  const unknownShop = await request('POST', '/rates', {
    body: { rate: { shop_domain: 'notregistered.myshopify.com', items: [], destination: { country_code: 'GB' }, currency: 'USD' } },
  });
  assert('Unknown shop_domain → {rates:[]}', Array.isArray(unknownShop.body?.rates) && unknownShop.body.rates.length === 0);

  // ── 9. /rates with real SFT call ──────────────────────────────────────────
  console.log('\n── /rates Live SFT Call (SFT_MOCK_MODE=false) ──');
  console.log('     Calling SFT API...');
  try {
    const liveRates = await request('POST', '/rates', {
      body: {
        rate: {
          shop_domain: 'sft-test-store.myshopify.com',
          items: [{ product_id: '1234567890', grams: 500, quantity: 1 }],
          destination: { country_code: 'GB', postal_code: 'SW1A 1AA' },
          currency: 'USD',
        },
      },
    });
    assert('POST /rates real store → 200', liveRates.status === 200);
    const gotRates = Array.isArray(liveRates.body?.rates);
    assert('Response has rates array', gotRates);
    if (liveRates.body?.rates?.length > 0) {
      assert('Rates returned from SFT', true);
      console.log(`     Rates count: ${liveRates.body.rates.length}`);
      liveRates.body.rates.forEach(r => {
        console.log(`     → ${r.service_name} | ${r.total_price} ${r.currency} | ${r.description}`);
      });
    } else {
      console.log('     [INFO] SFT returned empty rates (may be no service available for GB with test credentials)');
    }
  } catch (err) {
    assert('POST /rates live SFT', false, err.message);
  }

  // ── 10. Delete test store ─────────────────────────────────────────────────
  console.log('\n── Cleanup ──');
  const deleteRes = await request('DELETE', '/operator/stores/apitest.myshopify.com', {
    headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
  });
  assert('DELETE test store → 200', deleteRes.status === 200, `got ${deleteRes.status}`);

  const deleteAgain = await request('DELETE', '/operator/stores/apitest.myshopify.com', {
    headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
  });
  assert('DELETE non-existent store → 404', deleteAgain.status === 404, `got ${deleteAgain.status}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log(` PASSED: ${passed}  |  FAILED: ${failed}`);
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test runner error:', err); process.exit(1); });
