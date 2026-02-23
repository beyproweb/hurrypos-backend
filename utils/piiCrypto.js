const crypto = require("crypto");

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function getEncryptionSecret() {
  return (
    process.env.PII_ENCRYPTION_KEY ||
    process.env.PII_ENCRYPTION_SECRET ||
    process.env.ENCRYPTION_KEY ||
    null
  );
}

function getKey() {
  const secret = getEncryptionSecret();
  if (!secret) {
    if (isProduction()) {
      throw new Error("PII_ENCRYPTION_KEY is required in production");
    }
    console.warn("⚠️ PII_ENCRYPTION_KEY is missing (dev fallback in use).");
  }

  const material = secret || "dev_insecure_pii_key_change_me";
  return crypto.createHash("sha256").update(material, "utf8").digest(); // 32 bytes
}

function encryptJson(payload) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: "v1",
    ciphertextB64: ciphertext.toString("base64"),
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
  };
}

function decryptJson({ ciphertextB64, ivB64, tagB64 }) {
  const key = getKey();
  const iv = Buffer.from(String(ivB64), "base64");
  const tag = Buffer.from(String(tagB64), "base64");
  const ciphertext = Buffer.from(String(ciphertextB64), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function encryptBuffer(buffer) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: "v1",
    ciphertext,
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
  };
}

function decryptBuffer({ ciphertext, ivB64, tagB64 }) {
  const key = getKey();
  const iv = Buffer.from(String(ivB64), "base64");
  const tag = Buffer.from(String(tagB64), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  encryptJson,
  decryptJson,
  encryptBuffer,
  decryptBuffer,
};

