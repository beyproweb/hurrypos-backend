const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      (u.protocol === "http:" || u.protocol === "https:")
    );
  } catch {
    return false;
  }
}

let bypassWarned = false;

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function getInternalJwtSecret() {
  const secret = process.env.INTERNAL_JWT_SECRET;
  if (!secret) {
    return null;
  }
  return secret;
}

function issueDevJwt({ email }) {
  const secret = getInternalJwtSecret();
  if (!secret) {
    throw new Error("Server misconfigured: INTERNAL_JWT_SECRET is missing");
  }

  return jwt.sign(
    {
      type: "internal",
      role: "dev",
      email: email || null
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: "12h",
      issuer: "beypro-api",
      audience: "beypro-dev-panel",
      subject: email || "dev"
    }
  );
}

function requireInternalDevJwt(req, res, next) {
  const bypassEnabled = String(process.env.INTERNAL_DEV_BYPASS_LOCALHOST || "").toLowerCase() === "true";
  const origin = req.headers.origin;

  if (!isProduction() && bypassEnabled && isLocalhostOrigin(origin)) {
    if (!bypassWarned) {
      bypassWarned = true;
      console.warn(
        "⚠️ INTERNAL DEV AUTH BYPASS ENABLED for localhost origins (NODE_ENV != production). Do not enable this in production."
      );
    }
    req.devUser = { role: "dev", bypass: true };
    return next();
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ status: "error", message: "Unauthorized: dev token missing" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  const secret = getInternalJwtSecret();
  if (!secret) {
    return res.status(500).json({
      status: "error",
      message: "Server misconfigured: INTERNAL_JWT_SECRET is missing"
    });
  }

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "beypro-api",
      audience: "beypro-dev-panel"
    });

    if (!decoded || decoded.type !== "internal" || decoded.role !== "dev") {
      return res.status(401).json({ status: "error", message: "Unauthorized: invalid dev token" });
    }

    req.devUser = {
      role: "dev",
      email: decoded.email || null,
      sub: decoded.sub || null
    };
    return next();
  } catch (err) {
    return res.status(401).json({ status: "error", message: "Unauthorized: invalid or expired dev token" });
  }
}

async function internalDevLogin(req, res) {
  const { email, password, secret } = req.body || {};

  const loginSecret = process.env.INTERNAL_DEV_AUTH_SECRET || null;
  const jwtSecret = getInternalJwtSecret();

  if (!jwtSecret) {
    return res.status(500).json({
      status: "error",
      message: "Server misconfigured: INTERNAL_JWT_SECRET is missing"
    });
  }

  const allowedEmailsRaw = process.env.INTERNAL_DEV_EMAILS || process.env.INTERNAL_DEV_EMAIL || "";
  const allowedEmails = allowedEmailsRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const passwordHash = process.env.INTERNAL_DEV_PASSWORD_HASH || null;
  const plainPassword = process.env.INTERNAL_DEV_PASSWORD || null;

  let ok = false;
  let subjectEmail = typeof email === "string" ? email.trim().toLowerCase() : null;

  if (secret && loginSecret) {
    ok = constantTimeEqual(secret, loginSecret);
    subjectEmail = subjectEmail || "dev@localhost";
  } else if (typeof email === "string" && typeof password === "string") {
    if (allowedEmails.length > 0 && (!subjectEmail || !allowedEmails.includes(subjectEmail))) {
      ok = false;
    } else if (passwordHash) {
      const bcrypt = require("bcryptjs");
      ok = await bcrypt.compare(password, passwordHash);
    } else if (!isProduction() && plainPassword) {
      ok = constantTimeEqual(password, plainPassword);
    } else {
      ok = false;
    }
  }

  if (!ok) {
    return res.status(401).json({ status: "error", message: "Invalid dev credentials" });
  }

  const token = issueDevJwt({ email: subjectEmail });
  return res.json({ token, role: "dev" });
}

module.exports = {
  internalDevLogin,
  requireInternalDevJwt
};

