const redis = require("../utils/redis");

(async () => {
  try {
    await redis.set("health_check", "beypro_ok");
    const value = await redis.get("health_check");
    console.log(value);
    await redis.quit();
  } catch (error) {
    console.error("❌ Redis health check failed:", error);
    process.exitCode = 1;

    try {
      await redis.quit();
    } catch (_error) {
      // Ignore shutdown errors in the standalone health check.
    }
  }
})();
