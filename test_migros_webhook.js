require('dotenv').config();
const jwt = require('jsonwebtoken');
const http = require('http');

// Verify we loaded the secret correctly
console.log('YS_SECRET loaded:', process.env.YS_SECRET ? 'YES' : 'NO');
console.log('YS_SECRET value:', process.env.YS_SECRET);

// Generate middleware token
const token = jwt.sign(
  { service: 'middleware' },
  process.env.YS_SECRET,
  { algorithm: 'HS512', expiresIn: '1h' }
);

console.log('Generated token:', token);

// Verify the token can be decoded
try {
  const decoded = jwt.verify(token, process.env.YS_SECRET, { algorithms: ['HS512'] });
  console.log('✅ Token verification successful:', decoded);
} catch (err) {
  console.log('❌ Token verification failed:', err.message);
}

// Test order payload
const orderData = {
  orderId: "MIGROS_12345_001",
  orderTime: 1769680000,
  orderAmount: 150.50,
  deliveryFee: 25.00,
  status: "Approved",
  items: [
    {
      itemId: "ITEM_001",
      itemName: "Kebab Special",
      quantity: 1,
      unitPrice: 125.50
    }
  ]
};

const postData = JSON.stringify(orderData);

const options = {
  hostname: '127.0.0.1',
  port: 5000,
  path: '/api/integrations/migros/order/MIGROS_TEST_001',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData),
    'Authorization': `Bearer ${token}`
  }
};

console.log('\n=== Sending Webhook Request ===');
console.log('Path:', options.path);
console.log('Token:', token);

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('\n=== Response ===');
    console.log('Status:', res.statusCode);
    console.log('Body:', data);
    
    try {
      const json = JSON.parse(data);
      console.log('Parsed:', JSON.stringify(json, null, 2));
      if (json.orderId) {
        console.log('\n✅ Order created successfully! Order ID:', json.orderId);
      }
    } catch (e) {
      console.log('(Could not parse as JSON)');
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e);
});

req.write(postData);
req.end();
