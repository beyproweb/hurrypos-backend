// utils/whatsappCloud.js
const axios = require("axios");

const WHATSAPP_ID = process.env.WHATSAPP_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

async function sendCloudMessage(to, body) {
  try {
    if (!WHATSAPP_ID || !WHATSAPP_TOKEN)
      throw new Error("Missing WhatsApp Cloud API credentials");

    const url = `https://graph.facebook.com/v24.0/${WHATSAPP_ID}/messages`;

    // normalize number (remove symbols)
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

    console.log(`📤 Sent WhatsApp message to ${phone}:`, data);
    return data;
  } catch (err) {
    console.error("❌ sendCloudMessage error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendCloudMessage };
