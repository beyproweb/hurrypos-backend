// middleware/externalApiAuth.js
console.log("🟪 externalApiAuth LOADED FROM:", __filename);

const jwt = require("jsonwebtoken");

// Delivery Hero uses HS512 algorithm
const DH_SECRET = process.env.YS_SECRET;

module.exports = function externalApiAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    console.log("🔍 RECEIVED AUTH HEADER:", auth);

    if (!auth || !auth.startsWith("Bearer ")) {
      console.warn("❌ Missing Authorization header");
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const token = auth.split(" ")[1];
    console.log("🔍 TOKEN EXTRACTED:", token);

    if (!DH_SECRET) {
      console.error("❌ YS_MIDDLEWARE_SECRET missing in ENV");
      return res.status(500).json({ error: "INTERNAL_SERVICE_ERROR" });
    }

    const decoded = jwt.verify(token, DH_SECRET, {
      algorithms: ["HS512"]
    });
    console.log("✅ TOKEN VERIFIED:", decoded);

    if (decoded.service !== "middleware") {
      console.warn("❌ Invalid JWT claim: service must be 'middleware'");
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    req.middlewareUser = decoded;
    next();
  } catch (err) {
    console.error("❌ MiddlewareJWTAuth failed:", err);
    console.error("❌ RAW ERROR:", err);
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
};
