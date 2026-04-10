const {
  normalizePhoneForVerification,
  createHttpError,
} = require("./customerPhoneVerification");

function normalizeText(value) {
  return String(value || "").trim();
}

function shouldUseNetgsmProvider() {
  const explicitProvider = normalizeText(process.env.QR_PHONE_OTP_PROVIDER).toLowerCase();
  if (explicitProvider) {
    return explicitProvider === "netgsm";
  }
  return process.env.NODE_ENV === "production";
}

function resolveOtpMessageTemplate() {
  const configuredTemplate = normalizeText(process.env.QR_PHONE_OTP_MESSAGE_TEMPLATE);
  if (configuredTemplate) return configuredTemplate;
  return "Beypro dogrulama kodunuz: {{code}}. Kod {{minutes}} dakika gecerlidir.";
}

function buildOtpMessage({ code, ttlSeconds }) {
  const minutes = Math.max(1, Math.ceil(Number(ttlSeconds || 0) / 60));
  const template = resolveOtpMessageTemplate();
  return template
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

async function sendPhoneOtpSms({ phoneNumber, code, ttlSeconds }) {
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
