const express = require("express");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db");
const { ensureApplicationTables } = require("../utils/applicationsTables");
const { decryptJson, decryptBuffer } = require("../utils/piiCrypto");
const { sendEmail } = require("../utils/notifications");

const router = express.Router();

function safeJson(res) {
  if (!res || typeof res !== "object") return null;
  return res;
}

function normalizeStatus(value) {
  const v = String(value || "").trim().toUpperCase();
  if (!v) return null;
  if (v === "PENDING" || v === "APPROVED" || v === "REJECTED") return v;
  return null;
}

function privateUploadsBaseDir() {
  return path.resolve(path.join(__dirname, "..", "private_uploads", "applications"));
}

function ensurePathIsPrivate(p) {
  const base = privateUploadsBaseDir();
  const resolved = path.resolve(String(p || ""));
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error("Invalid storage path");
  }
  return resolved;
}

async function decryptPayloadFromRow(row) {
  const decrypted = decryptJson({
    ciphertextB64: row.payload_ciphertext,
    ivB64: row.payload_iv,
    tagB64: row.payload_tag,
  });
  return decrypted;
}

function cleanInlineText(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function applicationsSupportEmail() {
  return (
    process.env.APPLICATIONS_SUPPORT_EMAIL ||
    process.env.SUPPORT_EMAIL ||
    process.env.SMTP_USER ||
    "support@beypro.com"
  );
}

function buildDecisionEmail({ type, decision, applicationId, applicantName, adminNotes }) {
  const safeName = cleanInlineText(applicantName) || "there";
  const safeNotes = cleanInlineText(adminNotes);
  const support = applicationsSupportEmail();
  const kind = type === "restaurant" ? "Restaurant" : "Driver";

  const subject =
    decision === "APPROVED"
      ? `Beypro: ${kind} application approved (${applicationId})`
      : `Beypro: ${kind} application update (${applicationId})`;

  const statusLineTr = decision === "APPROVED" ? "Başvurunuz ONAYLANDI" : "Başvurunuz REDDEDİLDİ";
  const statusLineEn = decision === "APPROVED" ? "Your application is APPROVED" : "Your application is REJECTED";

  const nextTr =
    decision === "APPROVED"
      ? "Bir sonraki adım için ekibimiz sizinle iletişime geçecek."
      : "Şu an için başvurunuzu onaylayamıyoruz. İsterseniz güncel belgelerle tekrar başvurabilirsiniz.";
  const nextEn =
    decision === "APPROVED"
      ? "Our team will contact you with the next steps."
      : "We can’t approve your application at this time. You may re-apply later with updated information/documents.";

  const notesBlock =
    safeNotes && decision !== "APPROVED"
      ? `
        <div style="margin-top:16px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb">
          <div style="font-weight:700;margin-bottom:6px">Notes / Not</div>
          <div style="white-space:pre-line;color:#111827">${safeNotes.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
        </div>
      `
      : "";

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;line-height:1.45;color:#0f172a">
      <div style="max-width:640px;margin:0 auto;padding:24px">
        <div style="font-size:18px;font-weight:800;margin-bottom:8px">Beypro</div>
        <div style="padding:18px 16px;border:1px solid #e5e7eb;border-radius:14px;background:#ffffff">
          <div style="font-size:16px;margin-bottom:10px">Hi ${safeName},</div>
          <div style="font-size:14px;color:#111827;margin-bottom:10px">
            <div style="font-weight:700">${statusLineTr}</div>
            <div style="margin-top:4px;color:#334155">${nextTr}</div>
          </div>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0" />
          <div style="font-size:14px;color:#111827;margin-bottom:10px">
            <div style="font-weight:700">${statusLineEn}</div>
            <div style="margin-top:4px;color:#334155">${nextEn}</div>
          </div>
          <div style="font-size:13px;color:#475569;margin-top:14px">
            Application ID: <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${applicationId}</span>
          </div>
          ${notesBlock}
          <div style="font-size:13px;color:#475569;margin-top:16px">
            Need help? Contact us at <a href="mailto:${support}" style="color:#2563eb;text-decoration:none">${support}</a>.
          </div>
        </div>
        <div style="font-size:12px;color:#94a3b8;margin-top:10px">
          This is an automated message; please reply to the support email above.
        </div>
      </div>
    </div>
  `;

  return { subject, html };
}

function maybeSendDecisionEmail({ type, decision, applicationId, payload, adminNotes }) {
  const to = cleanInlineText(payload?.email);
  if (!to) return;

  const applicantName =
    type === "restaurant"
      ? payload?.authorized_person || payload?.restaurant_name || payload?.legal_company_name
      : payload?.full_name;

  const { subject, html } = buildDecisionEmail({
    type,
    decision,
    applicationId,
    applicantName,
    adminNotes,
  });

  void sendEmail({
    to,
    subject,
    html,
    fromName: "Beypro Applications",
    replyTo: applicationsSupportEmail(),
  });
}

router.get("/drivers", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const status = normalizeStatus(req.query.status);

    const params = [];
    let where = "";
    if (status) {
      params.push(status);
      where = `WHERE status = $1`;
    }

    const { rows } = await pool.query(
      `
      SELECT id, status, admin_notes, created_at, updated_at,
             payload_ciphertext, payload_iv, payload_tag
      FROM driver_applications
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
      `,
      params
    );

    const items = [];
    for (const row of rows || []) {
      let payload = null;
      try {
        payload = await decryptPayloadFromRow(row);
      } catch {
        payload = null;
      }
      items.push({
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        admin_notes: row.admin_notes || null,
        full_name: payload?.full_name || null,
        email: payload?.email || null,
        phone: payload?.phone || null,
      });
    }

    return res.json({ success: true, items });
  } catch (err) {
    console.error("❌ GET /api/internal/applications/drivers failed:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/drivers/:id", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const { rows } = await pool.query(
      `
      SELECT id, status, admin_notes, created_at, updated_at, reviewed_at, reviewed_by,
             payload_ciphertext, payload_iv, payload_tag,
             documents
      FROM driver_applications
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const row = rows?.[0];
    if (!row) return res.status(404).json({ success: false, error: "Not found" });

    const payload = await decryptPayloadFromRow(row);
    return res.json({
      success: true,
      application: {
        id: row.id,
        status: row.status,
        admin_notes: row.admin_notes || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        reviewed_at: row.reviewed_at,
        reviewed_by: row.reviewed_by || null,
        payload,
        documents: safeJson(row.documents) || null,
      },
    });
  } catch (err) {
    console.error("❌ GET /api/internal/applications/drivers/:id failed:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/drivers/:id/documents/:key", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const id = String(req.params.id || "").trim();
    const key = String(req.params.key || "").trim();

    const allowed = new Set(["driver_license", "vehicle_registration", "insurance_policy"]);
    if (!allowed.has(key)) return res.status(400).json({ success: false, error: "Invalid document key" });

    const { rows } = await pool.query(`SELECT documents FROM driver_applications WHERE id = $1 LIMIT 1`, [id]);
    const docs = rows?.[0]?.documents || null;
    const doc = docs?.[key] || null;
    if (!doc || !doc.storage_path || !doc.enc_iv || !doc.enc_tag) {
      return res.status(404).json({ success: false, error: "Document not found" });
    }

    const storagePath = ensurePathIsPrivate(doc.storage_path);
    const ciphertext = await fs.promises.readFile(storagePath);
    const plaintext = decryptBuffer({ ciphertext, ivB64: doc.enc_iv, tagB64: doc.enc_tag });

    res.setHeader("Content-Type", doc.mime || "application/octet-stream");
    const filename = String(doc.original_name || `${key}.bin`).replace(/[\r\n"]/g, "");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(plaintext);
  } catch (err) {
    console.error("❌ GET /api/internal/applications/drivers/:id/documents/:key failed:", err);
    return res.status(500).json({ success: false, error: "Failed to download document" });
  }
});

router.post("/drivers/:id/decision", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const decision = normalizeStatus(req.body?.decision);
    if (!decision || decision === "PENDING") {
      return res.status(400).json({ success: false, error: "decision must be APPROVED or REJECTED" });
    }

    const adminNotes = typeof req.body?.admin_notes === "string" ? req.body.admin_notes.trim() : null;
    const convert = !!req.body?.convert;

    const client = await pool.connect();
    let decisionEmailPayload = null;
    let decisionEmailShouldSend = false;
    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT id, status, payload_ciphertext, payload_iv, payload_tag FROM driver_applications WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const row = existing.rows?.[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Not found" });
      }

      const previousStatus = String(row.status || "").trim().toUpperCase();
      decisionEmailShouldSend = previousStatus !== decision;
      if (decisionEmailShouldSend) {
        try {
          decisionEmailPayload = await decryptPayloadFromRow(row);
        } catch {
          decisionEmailPayload = null;
        }
      }

      await client.query(
        `UPDATE driver_applications
         SET status = $2,
             admin_notes = $3,
             updated_at = NOW(),
             reviewed_at = NOW(),
             reviewed_by = $4
         WHERE id = $1`,
        [id, decision, adminNotes, req.devUser?.email || null]
      );

      let activeId = null;
      if (decision === "APPROVED" && convert) {
        activeId = uuidv4();
        await client.query(
          `INSERT INTO active_drivers (id, application_id, payload_ciphertext, payload_iv, payload_tag)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (application_id) DO NOTHING`,
          [activeId, id, row.payload_ciphertext, row.payload_iv, row.payload_tag]
        );
      }

      await client.query("COMMIT");
      if (decisionEmailShouldSend && decisionEmailPayload) {
        maybeSendDecisionEmail({
          type: "driver",
          decision,
          applicationId: id,
          payload: decisionEmailPayload,
          adminNotes,
        });
      }
      return res.json({ success: true, id, status: decision, active_id: activeId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ POST /api/internal/applications/drivers/:id/decision failed:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/restaurants", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const status = normalizeStatus(req.query.status);

    const params = [];
    let where = "";
    if (status) {
      params.push(status);
      where = `WHERE status = $1`;
    }

    const { rows } = await pool.query(
      `
      SELECT id, status, admin_notes, created_at, updated_at,
             payload_ciphertext, payload_iv, payload_tag
      FROM restaurant_applications
      ${where}
      ORDER BY created_at DESC
      LIMIT 200
      `,
      params
    );

    const items = [];
    for (const row of rows || []) {
      let payload = null;
      try {
        payload = await decryptPayloadFromRow(row);
      } catch {
        payload = null;
      }
      items.push({
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        admin_notes: row.admin_notes || null,
        restaurant_name: payload?.restaurant_name || null,
        legal_company_name: payload?.legal_company_name || null,
        email: payload?.email || null,
        phone: payload?.phone || null,
      });
    }

    return res.json({ success: true, items });
  } catch (err) {
    console.error("❌ GET /api/internal/applications/restaurants failed:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.get("/restaurants/:id", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const { rows } = await pool.query(
      `
      SELECT id, status, admin_notes, created_at, updated_at, reviewed_at, reviewed_by,
             payload_ciphertext, payload_iv, payload_tag
      FROM restaurant_applications
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    const row = rows?.[0];
    if (!row) return res.status(404).json({ success: false, error: "Not found" });

    const payload = await decryptPayloadFromRow(row);
    return res.json({
      success: true,
      application: {
        id: row.id,
        status: row.status,
        admin_notes: row.admin_notes || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        reviewed_at: row.reviewed_at,
        reviewed_by: row.reviewed_by || null,
        payload,
      },
    });
  } catch (err) {
    console.error("❌ GET /api/internal/applications/restaurants/:id failed:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

router.post("/restaurants/:id/decision", async (req, res) => {
  try {
    await ensureApplicationTables(pool);
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "id is required" });

    const decision = normalizeStatus(req.body?.decision);
    if (!decision || decision === "PENDING") {
      return res.status(400).json({ success: false, error: "decision must be APPROVED or REJECTED" });
    }

    const adminNotes = typeof req.body?.admin_notes === "string" ? req.body.admin_notes.trim() : null;
    const convert = !!req.body?.convert;

    const client = await pool.connect();
    let decisionEmailPayload = null;
    let decisionEmailShouldSend = false;
    try {
      await client.query("BEGIN");

      const existing = await client.query(
        `SELECT id, status, payload_ciphertext, payload_iv, payload_tag FROM restaurant_applications WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const row = existing.rows?.[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, error: "Not found" });
      }

      const previousStatus = String(row.status || "").trim().toUpperCase();
      decisionEmailShouldSend = previousStatus !== decision;
      if (decisionEmailShouldSend) {
        try {
          decisionEmailPayload = await decryptPayloadFromRow(row);
        } catch {
          decisionEmailPayload = null;
        }
      }

      await client.query(
        `UPDATE restaurant_applications
         SET status = $2,
             admin_notes = $3,
             updated_at = NOW(),
             reviewed_at = NOW(),
             reviewed_by = $4
         WHERE id = $1`,
        [id, decision, adminNotes, req.devUser?.email || null]
      );

      let activeId = null;
      if (decision === "APPROVED" && convert) {
        activeId = uuidv4();
        await client.query(
          `INSERT INTO active_restaurants (id, application_id, payload_ciphertext, payload_iv, payload_tag)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (application_id) DO NOTHING`,
          [activeId, id, row.payload_ciphertext, row.payload_iv, row.payload_tag]
        );
      }

      await client.query("COMMIT");
      if (decisionEmailShouldSend && decisionEmailPayload) {
        maybeSendDecisionEmail({
          type: "restaurant",
          decision,
          applicationId: id,
          payload: decisionEmailPayload,
          adminNotes,
        });
      }
      return res.json({ success: true, id, status: decision, active_id: activeId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ POST /api/internal/applications/restaurants/:id/decision failed:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

module.exports = router;
