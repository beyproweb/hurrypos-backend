
const express = require('express');
require('dotenv').config();

const pool = require('./db');
const cors = require('cors');
app.use(cors({
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  allowedHeaders: "Origin,X-Requested-With,Content-Type,Accept,Authorization",
}));
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const Tesseract = require("tesseract.js");
const path = require("path");
const fs = require("fs");
const app = express();
const http = require('http').createServer(app);
const { initSocket } = require("./utils/socket");
const io = initSocket(http);
app.set("io", io);
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; // Store your key securely!
const { sendEmail } = require("./utils/notifications"); // make sure this import exists
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));



const taskRoutes = require("./routes/tasks");
app.use(express.json());

app.use("/api", taskRoutes);


const dayjs = require("dayjs");



const { fetchNewOrders, fetchOrderById } = require('./trendyol');
const recentAlerts = new Map(); // key: stock.id or item.name, value: timestamp

const {
  emitOrderUpdate,
  emitStockUpdate,
  emitOrderConfirmed,
  emitOrderDelivered,
   emitAlert,// ✅ add this
} = require('./utils/realtime');

const staffRoutes = require('./routes/staff');
const bcrypt = require("bcrypt");


const uploadRouter = require("./routes/upload.js"); // ✅ correct path
app.use("/api/upload", uploadRouter);

const { startKitchenTimersJob } = require("./routes/timerScheduler");
startKitchenTimersJob();

app.use('/api/stock', require('./routes/stock')(io));

// Mount the staff route with the correct base path
app.use('/api/staff', staffRoutes);

const reportsRoutes = require("./routes/reports");
app.use("/api/reports", reportsRoutes);

const productionRoutes = require('./routes/production');
app.use('/api/production', productionRoutes);

const notificationsRoutes = require("./routes/notifications");
app.use("/api/notifications", notificationsRoutes);

const expensesRoutes = require('./routes/expenses');
app.use('/api', expensesRoutes);

const userSettingsRoutes = require("./routes/userSettings");
app.use("/api/user-settings", userSettingsRoutes);


const printerRoutes = require('./routes/printer');
app.use('/api/printer-settings', printerRoutes);


const subscriptionRoutes = require('./routes/subscription');
app.use('/api', subscriptionRoutes);

app.use('/api/drinks', require('./routes/drinks'));

const yemeksepetiRoutes = require('./routes/yemeksepeti');
app.use('/api/integrations/yemeksepeti', yemeksepetiRoutes);

const categoryImagesRoutes = require("./routes/categoryImages");
app.use("/api/category-images", categoryImagesRoutes);

// ✅ Log requests
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} request to ${req.url}`);
  next();
});


const settingsRoutes = require("./routes/settings");
app.use("/api/settings", settingsRoutes);


const productRoutes = require('./routes/products');
app.use('/api/products', productRoutes);

const extrasGroupRoutes = require("./routes/extras-groups");
app.use("/api/extras-groups", extrasGroupRoutes);


const autoSuppliersRouter = require("./routes/Autosuppliersorder"); // update path if needed
app.use("/api", autoSuppliersRouter(io));


// server.js



const kitchen = require("./routes/kitchen"); // update path if needed
app.use("/api", kitchen);
// Safe parsing function for extras

const phoneordersRoutes = require('./routes/phoneorders');
app.use('/api', phoneordersRoutes);

const customerAddressesRoutes = require("./routes/customerAddresses");
app.use("/api", customerAddressesRoutes);

const customerRoutes = require("./routes/customers");
app.use("/api/customers", customerRoutes);

const campaignsRoutes = require('./routes/campaigns');
app.use('/api/campaigns', campaignsRoutes);


// Routes initialization with `io`
const ordersRouter = require("./routes/orders")(io); // <-- CRITICAL LINE
app.use("/api/orders", ordersRouter);

app.use('/api/drivers', require('./routes/drivers')(io));
app.use('/api/suppliers', require('./routes/suppliers')(io));
app.use('/api/ingredient-prices', require('./routes/ingredient-prices')(io));



const safeParseExtras = (extras) => {
  try {
    if (Array.isArray(extras)) return extras;
    if (typeof extras === "string") return JSON.parse(extras);
    return [];
  } catch (err) {
    console.error("❌ Error parsing extras:", err);
    return [];
  }
};



// Error catcher middleware
app.use((err, req, res, next) => {
  console.error("🔥 Express error handler:", err);
  res.status(500).json({ error: "Internal server error" });
});


const PORT = process.env.PORT || 5000;
http.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend is running on port ${PORT} and accessible from LAN`);
});




module.exports = { app, pool };
