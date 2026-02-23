const express = require("express");
const router = express.Router();
const { requireModule } = require("../middleware/moduleGuard");
const settingsRouter = require("./settings");

const allowedPaths = new Set([
  "/qr-link",
  "/qr-token",
  "/qr-menu-disabled",
  "/qr-menu-customization",
  "/qr-menu-delivery",
]);

router.use(requireModule("qr_kitchen"));
router.use((req, res, next) => {
  if (allowedPaths.has(req.path)) return next();
  return res.status(404).json({ error: "NOT_FOUND" });
});

router.use(settingsRouter);

module.exports = router;
