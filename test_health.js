const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { id: 1, restaurant_id: 1, role: 'admin' },
  process.env.JWT_SECRET,
  { algorithm: 'HS512', expiresIn: '24h' }
);
console.log(token);
