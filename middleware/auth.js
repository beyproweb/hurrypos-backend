const jwt = require("jsonwebtoken");

/**
 * ✅ Authentication & Tenant Middleware
 * Verifies JWT and attaches req.user = { id, name, role, restaurant_id, ... }
 */
module.exports = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // No token provided
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized: token missing",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Token valid but missing tenant info
    if (!decoded || !decoded.restaurant_id) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized: tenant not found in token",
      });
    }

    // Attach tenant user
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
