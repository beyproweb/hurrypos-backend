const express = require("express");
const authMiddleware = require("../middleware/authMiddleware");
const { attachAllowedModules } = require("../middleware/moduleGuard");
const {
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  sendTestMessage,
} = require("../controllers/whatsappIntegrationController");

const router = express.Router();

router.use(authMiddleware);
router.use(async (req, res, next) => {
  const allowedModules = await attachAllowedModules(req);
  if (Array.isArray(allowedModules) && !allowedModules.includes("pos_core")) {
    return res.status(403).json({ error: "MODULE_NOT_ALLOWED" });
  }
  return next();
});

router.get("/status/:restaurantId", getWhatsAppStatus);
router.post("/connect/:restaurantId", connectWhatsApp);
router.post("/disconnect/:restaurantId", disconnectWhatsApp);
router.post("/test-message/:restaurantId", sendTestMessage);

module.exports = router;
