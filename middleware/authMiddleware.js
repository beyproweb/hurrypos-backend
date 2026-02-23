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

    const primarySecret = process.env.JWT_SECRET;
    const legacySecret =
      process.env.NODE_ENV !== "production" ? process.env.JWT_SECRET_LEGACY : "";

    if (!primarySecret) {
      console.warn("⚠️ Using fallback JWT_SECRET — .env may not have loaded!");
    }

    const verifyWith = (secret) => jwt.verify(token, secret);

    let decoded;
    try {
      decoded = verifyWith(primarySecret || "beypro_secret_2025");
    } catch (err) {
      // Allow a legacy secret in non-production to avoid breaking existing sessions after a local secret change.
      if (legacySecret && legacySecret !== primarySecret) {
        decoded = verifyWith(legacySecret);
      } else {
        throw err;
      }
    }

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
      allowed_modules: Array.isArray(decoded.allowed_modules)
        ? decoded.allowed_modules.map((m) => String(m))
        : undefined,
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
