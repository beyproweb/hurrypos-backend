const Redis = require("ioredis");

const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisTlsRaw = String(process.env.REDIS_TLS || "").trim().toLowerCase();

function parseBooleanEnv(value) {
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

const redisTlsEnabled = parseBooleanEnv(redisTlsRaw);

const redisOptions = {
  host: process.env.REDIS_HOST,
  port: Number.isFinite(redisPort) ? redisPort : 6379,
  password: process.env.REDIS_PASSWORD,
  username: process.env.REDIS_USERNAME || "default",
  lazyConnect: false,
  maxRetriesPerRequest: null,
  enableAutoPipelining: true,
};

if (redisTlsEnabled === true) {
  redisOptions.tls = {};
}

const redis = new Redis(redisOptions);

redis.on("connect", () => {
  console.log(`✅ Redis connected (${redisOptions.tls ? "tls" : "tcp"})`);
});

redis.on("error", (error) => {
  console.error("❌ Redis error:", error);
});

module.exports = redis;
