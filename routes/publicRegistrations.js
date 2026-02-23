const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { promisify } = require("util");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db");
const { sendEmail } = require("../utils/notifications");
const { encryptJson, encryptBuffer } = require("../utils/piiCrypto");
const { ensureApplicationTables } = require("../utils/applicationsTables");

const router = express.Router();

// ---------- Security helpers ----------
function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function requireHttps(req, res, next) {
  if (!isProduction()) return next();

  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const proto = xfProto || (req.secure ? "https" : "http");
  if (proto !== "https") {
    return res.status(400).json({ success: false, error: "HTTPS is required" });
  }
  return next();
}

router.use(requireHttps);

// ---------- Validation helpers ----------
function normalizeIban(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

function isValidTurkishId(value) {
  const v = String(value || "").trim();
  return /^\d{11}$/.test(v);
}

function isValidIban(value) {
  const v = normalizeIban(value);
  return /^TR\d{24}$/.test(v);
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  const v = String(value || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function requireField(body, key) {
  const val = body?.[key];
  if (val === undefined || val === null || String(val).trim() === "") {
    return { ok: false, error: `${key} is required` };
  }
  return { ok: true, value: val };
}

// ---------- Virus scan (ClamAV) ----------
const execFileAsync = promisify(execFile);

function virusScanMode() {
  const raw = String(process.env.VIRUS_SCAN_MODE || "").trim().toLowerCase();
  if (raw === "off" || raw === "disabled") return "off";
  if (raw === "optional") return "optional";
  if (raw === "required") return "required";
  return isProduction() ? "required" : "optional";
}

async function scanBufferOrThrow(buffer) {
  const mode = virusScanMode();
  if (mode === "off") return;

  const clamscanPath = process.env.CLAMSCAN_PATH || "clamscan";

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "beypro-scan-"));
  const filePath = path.join(dir, "upload.bin");
  try {
    await fs.promises.writeFile(filePath, buffer);
    try {
      await execFileAsync(clamscanPath, ["--no-summary", filePath], { timeout: 60_000 });
      return;
    } catch (err) {
      if (err && typeof err === "object" && err.code === "ENOENT") {
        if (mode === "required") {
          throw new Error("Virus scanner is not available (clamscan not found)");
        }
        console.warn("⚠️ Virus scan skipped: clamscan not found (VIRUS_SCAN_MODE=optional)");
        return;
      }

      // clamscan exit code 1 means infected; >1 means error.
      const exitCode = typeof err?.code === "number" ? err.code : null;
      if (exitCode === 1) {
        throw new Error("Upload rejected: virus detected");
      }
      throw new Error("Virus scan failed");
    }
  } finally {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------- Upload storage (encrypted, private) ----------
function getPrivateUploadsDir() {
  const dir = path.join(__dirname, "..", "private_uploads", "applications");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function writeEncryptedUpload({ applicationId, field, file }) {
  const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
  const mime = String(file.mimetype || "").toLowerCase();
  if (!allowed.has(mime)) {
    throw new Error("Only PDF/JPG/PNG uploads are allowed");
  }

  await scanBufferOrThrow(file.buffer);

  const { ciphertext, ivB64, tagB64 } = encryptBuffer(file.buffer);
  const dir = getPrivateUploadsDir();
  const storagePath = path.join(dir, `app_${applicationId}_${field}_${Date.now()}.enc`);
  await fs.promises.writeFile(storagePath, ciphertext);

  return {
    storage_path: storagePath,
    original_name: String(file.originalname || `${field}`),
    mime,
    size: Number(file.size || 0),
    enc_iv: ivB64,
    enc_tag: tagB64,
  };
}

// Multer memory storage so we can virus-scan + encrypt before writing.
function uploadMaxMb() {
  const raw = Number(process.env.APPLICATION_UPLOAD_MAX_MB);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 15;
}

const UPLOAD_MAX_MB = uploadMaxMb();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_MB * 1024 * 1024 },
});

function applicationsNotifyEmails() {
  const raw = process.env.APPLICATIONS_NOTIFY_EMAILS || process.env.APPLICATIONS_NOTIFY_EMAIL || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendNewApplicationEmails({ type, applicantEmail, applicantName, applicationId }) {
  const notify = applicationsNotifyEmails();
  const subject = `New ${type} application: ${applicationId}`;
  const text = [
    `New ${type} application received.`,
    `ID: ${applicationId}`,
    applicantName ? `Name: ${applicantName}` : null,
    applicantEmail ? `Email: ${applicantEmail}` : null,
    "",
    "Status: PENDING",
  ]
    .filter(Boolean)
    .join("\n");

  for (const to of notify) {
    await sendEmail(to, subject, text, false);
  }

  if (applicantEmail) {
    await sendEmail(
      applicantEmail,
      "Beypro Application Received",
      "Your application has been received.\nOur team will review your information and contact you shortly.\nStatus: Pending Approval",
      false
    );
  }
}

// POST /api/public/driver-register (multipart/form-data)
router.post(
  "/driver-register",
  upload.fields([
    { name: "driver_license", maxCount: 1 },
    { name: "vehicle_registration", maxCount: 1 },
    { name: "insurance_policy", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      await ensureApplicationTables(pool);
    } catch (err) {
      console.error("❌ ensureApplicationTables failed:", err);
      return res.status(500).json({ success: false, error: "Server misconfigured" });
    }

    const body = req.body || {};
    const files = req.files || {};

    const required = [
      "full_name",
      "phone",
      "email",
      "turkish_id",
      "date_of_birth",
      "vehicle_type",
      "plate_number",
      "license_type",
      "vehicle_ownership",
      "tax_status",
      "tax_number",
      "tax_city",
      "iban",
      "contract_version",
      "contract_text",
    ];

    for (const key of required) {
      const r = requireField(body, key);
      if (!r.ok) return res.status(400).json({ success: false, error: r.error });
    }

    if (!isValidTurkishId(body.turkish_id)) {
      return res.status(400).json({ success: false, error: "Invalid turkish_id (must be 11 digits)" });
    }
    if (!isValidIban(body.iban)) {
      return res.status(400).json({ success: false, error: "Invalid iban (expected TR + 24 digits)" });
    }

    const hasTrafficInsurance = toBool(body.has_traffic_insurance);
    const hasCourierInsurance = toBool(body.has_courier_insurance);
    const acceptsDocRequests = toBool(body.accepts_doc_requests);
    const contractScrolled = toBool(body.contract_scrolled);
    const contractAccepted = toBool(body.contract_accepted);
    const kvkkConsent = toBool(body.kvkk_consent);

    if (!hasTrafficInsurance || !hasCourierInsurance || !acceptsDocRequests) {
      return res.status(400).json({ success: false, error: "Insurance/compliance checkboxes are required" });
    }
    if (!contractScrolled) {
      return res.status(400).json({ success: false, error: "Contract must be scrolled before submission" });
    }
    if (!contractAccepted) {
      return res.status(400).json({ success: false, error: "Contract acceptance is required" });
    }
    if (!kvkkConsent) {
      return res.status(400).json({ success: false, error: "KVKK consent is required" });
    }

    const dl = files.driver_license?.[0] || null;
    const vr = files.vehicle_registration?.[0] || null;
    const ip = files.insurance_policy?.[0] || null;

    if (!dl || !vr) {
      return res.status(400).json({ success: false, error: "driver_license and vehicle_registration are required" });
    }

    const payload = {
      status: "PENDING",
      full_name: String(body.full_name || "").trim(),
      phone: String(body.phone || "").trim(),
      email: String(body.email || "").trim().toLowerCase(),
      turkish_id: String(body.turkish_id || "").trim(),
      date_of_birth: String(body.date_of_birth || "").trim(),

      vehicle_type: String(body.vehicle_type || "").trim(),
      plate_number: String(body.plate_number || "").trim(),
      license_type: String(body.license_type || "").trim(),
      vehicle_ownership: String(body.vehicle_ownership || "").trim(),

      tax_status: String(body.tax_status || "").trim(),
      tax_number: String(body.tax_number || "").trim(),
      tax_city: String(body.tax_city || "").trim(),
      iban: normalizeIban(body.iban),

      has_traffic_insurance: hasTrafficInsurance,
      has_courier_insurance: hasCourierInsurance,
      accepts_doc_requests: acceptsDocRequests,
      kvkk_consent: kvkkConsent,

      contract_scrolled: contractScrolled,
      contract_accepted: contractAccepted,
      contract_version: String(body.contract_version || "").trim(),
      contract_text: String(body.contract_text || "").trim(),
    };

    const applicationId = uuidv4();

    try {
      const documents = {
        driver_license: await writeEncryptedUpload({ applicationId, field: "driver_license", file: dl }),
        vehicle_registration: await writeEncryptedUpload({
          applicationId,
          field: "vehicle_registration",
          file: vr,
        }),
        insurance_policy: ip
          ? await writeEncryptedUpload({ applicationId, field: "insurance_policy", file: ip })
          : null,
      };

      const enc = encryptJson(payload);

      await pool.query(
        `INSERT INTO driver_applications
          (id, status, payload_ciphertext, payload_iv, payload_tag, documents)
         VALUES ($1, 'PENDING', $2, $3, $4, $5)`,
        [applicationId, enc.ciphertextB64, enc.ivB64, enc.tagB64, documents]
      );

      void sendNewApplicationEmails({
        type: "driver",
        applicantEmail: payload.email,
        applicantName: payload.full_name,
        applicationId,
      });

      return res.json({ success: true, id: applicationId, status: "PENDING" });
    } catch (err) {
      const msg = err?.message || "Failed to save application";
      const statusCode =
        /virus detected/i.test(msg) ? 400 : /scanner is not available|virus scan failed/i.test(msg) ? 503 : 500;
      console.error("❌ driver-register error:", err);
      return res.status(statusCode).json({ success: false, error: msg });
    }
  }
);

// POST /api/public/restaurant-register (application/json)
router.post("/restaurant-register", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
  } catch (err) {
    console.error("❌ ensureApplicationTables failed:", err);
    return res.status(500).json({ success: false, error: "Server misconfigured" });
  }

  const body = req.body || {};

  const required = [
    "restaurant_name",
    "legal_company_name",
    "authorized_person",
    "phone",
    "email",
    "city",
    "full_address",
    "maps_pin",
    "company_type",
    "tax_number",
    "tax_office",
    "iban",
    "delivery_radius_km",
    "operating_hours",
    "avg_prep_time_min",
    "entrance_pickup_accepted",
    "delivery_fee_per_delivery",
    "billing_cycle",
    "contract_version",
    "contract_text",
  ];

  for (const key of required) {
    const r = requireField(body, key);
    if (!r.ok) return res.status(400).json({ success: false, error: r.error });
  }

  if (!isValidIban(body.iban)) {
    return res.status(400).json({ success: false, error: "Invalid iban (expected TR + 24 digits)" });
  }

  const entrancePickupAccepted = toBool(body.entrance_pickup_accepted);
  const contractScrolled = toBool(body.contract_scrolled);
  const contractAccepted = toBool(body.contract_accepted);
  const entrancePickupPolicyAccepted = toBool(body.entrance_pickup_policy_accepted);
  const cancellationNoShowAccepted = toBool(body.cancellation_no_show_rules_accepted);
  const kvkkConsent = toBool(body.kvkk_consent);

  if (!entrancePickupAccepted) {
    return res.status(400).json({ success: false, error: "entrance_pickup_accepted is required" });
  }
  if (!contractScrolled) {
    return res.status(400).json({ success: false, error: "Contract must be scrolled before submission" });
  }
  if (!contractAccepted) {
    return res.status(400).json({ success: false, error: "Contract acceptance is required" });
  }
  if (!entrancePickupPolicyAccepted) {
    return res.status(400).json({ success: false, error: "Entrance-pickup policy acceptance is required" });
  }
  if (!cancellationNoShowAccepted) {
    return res.status(400).json({ success: false, error: "Cancellation & no-show rules acceptance is required" });
  }
  if (!kvkkConsent) {
    return res.status(400).json({ success: false, error: "KVKK consent is required" });
  }

  const radius = Number(body.delivery_radius_km);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 20) {
    return res.status(400).json({ success: false, error: "delivery_radius_km must be between 1 and 20" });
  }

  const prep = Number(body.avg_prep_time_min);
  if (!Number.isFinite(prep) || prep <= 0 || prep > 240) {
    return res.status(400).json({ success: false, error: "avg_prep_time_min must be 1–240" });
  }

  const fee = Number(body.delivery_fee_per_delivery);
  if (!Number.isFinite(fee) || fee !== 50) {
    return res.status(400).json({ success: false, error: "delivery_fee_per_delivery must be 50" });
  }

  const billingCycle = String(body.billing_cycle || "").trim().toLowerCase();
  if (!["weekly", "monthly"].includes(billingCycle)) {
    return res.status(400).json({ success: false, error: "billing_cycle must be weekly or monthly" });
  }

  const payload = {
    status: "PENDING",
    restaurant_name: String(body.restaurant_name || "").trim(),
    legal_company_name: String(body.legal_company_name || "").trim(),
    authorized_person: String(body.authorized_person || "").trim(),
    phone: String(body.phone || "").trim(),
    email: String(body.email || "").trim().toLowerCase(),
    city: String(body.city || "").trim(),
    full_address: String(body.full_address || "").trim(),
    maps_pin: String(body.maps_pin || "").trim(),

    company_type: String(body.company_type || "").trim(),
    tax_number: String(body.tax_number || "").trim(),
    tax_office: String(body.tax_office || "").trim(),
    iban: normalizeIban(body.iban),

    delivery_radius_km: radius,
    operating_hours: String(body.operating_hours || "").trim(),
    avg_prep_time_min: prep,
    entrance_pickup_accepted: entrancePickupAccepted,

    delivery_fee_per_delivery: fee,
    billing_cycle: billingCycle,

    contract_scrolled: contractScrolled,
    contract_accepted: contractAccepted,
    entrance_pickup_policy_accepted: entrancePickupPolicyAccepted,
    cancellation_no_show_rules_accepted: cancellationNoShowAccepted,
    kvkk_consent: kvkkConsent,
    contract_version: String(body.contract_version || "").trim(),
    contract_text: String(body.contract_text || "").trim(),

    notes: body.notes ? String(body.notes).trim() : null,
  };

  const applicationId = uuidv4();
  try {
    const enc = encryptJson(payload);
    await pool.query(
      `INSERT INTO restaurant_applications
        (id, status, payload_ciphertext, payload_iv, payload_tag)
       VALUES ($1, 'PENDING', $2, $3, $4)`,
      [applicationId, enc.ciphertextB64, enc.ivB64, enc.tagB64]
    );

    void sendNewApplicationEmails({
      type: "restaurant",
      applicantEmail: payload.email,
      applicantName: payload.authorized_person,
      applicationId,
    });

    return res.json({ success: true, id: applicationId, status: "PENDING" });
  } catch (err) {
    console.error("❌ restaurant-register error:", err);
    return res.status(500).json({ success: false, error: "Failed to save request" });
  }
});

// ---------- Error handler (multer / body size) ----------
router.use((err, req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        error: `File too large (max ${UPLOAD_MAX_MB}MB per file)`,
      });
    }
    return res.status(400).json({ success: false, error: err.message || "Upload failed" });
  }

  if (err?.type === "entity.too.large") {
    return res.status(413).json({ success: false, error: "Request body too large" });
  }

  console.error("❌ publicRegistrations error:", err);
  return res.status(500).json({ success: false, error: "Unexpected server error" });
});

module.exports = router;
