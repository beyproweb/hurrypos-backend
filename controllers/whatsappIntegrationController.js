const {
  getRestaurantWhatsAppConfig,
  saveRestaurantWhatsAppConfig,
  disconnectRestaurantWhatsApp,
  sendWhatsAppTemplateMessage,
} = require("../services/whatsappService");

function parseRestaurantIdParam(req) {
  return Number.parseInt(String(req.params.restaurantId || ""), 10);
}

function isRestaurantScopedAccessAllowed(req, restaurantId) {
  const userRestaurantId = Number.parseInt(String(req.user?.restaurant_id || ""), 10);
  return Number.isFinite(userRestaurantId) && userRestaurantId === restaurantId;
}

function sendServiceError(res, err) {
  const statusCode = Number(err?.statusCode || 500);
  const code = String(err?.code || "WHATSAPP_INTEGRATION_ERROR");
  const message =
    statusCode >= 500 ? "WhatsApp integration request failed" : String(err?.message || "Request failed");
  const payload = {
    error: code,
    message,
  };
  if (statusCode < 500 && err?.details !== undefined) {
    payload.details = err.details;
  }
  return res.status(statusCode).json(payload);
}

async function getWhatsAppStatus(req, res) {
  try {
    const restaurantId = parseRestaurantIdParam(req);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "INVALID_RESTAURANT_ID", message: "Invalid restaurant ID" });
    }

    if (!isRestaurantScopedAccessAllowed(req, restaurantId)) {
      return res.status(403).json({ error: "ACCESS_DENIED", message: "Access denied to this restaurant" });
    }

    const status = await getRestaurantWhatsAppConfig(restaurantId);
    return res.json(status);
  } catch (err) {
    console.error("❌ Failed to get WhatsApp integration status:", err?.message || err);
    return sendServiceError(res, err);
  }
}

async function connectWhatsApp(req, res) {
  try {
    const restaurantId = parseRestaurantIdParam(req);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "INVALID_RESTAURANT_ID", message: "Invalid restaurant ID" });
    }

    if (!isRestaurantScopedAccessAllowed(req, restaurantId)) {
      return res.status(403).json({ error: "ACCESS_DENIED", message: "Access denied to this restaurant" });
    }

    const saved = await saveRestaurantWhatsAppConfig(restaurantId, req.body || {});
    return res.json(saved);
  } catch (err) {
    console.error("❌ Failed to connect WhatsApp integration:", err?.message || err);
    return sendServiceError(res, err);
  }
}

async function disconnectWhatsApp(req, res) {
  try {
    const restaurantId = parseRestaurantIdParam(req);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "INVALID_RESTAURANT_ID", message: "Invalid restaurant ID" });
    }

    if (!isRestaurantScopedAccessAllowed(req, restaurantId)) {
      return res.status(403).json({ error: "ACCESS_DENIED", message: "Access denied to this restaurant" });
    }

    const disconnected = await disconnectRestaurantWhatsApp(restaurantId);
    return res.json(disconnected);
  } catch (err) {
    console.error("❌ Failed to disconnect WhatsApp integration:", err?.message || err);
    return sendServiceError(res, err);
  }
}

async function sendTestMessage(req, res) {
  try {
    const restaurantId = parseRestaurantIdParam(req);
    if (!Number.isFinite(restaurantId) || restaurantId <= 0) {
      return res.status(400).json({ error: "INVALID_RESTAURANT_ID", message: "Invalid restaurant ID" });
    }

    if (!isRestaurantScopedAccessAllowed(req, restaurantId)) {
      return res.status(403).json({ error: "ACCESS_DENIED", message: "Access denied to this restaurant" });
    }

    const result = await sendWhatsAppTemplateMessage({
      restaurantId,
      to: req.body?.to,
      templateName: req.body?.templateName,
      templateLanguage: req.body?.templateLanguage,
      components: req.body?.components,
    });

    return res.json(result);
  } catch (err) {
    console.error("❌ Failed to send WhatsApp test message:", err?.message || err);
    return sendServiceError(res, err);
  }
}

module.exports = {
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  sendTestMessage,
};
