const express = require("express");
const router = express.Router();
const { requireModule } = require("../middleware/moduleGuard");
const kitchenRouter = require("./kitchen");

router.use(requireModule("qr_kitchen"));
router.use(kitchenRouter);

module.exports = router;
