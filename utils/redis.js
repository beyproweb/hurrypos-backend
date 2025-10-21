// utils/redis.js
const Redis = require("ioredis");
let redis;

try {
  redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  console.log("✅ Redis connected for driver cache");
} catch (err) {
  console.warn("⚠️ Redis not available, fallback to memory");
  redis = null;
}

module.exports = redis;
