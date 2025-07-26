// Import necessary packages
require('dotenv').config();

const axios = require("axios");

const apiSecret = process.env.TRENDYOL_API_SECRET;
const apiKey = process.env.TRENDYOL_API_KEY;
const sellerId = process.env.TRENDYOL_SELLER_ID;
const token = process.env.TRENDYOL_TOKEN;

// Use the correct base URL for Trendyol Orders
const baseUrl = `https://api.tgoapis.com/integrator/store/meal/suppliers/${sellerId}`;

// Create an Axios instance with default headers
const trendyolAPI = axios.create({
  baseURL: baseUrl,
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`, // Use API Key and Secret
  },
});




// Fetch new orders from Trendyol
async function fetchNewOrders() {
  try {
    const response = await trendyolAPI.get(`/orders`, {
      params: {
        status: "Created",
        size: 50,
        orderByField: "CreatedDate",
        orderByDirection: "DESC"
      }
    });
    console.log("✅ Trendyol orders fetched:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Error fetching Trendyol orders:", {
      status: error.response?.status,
      headers: error.response?.headers,
      data: error.response?.data,
      message: error.message,
    });
    throw new Error("Failed to fetch orders from Trendyol.");
  }
}

// Fetch a specific order from Trendyol by order ID
async function fetchOrderById(orderId) {
  try {
    console.log("🔍 Fetching order by ID from Trendyol...");
    const response = await trendyolAPI.get(`/orders/${orderId}`);
    console.log("✅ Order fetched:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Error fetching order by ID:", {
      status: error.response?.status,
      headers: error.response?.headers,
      data: error.response?.data,
      message: error.message,
    });
    throw new Error("Failed to fetch order from Trendyol.");
  }
}

module.exports = {
  fetchNewOrders,
  fetchOrderById,
};
