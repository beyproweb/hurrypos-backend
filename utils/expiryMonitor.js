const { pool } = require("../db");
const { emitAlert } = require("./realtime");

const EXPIRY_ALERT_WINDOW_DAYS = 7;
const NOTIFICATION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeExpiryDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split("T")[0];
};

const shouldSkipCooldown = async (restaurantId, stockId) => {
  if (!restaurantId || !stockId) return false;
  const result = await pool.query(
    `
    SELECT time
    FROM notifications
    WHERE restaurant_id = $1
      AND stock_id = $2
      AND type = 'stock_expiry'
    ORDER BY time DESC
    LIMIT 1
    `,
    [restaurantId, stockId]
  );

  if (!result.rows.length) return false;
  const lastSent = new Date(result.rows[0].time).getTime();
  return Date.now() - lastSent < NOTIFICATION_COOLDOWN_MS;
};

const maybeEmitExpiryAlert = async (io, restaurantId, stockId, stockName, expiryDate) => {
  if (!io || !restaurantId || !stockId || !expiryDate) return;
  const safeName = (stockName || "Inventory").trim() || "Inventory";
  try {
    const expiryTime = new Date(expiryDate);
    if (Number.isNaN(expiryTime.getTime())) return;

    if (expiryTime.getTime() - Date.now() > EXPIRY_ALERT_WINDOW_DAYS * MS_PER_DAY) {
      return;
    }

    if (await shouldSkipCooldown(restaurantId, stockId)) {
      return;
    }

    const daysToExpiry = Math.max(
      0,
      Math.ceil((expiryTime.getTime() - Date.now()) / MS_PER_DAY)
    );
    const formattedDate = expiryTime.toLocaleDateString();
    const message =
      daysToExpiry <= 0
        ? `${safeName} expired on ${formattedDate}`
        : `${safeName} expires in ${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}`;

    await emitAlert(
      io,
      restaurantId,
      message,
      stockId,
      "stock_expiry",
      {
        expiryDate: expiryTime.toISOString(),
        daysToExpiry,
      }
    );
  } catch (err) {
    console.error("❌ Expiry alert failed:", err);
  }
};

module.exports = {
  normalizeExpiryDate,
  maybeEmitExpiryAlert,
};
