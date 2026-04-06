// routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const {
  MARKETPLACE_CUSTOMER_SCOPE,
  ensureMarketplaceCustomerSchema,
  getMarketplaceCustomerById,
  loginMarketplaceCustomer,
  registerMarketplaceCustomer,
  signMarketplaceCustomerToken,
  verifyCustomerAuthToken,
} = require("../utils/marketplaceCustomerAuth");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function shouldUseMarketplaceCustomerScope(payload = {}) {
  const normalizedScope = String(
    payload.scope || payload.auth_scope || payload.audience || payload.authSource || ""
  )
    .trim()
    .toLowerCase();

  return (
    normalizedScope === MARKETPLACE_CUSTOMER_SCOPE ||
    payload.marketplace === true ||
    payload.customer_auth === true
  );
}

function mapMarketplaceAuthError(error, fallbackMessage) {
  const statusCode = Number(error?.statusCode || 0);
  if (statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      error: String(error?.message || fallbackMessage),
    };
  }
  return {
    statusCode: 500,
    error: fallbackMessage,
  };
}

router.post("/login", async (req, res) => {
  if (shouldUseMarketplaceCustomerScope(req.body || {})) {
    try {
      await ensureMarketplaceCustomerSchema();
      const customer = await loginMarketplaceCustomer({
        email: req.body?.email,
        login: req.body?.login || req.body?.phone || req.body?.email,
        password: req.body?.password,
        phone: req.body?.phone,
      });
      const token = signMarketplaceCustomerToken({
        customerId: customer.id,
        email: customer.email,
        phone: customer.phone,
      });

      return res.json({
        success: true,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        token,
        customer,
      });
    } catch (error) {
      const mapped = mapMarketplaceAuthError(error, "Failed to log in");
      return res.status(mapped.statusCode).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: mapped.error,
      });
    }
  }

  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

    if (process.env.NODE_ENV !== "production") {
      console.log("🔑 Login Debug");
      console.log("➡️ Incoming email:", email);
      console.log("➡️ Normalized email:", normalizedEmail);
      console.log("➡️ DB URL exists?", !!process.env.DATABASE_URL);
      console.log("➡️ JWT_SECRET exists?", !!process.env.JWT_SECRET);
    }

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: "Email and password required",
    });
  }

  try {
    let user;
    let source = null;

      if (process.env.NODE_ENV !== "production") {
        console.log("🛠️ Querying users table…");
      }
    const userRes = await pool.query(
      `SELECT id, full_name, email, password_hash, role, restaurant_id
       FROM users
       WHERE LOWER(TRIM(email)) = $1`,
      [normalizedEmail]
    );

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
      source = "users";
        if (process.env.NODE_ENV !== "production") {
          console.log("✅ Found user in users table:", user.email);
        }
    }

    // fallback: staff table
    if (!user) {
        if (process.env.NODE_ENV !== "production") {
          console.log("🛠️ Querying staff table…");
        }
      const staffRes = await pool.query(
        `SELECT id, name, email, pin, restaurant_id, role
         FROM staff WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
        [normalizedEmail]
      );

      if (staffRes.rows.length > 0) {
        user = staffRes.rows[0];
        source = "staff";
          if (process.env.NODE_ENV !== "production") {
            console.log("✅ Found user in staff table:", user.email);
          }
      }
    }

    if (!user) {
        // Keep: Useful for production debugging (no PII, just normalized email)
        console.warn("❌ No user found for email:", normalizedEmail);
      return res.status(401).json({
        success: false,
        error: "User not found or invalid credentials",
      });
    }

    // check password or PIN
    let passwordMatch = false;
    try {
      passwordMatch =
        source === "staff"
          ? user.pin === password // compare PIN directly
          : await bcrypt.compare(password, user.password_hash);
    } catch (e) {
      passwordMatch = false;
    }

    if (!passwordMatch) {
        // Keep: Useful for production debugging (no PII, just email)
        console.warn("❌ Invalid password for:", email);
      return res.status(401).json({
        success: false,
        error: "Invalid password",
      });
    }

    // create JWT token
    const token = jwt.sign(
      {
        id: user.id,
        name: user.name || user.full_name,
        role: user.role || "staff",
        restaurant_id: user.restaurant_id,
        auth_source: source,
      },
      process.env.JWT_SECRET || "beypro_secret_2025",
      { expiresIn: "7d" }
    );

      if (process.env.NODE_ENV !== "production") {
        console.log(`✅ ${source} login success:`, user.email);
      }

    // ✅ Fetch role permissions (prefer new user_settings table, fallback to legacy settings)
    let permissions = [];
    const roleKey = user.role?.toLowerCase();
      if (process.env.NODE_ENV !== "production") {
        console.log("🔍 Looking for role permissions for roleKey:", roleKey);
      }

    let mergedRoles = {};
    let overridePermissions = null;
    let hasModernConfig = false;

    // 1) Try the modern user_settings table first
    try {
      const modernResult = await pool.query(
        `SELECT settings
         FROM user_settings
         WHERE restaurant_id = $1 AND section = 'users'
         LIMIT 1`,
        [user.restaurant_id]
      );

      if (modernResult.rows.length > 0) {
        const modernSettings = modernResult.rows[0].settings || {};
        const modernKeys = Object.keys(modernSettings || {});
          if (process.env.NODE_ENV !== "production") {
            console.log("🆕 user_settings payload keys:", modernKeys);
          }

        if (modernSettings.roles && typeof modernSettings.roles === "object" && Object.keys(modernSettings.roles).length > 0) {
          hasModernConfig = true;
          const normalizedModernRoles = Object.entries(modernSettings.roles).reduce(
            (acc, [key, value]) => {
              if (Array.isArray(value)) {
                acc[key.toLowerCase()] = value.map((perm) => String(perm).toLowerCase());
              }
              return acc;
            },
            {}
          );

          mergedRoles = { ...mergedRoles, ...normalizedModernRoles };
            if (process.env.NODE_ENV !== "production") {
              console.log(
                "🆕 Loaded role definitions from user_settings:",
                Object.keys(normalizedModernRoles)
              );
            }
        }

        // Optional: handle per-user overrides if present
        const overrideContainers = [
          modernSettings.users,
          modernSettings.overrides,
          modernSettings.individual,
          modernSettings.staff,
        ].filter(Boolean)[0];

        if (overrideContainers && typeof overrideContainers === "object") {
          const normalizedOverrides = Object.entries(overrideContainers).reduce(
            (acc, [key, value]) => {
              const lowerKey = String(key).toLowerCase();
              let perms = [];

              if (Array.isArray(value)) {
                perms = value;
              } else if (value && Array.isArray(value.permissions)) {
                perms = value.permissions;
              }

              if (perms.length > 0) {
                acc[lowerKey] = perms.map((perm) => String(perm).toLowerCase());
              }

              return acc;
            },
            {}
          );

          const userIdKey = user.id != null ? String(user.id) : null;
          const emailKey = user.email ? user.email.toLowerCase() : null;

          const overrideSource =
            (userIdKey && normalizedOverrides[userIdKey]) ||
            (emailKey && normalizedOverrides[emailKey]) ||
            null;

          if (overrideSource && Array.isArray(overrideSource) && overrideSource.length > 0) {
            overridePermissions = overrideSource;
              if (process.env.NODE_ENV !== "production") {
                console.log(
                  "✅ Applying individual permission override from user_settings:",
                  overridePermissions
                );
              }
          }
        }
      }
    } catch (err) {
        // Keep: Useful for production debugging
        console.error("⚠️ Error loading permissions from user_settings:", err);
    }

    // 2) Only use legacy settings if NO modern config exists
    if (!hasModernConfig) {
      try {
        const legacyResult = await pool.query(
          `SELECT key, value, users
           FROM settings
           WHERE restaurant_id = $1
             AND key IN ('users', 'global')`,
          [user.restaurant_id]
        );

          if (process.env.NODE_ENV !== "production") {
            console.log("📊 Legacy settings rows:", legacyResult.rows.length, "rows");
          }
        legacyResult.rows.forEach((row) => {
            if (process.env.NODE_ENV !== "production") {
              console.log(`  - legacy key: ${row.key}, has value: ${!!row.value}, has users: ${!!row.users}`);
            }
        });

        let valueConfig = {};
        let usersConfig = {};

        for (const row of legacyResult.rows) {
          if (row.key === "users" && row.value) valueConfig = row.value;
          if (row.key === "global" && row.users) usersConfig = row.users;
        }

        const legacyMerged = {
          roles: {
            ...(usersConfig.roles || {}),
            ...(valueConfig.roles || {}),
          },
        };

        const normalizedLegacyRoles = Object.entries(legacyMerged.roles || {}).reduce(
          (acc, [key, value]) => {
            if (Array.isArray(value)) {
              acc[key.toLowerCase()] = value.map((perm) => String(perm).toLowerCase());
            }
            return acc;
          },
          {}
        );

        mergedRoles = { ...normalizedLegacyRoles, ...mergedRoles };
          if (process.env.NODE_ENV !== "production") {
            console.log("🔎 Using legacy settings (no modern config found):", Object.keys(mergedRoles));
          }
      } catch (err) {
          // Keep: Useful for production debugging
          console.error("⚠️ Error loading permissions from legacy settings:", err);
      }
    } else {
        if (process.env.NODE_ENV !== "production") {
          console.log("✅ Modern config exists - skipping legacy settings. Roles:", Object.keys(mergedRoles));
        }
    }

    const availableRoles = Object.keys(mergedRoles || {});
    let resolvedPermissions = [];

    if (overridePermissions && overridePermissions.length > 0) {
      resolvedPermissions = overridePermissions;
        if (process.env.NODE_ENV !== "production") {
          console.log("✅ Using individual override permissions:", resolvedPermissions);
        }
    } else if (roleKey && mergedRoles?.[roleKey]) {
      resolvedPermissions = mergedRoles[roleKey];
        if (process.env.NODE_ENV !== "production") {
          console.log(`✅ Found role permissions for '${roleKey}':`, resolvedPermissions);
        }
    } else if (mergedRoles?.boss) {
      resolvedPermissions = mergedRoles.boss;
        if (process.env.NODE_ENV !== "production") {
          console.log(`✅ Role '${roleKey}' not found, using boss role:`, resolvedPermissions);
        }
    } else if (roleKey === "boss" && mergedRoles?.admin) {
      resolvedPermissions = mergedRoles.admin;
        if (process.env.NODE_ENV !== "production") {
          console.log("✅ Boss role maps to admin:", resolvedPermissions);
        }
    } else {
        // Keep: Useful for production debugging
        console.warn(
          `⚠️ No permissions found for role '${roleKey}', available roles:`,
          availableRoles
        );
    }

    permissions = Array.from(new Set((resolvedPermissions || []).map((perm) => {
      // Normalize: convert hyphens to dots for consistency with mobile app
      // e.g., "staff-checkin" -> "staff.checkin"
      return String(perm).toLowerCase().replace(/-/g, ".");
    })));
      if (process.env.NODE_ENV !== "production") {
        console.log(`✅ Final permissions for ${roleKey}:`, permissions);
      }

    // ✅ Respond with token and normalized user data
    res.json({
      success: true,
      message: "Login successful",
      source,
      user: {
        id: user.id,
        name: user.name || user.full_name,
        email: user.email,
        role: user.role,
        restaurant_id: user.restaurant_id,
        auth_source: source,
        permissions,
      },
      token,
    });
  } catch (err) {
      // Keep: Useful for production debugging
      console.error("❌ Login error:", err.message, err.stack);
    res.status(500).json({
      success: false,
      error: "Internal server error during login",
    });
  }
});

router.post("/register", async (req, res) => {
  try {
    await ensureMarketplaceCustomerSchema();

    const customer = await registerMarketplaceCustomer({
      address: req.body?.address,
      email: req.body?.email,
      language: req.body?.language,
      name: req.body?.name || req.body?.full_name || req.body?.username,
      password: req.body?.password,
      phone: req.body?.phone,
    });

    const token = signMarketplaceCustomerToken({
      customerId: customer.id,
      email: customer.email,
      phone: customer.phone,
    });

    return res.status(201).json({
      success: true,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      token,
      customer,
    });
  } catch (error) {
    const mapped = mapMarketplaceAuthError(error, "Failed to register customer account");
    return res.status(mapped.statusCode).json({
      success: false,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      error: mapped.error,
    });
  }
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || "");
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: "Customer session required",
      });
    }

    await ensureMarketplaceCustomerSchema();

    const token = authHeader.slice(7).trim();
    const decoded = verifyCustomerAuthToken(token);
    if (
      !decoded?.customer_id ||
      String(decoded.scope || "").toLowerCase() !== MARKETPLACE_CUSTOMER_SCOPE
    ) {
      return res.status(401).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: "Invalid customer session",
      });
    }

    const customer = await getMarketplaceCustomerById(decoded.customer_id);
    if (!customer?.id) {
      return res.status(404).json({
        success: false,
        scope: MARKETPLACE_CUSTOMER_SCOPE,
        error: "Customer account not found",
      });
    }

    return res.json({
      success: true,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      customer,
    });
  } catch (error) {
    const mapped = mapMarketplaceAuthError(error, "Failed to resolve customer session");
    return res.status(mapped.statusCode).json({
      success: false,
      scope: MARKETPLACE_CUSTOMER_SCOPE,
      error: mapped.error,
    });
  }
});

module.exports = router;
