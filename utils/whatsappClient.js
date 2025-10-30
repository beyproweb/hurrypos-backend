// utils/whatsappClient.js
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");
const fs = require("fs");
const { pool } = require("../db");

const tenantClients = new Map();

// ✅ Stable and async-safe version
async function getWhatsAppClient(restaurantId) {
  if (!restaurantId) throw new Error("restaurantId is required");

  // 🧩 Return existing client if already active or initializing
  const existing = tenantClients.get(restaurantId);
  if (existing) {
    // ✅ Check real connection state
    const state = await existing.getState?.().catch(() => "DISCONNECTED");

    // Skip repair if still initializing
    if (existing.isInitializing) {
      console.log(`⏳ Tenant ${restaurantId} client still initializing… skipping repair.`);
      return existing;
    }

    // If connected, reuse directly
    if (state === "CONNECTED") {
      console.log(
        `♻️ Reusing existing WhatsApp client for tenant ${restaurantId} (ready=${existing.isReady})`
      );
      return existing;
    }

    // Only repair if truly disconnected
// Only repair if truly disconnected or Puppeteer crashed
console.warn(`🔄 Repairing WhatsApp client for tenant ${restaurantId} (state=${state})`);

try {
  // Hard reset: close old browser entirely
  if (existing.pupBrowser) {
    await existing.pupBrowser.close().catch(() => {});
  }
  await existing.destroy().catch(() => {});
} catch (e) {
  console.warn(`⚠️ Failed to destroy old client for tenant ${restaurantId}:`, e.message);
}

tenantClients.delete(restaurantId);

// Ensure puppeteer closes properly before re-init
await new Promise(r => setTimeout(r, 2000));

const fresh = await getWhatsAppClient(restaurantId);
fresh.isInitializing = true;
fresh.initialize();
return fresh;

  }

  // 📁 Ensure per-tenant session directory exists
  const sessionDir = path.join(__dirname, "..", "whatsapp-sessions", `tenant_${restaurantId}`);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  // 🧹 Clean stale Chrome locks
  try {
    const lock1 = path.join(sessionDir, "chrome-profile", "SingletonLock");
    const lock2 = path.join(sessionDir, "session", "SingletonLock");
    [lock1, lock2].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  } catch (err) {
    console.warn(`⚠️ Could not remove old lock for tenant ${restaurantId}:`, err.message);
  }

  const chromePath =
    process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  // 🧠 Initialize WhatsApp client
  const client = new Client({
  // LocalAuth already handles session storage safely

  authStrategy: new LocalAuth({ dataPath: sessionDir }),
  puppeteer: {
    headless: false,
    executablePath: chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,720",
      "--app=https://web.whatsapp.com/",
      "--remote-debugging-port=9222",
    ],
  },
});
// 🩹 Patch sendMessage to bypass internal getChat()
const origSend = Client.prototype.sendMessage;
Client.prototype.sendMessage = async function (chatId, content, options = {}) {
  try {
    // ✅ Prefer low-level socket send (no page.evaluate)
    if (this.pupPage && this.sendMessageToId) {
      return await this.sendMessageToId(chatId, content, options);
    }
    // fallback to original safe call
    return await origSend.call(this, chatId, content, options);
  } catch (err) {
    console.warn("⚠️ Patched sendMessage fallback:", err.message);
    return await origSend.call(this, chatId, content, options);
  }
};

// 🔗 Capture Puppeteer handles for safe cleanup later
client.once("ready", async () => {
  try {
    client.pupBrowser = await client.pupBrowser?.isConnected?.()
      ? client.pupBrowser
      : await client.pupPage?.browser?.();
    client.pupPage = client.pupPage || (await client.pupBrowser?.pages?.())?.[0];
  } catch (e) {
    console.warn("⚠️ Could not capture Puppeteer handles:", e.message);
  }
});
client.on("ready", async () => {
  try {
    await client.pupPage.evaluate(() => {
  if (window.Store && window.Store.sendMessage) return;

  // New WhatsApp Web uses dynamic webpackChunk names
  const findStore = () => {
    const key = Object.keys(window).find(k =>
      k.startsWith("webpackChunk") && window[k] instanceof Array
    );
    const chunk = window[key];
    if (!chunk) throw new Error("No webpack chunk found");
    let store;
    chunk.push([
      [Math.random()],
      {},
      (req) => {
        for (const m of Object.keys(req.c)) {
          try {
            const mod = req.c[m].exports;
            if (mod && mod.default && mod.default.Chat && mod.default.Msg) {
              store = mod.default;
              break;
            }
          } catch {}
        }
      },
    ]);
    return store;
  };

  window.Store = findStore();
  console.log("🧩 window.Store injected successfully");
});

    console.log("🧠 WhatsApp Store initialized in page context");
  } catch (err) {
    console.warn("⚠️ Could not inject Store:", err.message);
  }

  client.isReady = true;
  client.isInitializing = false;
  console.log(`✅ WhatsApp client ready for tenant ${restaurantId}`);
});

  client.isInitializing = true;
  tenantClients.set(restaurantId, client);

  // === EVENT HANDLERS ===
  client.on("qr", (qr) => {
    console.log(`📱 [Tenant ${restaurantId}] Scan this QR with WhatsApp:`);
    qrcode.generate(qr, { small: true });
    client._lastQr = qr;
  });

  client.on("authenticated", async () => {
    console.log(`🔑 Authenticated tenant ${restaurantId}`);
    const checkInfo = async (tries = 0) => {
      if (client.info && client.info.wid) {
        console.log(`✅ WhatsApp account info loaded for tenant ${restaurantId}:`, client.info.wid._serialized);
        client.isReady = true;
        client.isInitializing = false;
        return;
      }

      try {
        const state = await client.getState();
        console.log(`📶 State after auth: ${state}`);
        if (state === "CONNECTED") {
          console.warn(`⚙️ Forcing ready state for tenant ${restaurantId} (client.info missing but connected).`);
          client.isReady = true;
          client.isInitializing = false;
          return;
        }
      } catch {}

      if (tries < 10) {
        setTimeout(() => checkInfo(tries + 1), 3000);
      } else {
        console.warn(`⚠️ Still no client.info after 30s for tenant ${restaurantId}, forcing as ready.`);
        client.isReady = true;
        client.isInitializing = false;
      }
    };
    checkInfo();
  });

  client.on("ready", () => {
    client.isReady = true;
    client.isInitializing = false;
    console.log(`✅ WhatsApp client ready for tenant ${restaurantId}`);
  });

  client.on("auth_failure", (msg) => {
    client.isReady = false;
    client.isInitializing = false;
    console.error(`❌ Auth failed for tenant ${restaurantId}:`, msg);
  });

// 🧩 Prevent Node from crashing on Puppeteer disconnects
process.on("unhandledRejection", (err) => {
  if (String(err).includes("Session closed")) {
    console.warn("⚠️ Ignored Puppeteer session closed (safe)");
  } else {
    console.error("❌ Unhandled rejection:", err);
  }
});

client.on("disconnected", async (reason) => {
  console.warn(`⚠️ WhatsApp disconnected for tenant ${restaurantId}: ${reason}`);

  // Skip immediate restart if user logged out manually
  if (String(reason).toLowerCase().includes("logout")) {
    console.log(`🧹 Manual logout for tenant ${restaurantId}. Waiting for QR re-scan.`);
    tenantClients.delete(restaurantId);
    return; // do NOT reinit automatically — frontend will show QR again
  }

  // Auto-reconnect for transient disconnects only
  setTimeout(async () => {
    try {
      await client.destroy().catch(() => {});
      tenantClients.delete(restaurantId);
      console.log(`♻️ Restarting WhatsApp client for tenant ${restaurantId}...`);
      const newClient = getWhatsAppClient(restaurantId);
      await new Promise((r) => setTimeout(r, 2000));
      newClient.initialize();
    } catch (e) {
      console.error(`❌ Reinit failed for tenant ${restaurantId}:`, e.message);
    }
  }, 4000); // small delay prevents “Session closed” error
});


  client.on("message_create", (msg) => {
    if (msg.fromMe)
      console.log(`📤 [Tenant ${restaurantId}] Sent → ${msg.to}: ${msg.body}`);
  });

  // 🚀 Initialize
  console.log(`🚀 Initializing WhatsApp client for tenant ${restaurantId}...`);
  client
    .initialize()
    .then(async () => {
      console.log(`🚀 Initialization promise resolved for tenant ${restaurantId}`);
      try {
        const version = await client.getWWebVersion();
        console.log(`🌐 WhatsApp Web version: ${version}`);
        const state = await client.getState();
        console.log(`📶 Current state: ${state}`);
      } catch (err) {
        console.warn(`⚠️ Could not fetch version/state for tenant ${restaurantId}:`, err.message);
      }

      // ⏳ Wait until ready
      let waited = 0;
      const interval = setInterval(async () => {
        if (client.isReady) return clearInterval(interval);
        const state = await client.getState().catch(() => "DISCONNECTED");
        if (client.info && client.info.wid) {
          clearInterval(interval);
          client.isReady = true;
          client.isInitializing = false;
          console.log(`✅ WhatsApp client fully ready for tenant ${restaurantId} (${client.info.wid._serialized})`);
        } else if (state === "CONNECTED" && waited >= 10) {
          clearInterval(interval);
          console.warn(`⚙️ Forcing ready state for tenant ${restaurantId} after waiting ${waited * 2}s`);
          client.isReady = true;
          client.isInitializing = false;
        } else {
          waited++;
          if (waited % 3 === 0) {
            console.log(`⏳ Waiting for WhatsApp info for tenant ${restaurantId}... (${waited * 2}s)`);
          }
        }
      }, 2000);

      setTimeout(() => {
        if (!client.isReady) {
          clearInterval(interval);
          console.warn(`⚠️ WhatsApp client still not ready after 60s for tenant ${restaurantId}. Forcing as ready.`);
          client.isReady = true;
          client.isInitializing = false;
        }
      }, 60000);
    })
    .catch((err) => {
      client.isInitializing = false;
      console.error(`❌ WhatsApp init failed for tenant ${restaurantId}:`, err.message);
    });

  return client;
}

// 🔄 Auto-initialize all tenants on startup
async function initAllTenants() {
  try {
    const { rows } = await pool.query("SELECT id FROM restaurants ORDER BY id ASC");
    console.log(`🌐 Initializing WhatsApp for ${rows.length} tenants...`);
    for (const { id } of rows) {
      await new Promise((r) => setTimeout(r, 4000));
      getWhatsAppClient(id);
    }
  } catch (err) {
    console.error("❌ initAllTenants error:", err.message);
  }
}

module.exports = { getWhatsAppClient, initAllTenants };
