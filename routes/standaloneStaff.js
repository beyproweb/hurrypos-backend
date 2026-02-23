const express = require("express");
const router = express.Router();
const staffRoutes = require("./staff");
const { requireModule } = require("../middleware/moduleGuard");

// Wrap staff routes under standalone namespace, gated by staff module
router.use("/", requireModule("staff"), staffRoutes);

module.exports = router;
