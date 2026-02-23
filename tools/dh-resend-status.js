/* eslint-disable no-console */
/**
 * Manual Delivery Hero / Yemeksepeti callback re-sync helper.
 *
 * Examples:
 *   node tools/dh-resend-status.js --order-id 10008 --status order_picked_up
 *   node tools/dh-resend-status.js --external-id a1s8-r0t1 --status order_rejected --reason "customer requested"
 *   node tools/dh-resend-status.js --order-id 10008 --status preparation-completed
 */

const { pool } = require("../db");
const {
  getMiddlewareBearerForCallbackUrl,
  clearMiddlewareBearerForCallbackUrl,
} = require("../utils/dhMiddlewareToken");

const parseArgs = (argv) => {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const normalized = key.slice(2).replace(/-/g, "_");
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
    args[normalized] = value;
    if (value !== true) i += 1;
  }
  return args;
};

const parseCallbackUrls = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  return null;
};

const resolveUrl = (callbackUrls, status) => {
  if (!callbackUrls || typeof callbackUrls !== "object") return null;
  if (status === "order_accepted") return callbackUrls.orderAcceptedUrl || null;
  if (status === "order_rejected") return callbackUrls.orderRejectedUrl || null;
  if (status === "order_picked_up") return callbackUrls.orderPickedUpUrl || null;
  if (status === "preparation-completed") return callbackUrls.orderPreparedUrl || null;
  return null;
};

const buildPayload = ({ status, reason }) => {
  if (status === "order_rejected") {
    const rejectionComment = reason || "cancelled_by_pos";
    return {
      status: "order_rejected",
      rejectionReason: { code: "other", comment: rejectionComment },
      reason: rejectionComment,
    };
  }
  if (status === "preparation-completed") return {};
  return { status };
};

async function main() {
  const args = parseArgs(process.argv);
  const orderId = args.order_id ? Number(args.order_id) : null;
  const externalId = typeof args.external_id === "string" ? args.external_id : null;
  const status = typeof args.status === "string" ? args.status : null;
  const reason = typeof args.reason === "string" ? args.reason : null;

  if (!status) {
    console.error("Missing --status");
    process.exit(2);
  }

  if (status === "order_delivered") {
    console.error(
      "`order_delivered` is not supported by middlewareExternalApi status callbacks. Use `order_picked_up` (vendor delivery) or check with DH for delivered support."
    );
    process.exit(2);
  }

  if (!orderId && !externalId) {
    console.error("Provide --order-id <id> OR --external-id <code>");
    process.exit(2);
  }

  const whereSql = orderId ? "id = $1" : "external_id = $1";
  const whereVal = orderId ? orderId : externalId;

  const { rows } = await pool.query(
    `SELECT id, external_id, external_callback_urls
       FROM orders
      WHERE ${whereSql}
      LIMIT 1`,
    [whereVal]
  );

  if (!rows.length) {
    console.error("Order not found");
    process.exit(1);
  }

  const order = rows[0];
  const callbackUrls = parseCallbackUrls(order.external_callback_urls);
  const url = resolveUrl(callbackUrls, status);
  if (!url) {
    console.error("Missing callback URL for status:", status);
    console.error("callbackUrls:", callbackUrls);
    process.exit(1);
  }

  const payload = buildPayload({ status, reason });
  const method = status === "preparation-completed" ? "POST" : "POST";

  console.log("Order:", { id: order.id, external_id: order.external_id });
  console.log("Sending:", { method, url, payload });

  let authHeader = await getMiddlewareBearerForCallbackUrl(url);
  let response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: status === "preparation-completed" ? undefined : JSON.stringify(payload),
  });
  let responseBody = await response.text();

  if (response.status === 401 && authHeader) {
    clearMiddlewareBearerForCallbackUrl(url);
    authHeader = await getMiddlewareBearerForCallbackUrl(url);
    response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: status === "preparation-completed" ? undefined : JSON.stringify(payload),
    });
    responseBody = await response.text();
  }

  console.log("Response:", response.status, responseBody);
  process.exit(response.ok ? 0 : 1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {}
  });

