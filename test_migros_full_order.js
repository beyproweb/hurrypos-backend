require('dotenv').config();
const jwt = require('jsonwebtoken');
const http = require('http');

// Generate middleware token
const token = jwt.sign(
  { service: 'middleware' },
  process.env.YS_SECRET,
  { algorithm: 'HS512', expiresIn: '1h' }
);

console.log('✅ Generated middleware token');

// Full test order with all details
const orderData = {
  orderId: "MIGROS_FULL_TEST_" + Date.now(),
  orderTime: Math.floor(Date.now() / 1000),
  orderAmount: 350.75,
  deliveryFee: 35.00,
  status: "Approved",
  notes: "Please ring doorbell twice, leave at front door",
  customer: {
    name: "Ahmet Yilmaz",
    phone: "+905551234567",
    mobilePhone: "+905551234567"
  },
  address: {
    street: "Istiklal Caddesi",
    number: "42",
    city: "Istanbul",
    district: "Beyoglu",
    postcode: "34433"
  },
  delivery: {
    address: {
      street: "Istiklal Caddesi",
      number: "42",
      city: "Istanbul",
      district: "Beyoglu",
      postcode: "34433"
    },
    deliveryInstructions: "Ring doorbell twice, use side entrance"
  },
  paymentType: "Online",
  items: [
    {
      itemId: "ITEM_KEBAB_001",
      itemName: "Adana Kebab",
      quantity: 2,
      unitPrice: 125.00,
      notes: "Extra spicy, no onion"
    },
    {
      itemId: "ITEM_SALAD_001",
      itemName: "Shepherd Salad",
      quantity: 1,
      unitPrice: 35.75,
      notes: "Dressing on the side"
    },
    {
      itemId: "ITEM_DRINK_001",
      itemName: "Ayran (Large)",
      quantity: 2,
      unitPrice: 12.50
    }
  ],
  extras: [
    {
      extraId: "EXTRA_SAUCE_001",
      extraName: "Hot Sauce",
      quantity: 1,
      price: 5.00
    },
    {
      extraId: "EXTRA_BREAD_001",
      extraName: "Extra Pita Bread",
      quantity: 2,
      price: 3.00
    }
  ],
  comments: {
    customerComment: "Please make it fresh!",
    vendorComment: "Standard preparation"
  }
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

console.log('\n=== Testing Full Migros Order ===');
console.log('Order ID:', orderData.orderId);
console.log('Items:', orderData.items.length);
console.log('Extras:', orderData.extras.length);
console.log('Total Amount:', orderData.orderAmount);

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('\n=== Response ===');
    console.log('Status:', res.statusCode);
    
    try {
      const json = JSON.parse(data);
      console.log('Response:', JSON.stringify(json, null, 2));
      
      if (json.orderId || json.id) {
        const beyprosOrderId = json.orderId || json.id;
        console.log('\n✅ Order created successfully!');
        console.log('Beypro Order ID:', beyprosOrderId);
        console.log('\nTo verify items in DB, run:');
        console.log(`psql postgresql://postgres:1234@localhost:5432/hurrypos -c "SELECT id, name, quantity, price FROM order_items WHERE order_id = ${beyprosOrderId};"`);
      } else if (json.message) {
        console.log('Message:', json.message);
      }
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request error:', e.message);
});

req.write(postData);
req.end();
