require('dotenv').config();
const jwt = require('jsonwebtoken');
const http = require('http');

const token = jwt.sign(
  { service: 'middleware' },
  process.env.YS_SECRET,
  { algorithm: 'HS512', expiresIn: '1h' }
);

const data = JSON.stringify({
  orderId: 'SIMPLE_TEST_' + Date.now(),
  orderTime: Math.floor(Date.now() / 1000),
  status: 'Approved',
  items: [
    { itemId: 'ITEM_KEBAB', itemName: 'Kebab', quantity: 2, unitPrice: 100 }
  ]
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 5000,
  path: '/api/integrations/migros/order/MIGROS_TEST_001',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Authorization': 'Bearer ' + token
  }
}, (res) => {
  let response = '';
  res.on('data', (chunk) => { response += chunk; });
  res.on('end', () => {
    try {
      const json = JSON.parse(response);
      console.log('✅ Order ID:', json.orderId || json.id);
    } catch (e) {
      console.log('Response:', response);
    }
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});

req.write(data);
req.end();
