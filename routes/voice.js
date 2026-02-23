const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const { parseOrder, confirmLog } = require("../controllers/voiceController");

// Public + QR + POS: parsing endpoint (uses token auth if provided)
router.post("/voice/parse-order", parseOrder);

// Confirm a voice log (requires authenticated POS user)
router.post("/voice/logs/:id/confirm", authMiddleware, confirmLog);

module.exports = router;
