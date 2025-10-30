const jwt = require("jsonwebtoken");

/**
 * ✅ Authentication & Tenant Middleware
 * Verifies JWT and attaches req.user = { id, name, role, restaurant_id, ... }
 */
module.exports = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.warn("⚠️ Missing or malformed Authorization header");
      return res.status(401).json({
        status: "error",
        message: "Unauthorized: token missing",
      });
    }

    const token = authHeader.split(" ")[1];

    // ✅ Ensure .env secret loaded correctly
    const secret = process.env.JWT_SECRET || "beypro_secret_2025";
    if (!process.env.JWT_SECRET) {
      console.warn("⚠️ Using fallback JWT_SECRET — .env may not have loaded!");
    }

    // 🔍 Verify token
    const decoded = jwt.verify(token, secret);

    if (!decoded || !decoded.restaurant_id) {
      console.warn("⚠️ Token missing restaurant_id");
      return res.status(401).json({
        status: "error",
        message: "Unauthorized: tenant not found in token",
      });
    }

    req.user = {
      id: decoded.id,
      name: decoded.name,
      role: decoded.role,
      restaurant_id: decoded.restaurant_id,
    };

    next();
  } catch (err) {
    console.error("❌ Auth middleware error:", err.message);
    return res.status(401).json({
      status: "error",
      message: "Invalid or expired token",
    });
  }
};
