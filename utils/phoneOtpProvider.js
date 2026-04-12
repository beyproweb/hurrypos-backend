const {
  normalizePhoneForVerification,
  createHttpError,
} = require("./customerPhoneVerification");

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeOtpLanguage(value) {
  const raw = normalizeText(value).toLowerCase().split(",")[0];
  const base = raw.split("-")[0];
  if (["tr", "en", "de", "fr"].includes(base)) return base;
  return "en";
}

function normalizeOtpBrandName(value) {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, 48) : "Restaurant";
}

function shouldUseNetgsmProvider() {
  const explicitProvider = normalizeText(process.env.QR_PHONE_OTP_PROVIDER).toLowerCase();
  if (explicitProvider) {
    return explicitProvider === "netgsm";
  }
  return process.env.NODE_ENV === "production";
}

function resolveOtpMessageTemplate(language) {
  const configuredTemplate = normalizeText(process.env.QR_PHONE_OTP_MESSAGE_TEMPLATE);
  if (configuredTemplate) return configuredTemplate;

  switch (normalizeOtpLanguage(language)) {
    case "tr":
      return "{{brand_name}} doğrulama kodunuz: {{code}}. Kod {{minutes}} dakika geçerlidir.";
    case "de":
      return "Ihr {{brand_name}}-Bestätigungscode lautet: {{code}}. Dieser Code ist {{minutes}} Minuten gültig.";
    case "fr":
      return "Votre code de vérification {{brand_name}} est : {{code}}. Ce code expire dans {{minutes}} minutes.";
    default:
      return "Your {{brand_name}} verification code is: {{code}}. This code expires in {{minutes}} minutes.";
  }
}

function buildOtpMessage({ code, ttlSeconds, language = "en", brandName = "" }) {
  const minutes = Math.max(1, Math.ceil(Number(ttlSeconds || 0) / 60));
  const template = resolveOtpMessageTemplate(language);
  return template
    .replace(/\{\{\s*brand_name\s*\}\}/gi, normalizeOtpBrandName(brandName))
    .replace(/\{\{\s*code\s*\}\}/gi, String(code))
    .replace(/\{\{\s*minutes\s*\}\}/gi, String(minutes));
}

async function sendViaNetgsm({ phoneNumber, message }) {
  const usercode = normalizeText(process.env.NETGSM_USERCODE);
  const password = normalizeText(process.env.NETGSM_PASSWORD);
  const msgheader = normalizeText(process.env.NETGSM_MSGHEADER);
  const baseUrl = normalizeText(process.env.NETGSM_BASE_URL) || "https://api.netgsm.com.tr";

  if (!usercode || !password || !msgheader) {
    throw createHttpError(
      500,
      "NETGSM credentials are missing. Set NETGSM_USERCODE, NETGSM_PASSWORD, NETGSM_MSGHEADER.",
      "netgsm_missing_credentials"
    );
  }

  const params = new URLSearchParams({
    usercode,
    password,
    msgheader,
    gsmno: phoneNumber,
    message,
    dil: "TR",
  });
  const requestUrl = `${baseUrl.replace(/\/+$/, "")}/sms/send/get/?${params.toString()}`;
  const response = await fetch(requestUrl, {
    method: "GET",
  });
  const bodyText = normalizeText(await response.text());

  if (!response.ok) {
    throw createHttpError(
      502,
      `Netgsm request failed with status ${response.status}`,
      "netgsm_request_failed"
    );
  }

  if (!bodyText.startsWith("00")) {
    throw createHttpError(
      502,
      `Netgsm rejected OTP send request (${bodyText || "unknown response"})`,
      "netgsm_rejected"
    );
  }

  return {
    provider: "netgsm",
    accepted: true,
    raw_response: bodyText,
  };
}

async function sendViaMock({ code }) {
  return {
    provider: "mock",
    accepted: true,
    mock_code: String(code),
  };
}

async function sendPhoneOtpSms({ phoneNumber, code, ttlSeconds, language = "en", brandName = "" }) {
  const normalizedPhone = normalizePhoneForVerification(phoneNumber);
  if (!normalizedPhone) {
    throw createHttpError(400, "Valid phone number is required", "invalid_phone");
  }
  const normalizedCode = normalizeText(code);
  if (!normalizedCode) {
    throw createHttpError(400, "Valid OTP code is required", "invalid_otp_code");
  }

  const message = buildOtpMessage({
    code: normalizedCode,
    ttlSeconds,
    language,
    brandName,
  });

  if (shouldUseNetgsmProvider()) {
    return sendViaNetgsm({
      phoneNumber: normalizedPhone,
      message,
    });
  }

  return sendViaMock({
    code: normalizedCode,
  });
}

module.exports = {
  sendPhoneOtpSms,
  buildOtpMessage,
};
