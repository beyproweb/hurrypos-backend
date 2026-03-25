const redis = require("./redis");

async function getOrSetCache(key, ttl, fetchFunction) {
  const cachedValue = await redis.get(key);

  if (cachedValue !== null) {
    try {
      return JSON.parse(cachedValue);
    } catch (error) {
      await redis.del(key);
    }
  }

  const freshValue = await fetchFunction();

  if (freshValue === undefined) {
    return freshValue;
  }

  await redis.set(key, JSON.stringify(freshValue), "EX", Number(ttl));
  return freshValue;
}

function buildTablesCacheKey(restaurantId) {
  return `tables:${restaurantId}`;
}

async function invalidateTablesCache(restaurantId) {
  if (!restaurantId) return;

  try {
    await redis.del(buildTablesCacheKey(restaurantId));
  } catch (error) {
    console.error("❌ Failed to invalidate tables cache:", error);
  }
}

module.exports = {
  buildTablesCacheKey,
  getOrSetCache,
  invalidateTablesCache,
};
