// utils/whatsappCloud.js
const axios = require("axios");

const WHATSAPP_ID = process.env.WHATSAPP_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// 🔹 Optional venom-bot support for local/dev usage
let venom = null;
if (process.env.RENDER !== "true") {
  try {
    venom = require("venom-bot");
    console.log("✅ venom-bot loaded (local mode)");
  } catch (err) {
    console.warn("⚠️ venom-bot not installed or failed to load:", err.message);
  }
}

/**
 * Send a WhatsApp Cloud API message (works on Render or locally)
 */
async function sendCloudMessage(to, body) {
  try {
    if (!WHATSAPP_ID || !WHATSAPP_TOKEN)
      throw new Error("Missing WhatsApp Cloud API credentials");

    const url = `https://graph.facebook.com/v24.0/${WHATSAPP_ID}/messages`;
    const phone = to.toString().replace(/\D/g, "");

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body },
    };

    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`📤 Sent WhatsApp Cloud message to ${phone}:`, data);
    return data;
  } catch (err) {
    console.error("❌ sendCloudMessage error:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Optional local-only venom-bot send function
 */
async function sendLocalVenomMessage(client, to, body) {
  if (!venom) {
    console.warn("⚠️ venom-bot not available on this environment");
    return null;
  }
  try {
    const phone = to.toString().replace(/\D/g, "");
    await client.sendText(`${phone}@c.us`, body);
    console.log(`📤 Sent WhatsApp (venom) message to ${phone}`);
  } catch (err) {
    console.error("❌ sendLocalVenomMessage error:", err.message);
  }
}

module.exports = {
  sendCloudMessage,
  sendLocalVenomMessage,
  venom,
};
