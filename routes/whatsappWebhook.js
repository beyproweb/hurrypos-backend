const express = require("express");
const router = express.Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "beypro_verify_token"; // choose any custom string

// ✅ Step 1: Verification endpoint (Meta checks this once)
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ Verification failed.");
    res.sendStatus(403);
  }
});

// ✅ Step 2: Handle incoming messages + statuses
router.post("/", (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      body.entry?.forEach((entry) => {
        const changes = entry.changes || [];
        changes.forEach((change) => {
          const value = change.value;

          // 🔹 When someone sends a message
          if (value.messages) {
            value.messages.forEach((msg) => {
              const from = msg.from;
              const text = msg.text?.body || "(non-text)";
              console.log(`💬 Incoming message from ${from}: ${text}`);
              // TODO: handle/save/reply in DB if needed
            });
          }

          // 🔹 When message status changes (sent, delivered, read)
          if (value.statuses) {
            value.statuses.forEach((status) => {
              console.log(
                `📦 Message ${status.id} status: ${status.status} at ${status.timestamp}`
              );
            });
          }
        });
      });
      res.sendStatus(200);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error("Webhook Error:", err);
    res.sendStatus(500);
  }
});

module.exports = router;
