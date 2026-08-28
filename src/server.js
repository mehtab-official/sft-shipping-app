const express = require('express');
const config = require('./config');
const ratesRouter = require('./routes/rates');
const adminRouter = require('./routes/admin');
const operatorRouter = require('./routes/operator');
const storeRegistry = require('./services/storeRegistry');
const { runMigration } = require('./migrate');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sftMockMode: config.sft.mockMode,
    shopifyAdminMockMode: config.shopify.adminMockMode,
    registeredStores: storeRegistry.listStores().length,
  });
});

app.use(ratesRouter);
app.use(adminRouter);
app.use(operatorRouter);

storeRegistry.initDb();
runMigration();

app.listen(config.port, () => {
  console.log(`SFT shipping-rates backend listening on port ${config.port}`);
  console.log(`SFT_MOCK_MODE=${config.sft.mockMode}, SHOPIFY_ADMIN_MOCK_MODE=${config.shopify.adminMockMode}`);
  console.log(`Store-specific admin: http://localhost:${config.port}/admin/:shopDomain`);
});
