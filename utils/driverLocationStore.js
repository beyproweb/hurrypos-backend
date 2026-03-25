const DRIVER_LOCATION_TTL_SECONDS = 600;

const memoryLocations = new Map();

let redisClient;
let redisInitialized = false;

function getRedisClient() {
  if (redisInitialized) return redisClient;
  redisInitialized = true;

  if (!process.env.REDIS_HOST || !process.env.REDIS_PORT) {
    console.log("⚠️ Redis not configured — using in-memory driver location store");
    redisClient = null;
    return redisClient;
  }

  try {
    redisClient = require("./redis");
    if (redisClient) {
      console.log("✅ Redis enabled for driver locations");
    } else {
      console.log("⚠️ Redis unavailable — using in-memory driver location store");
    }
  } catch (err) {
    console.warn("⚠️ Redis initialization failed, using memory:", err?.message || err);
    redisClient = null;
  }

  return redisClient;
}

function buildDriverLocationKey(restaurantId, driverId) {
  return `driver:${restaurantId}:${driverId}`;
}

async function setDriverLocation({ restaurantId, driverId, lat, lng, extra = {} }) {
  const payload = {
    lat,
    lng,
    timestamp: Date.now(),
    ...extra,
  };
  const key = buildDriverLocationKey(restaurantId, driverId);
  const encoded = JSON.stringify(payload);
  const redis = getRedisClient();

  if (redis) {
    await redis.set(key, encoded, "EX", DRIVER_LOCATION_TTL_SECONDS);
  } else {
    memoryLocations.set(key, encoded);
  }

  return payload;
}

async function getDriverLocation({ restaurantId, driverId }) {
  const key = buildDriverLocationKey(restaurantId, driverId);
  const redis = getRedisClient();

  let raw = null;
  if (redis) raw = await redis.get(key);
  else raw = memoryLocations.get(key) || null;

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getKnownDriverIds(restaurantId) {
  const prefix = `driver:${restaurantId}:`;
  return Array.from(memoryLocations.keys())
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.split(":")[2])
    .filter(Boolean)
    .slice(0, 20);
}

module.exports = {
  buildDriverLocationKey,
  getDriverLocation,
  getKnownDriverIds,
  setDriverLocation,
};
