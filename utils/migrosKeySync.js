// utils/migrosKeySync.js
/**
 * Migros API Key Synchronization
 * Syncs API keys from Migros using Store/GetDefinedActiveRestaurantApiKeys
 */

const { pool } = require("../db");
const { postToMigros } = require("./migrosClient");

const dlog = (...args) =>
  console.log(new Date().toISOString(), "[migros-key-sync]", ...args);

// =========================================================
// KEY SYNC
// =========================================================

/**
 * Sync restaurant API keys from Migros
 * Calls Store/GetDefinedActiveRestaurantApiKeys (unencrypted)
 * and stores the results in migros_restaurant_keys table
 *
 * @param {string} secretKey - Secret key from Migros (stored in env or admin-provided)
 * @returns {Promise<{success: boolean, message: string, synced: number, errors: Array}>}
 */
async function syncMigrosRestaurantApiKeys(secretKey) {
  if (!secretKey) {
    dlog("❌ Missing secretKey for key sync");
    return {
      success: false,
      message: "Missing secretKey",
      synced: 0,
      errors: ["Missing secretKey"],
    };
  }

  try {
    dlog("🔄 Starting Migros API key sync...");

    // Call unencrypted endpoint to get keys
    const plainBody = { secretKey };
    const result = await postToMigros(
      "Store/GetDefinedActiveRestaurantApiKeys",
      null, // No apiKey needed for this endpoint
      plainBody,
      secretKey
    );

    if (!result.ok) {
      dlog(`❌ Migros key sync failed: ${result.error}`);
      return {
        success: false,
        message: `Migros API error: ${result.error}`,
        synced: 0,
        errors: [result.error],
      };
    }

    const responseData = result.data;
    if (!responseData || !responseData.data) {
      dlog("❌ Invalid response format from Migros");
      return {
        success: false,
        message: "Invalid response format",
        synced: 0,
        errors: ["Invalid response format from Migros"],
      };
    }

    // Parse the API key data
    const apiKeys = responseData.data; // Array of RestaurantApiKeyDto
    let syncedCount = 0;
    let skippedCount = 0;
    const errors = [];

    dlog(`📦 Processing ${apiKeys.length} API key records from Migros...`);

    // Start transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const keyRecord of apiKeys) {
        try {
          const apiKey = keyRecord.apiKey;
          const isActive = keyRecord.isActive && keyRecord.isPosFirmActive;

          // Each key can have multiple store groups
          const storeGroups = keyRecord.restaurantStoreGroups || [];

          for (const storeGroup of storeGroups) {
            const storeGroupId = storeGroup.storeGroupId;
            const stores = storeGroup.restaurantStores || [];

            for (const store of stores) {
              const storeId = store.storeId;

              // We need to find which restaurant in Beypro this maps to
              // For now, we'll store by external_migros_remote_id or similar
              // This requires a way to map Migros store IDs back to Beypro restaurants
              // 
              // If we already have a migros_restaurant_keys entry with this store_id,
              // we should update it. Otherwise, we need a mapping mechanism.

              // Try to find existing entry
              const existing = await client.query(
                `SELECT id, restaurant_id FROM migros_restaurant_keys 
                 WHERE store_id = $1 AND store_group_id = $2`,
                [storeId, storeGroupId]
              );

              if (existing.rows.length > 0) {
                // Update existing entry
                const restaurantId = existing.rows[0].restaurant_id;
                await client.query(
                  `UPDATE migros_restaurant_keys 
                   SET api_key = $1, is_active = $2, synced_at = NOW()
                   WHERE id = $3`,
                  [apiKey, isActive, existing.rows[0].id]
                );
                syncedCount++;
                dlog(`✅ Updated key for restaurant ${restaurantId}, store ${storeId}`);
              } else {
                // Skip - no restaurant mapping found
                // This would need a separate mapping table or external configuration
                dlog(
                  `⏭️  Skipped store ${storeId} (no restaurant mapping found)`
                );
                skippedCount++;
              }
            }
          }
        } catch (err) {
          dlog(`❌ Error processing API key record:`, err.message);
          errors.push(err.message);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Update last sync time in settings
    try {
      await pool.query(
        `UPDATE settings 
         SET integrations = jsonb_set(
           COALESCE(integrations, '{}'::jsonb),
           '{migros,lastKeySync}',
           to_jsonb(now())
         )
         WHERE key = 'global'`
      );
    } catch (err) {
      dlog("⚠️  Could not update last sync time:", err.message);
    }

    dlog(
      `✅ Key sync completed: ${syncedCount} synced, ${skippedCount} skipped, ${errors.length} errors`
    );

    return {
      success: true,
      message: `Synced ${syncedCount} API keys`,
      synced: syncedCount,
      skipped: skippedCount,
      errors,
    };
  } catch (err) {
    dlog(`❌ Key sync error:`, err.message);
    return {
      success: false,
      message: err.message,
      synced: 0,
      errors: [err.message],
    };
  }
}

/**
 * Create a mapping between Migros store ID and Beypro restaurant
 * This should be called to register a restaurant for Migros sync
 *
 * @param {number} restaurantId - Beypro restaurant ID
 * @param {string} apiKey - Migros API key
 * @param {number} storeId - Migros store ID
 * @param {number} storeGroupId - Migros store group ID
 * @returns {Promise<boolean>}
 */
async function createMigrosRestaurantMapping(
  restaurantId,
  apiKey,
  storeId,
  storeGroupId
) {
  if (!restaurantId || !apiKey || !storeId || !storeGroupId) {
    dlog("❌ Missing required parameters for mapping");
    return false;
  }

  try {
    await pool.query(
      `INSERT INTO migros_restaurant_keys (restaurant_id, api_key, store_id, store_group_id, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (restaurant_id) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         store_id = EXCLUDED.store_id,
         store_group_id = EXCLUDED.store_group_id,
         is_active = true,
         synced_at = NOW()`,
      [restaurantId, apiKey, storeId, storeGroupId]
    );

    dlog(
      `✅ Created/updated mapping: restaurant ${restaurantId} -> store ${storeId}`
    );
    return true;
  } catch (err) {
    dlog(`❌ Error creating mapping:`, err.message);
    return false;
  }
}

/**
 * Deactivate a Migros integration for a restaurant
 * @param {number} restaurantId - Beypro restaurant ID
 * @returns {Promise<boolean>}
 */
async function deactivateMigrosRestaurant(restaurantId) {
  if (!restaurantId) return false;

  try {
    await pool.query(
      `UPDATE migros_restaurant_keys SET is_active = false WHERE restaurant_id = $1`,
      [restaurantId]
    );
    dlog(`✅ Deactivated Migros for restaurant ${restaurantId}`);
    return true;
  } catch (err) {
    dlog(`❌ Error deactivating:`, err.message);
    return false;
  }
}

/**
 * Get integration health status
 * @returns {Promise<{secretKeyExists: boolean, lastSyncTime: Date|null, activeKeyCount: number, lastError: Object|null}>}
 */
async function getMigrosIntegrationHealth() {
  try {
    const settingsRes = await pool.query(
      `SELECT integrations FROM settings WHERE key = 'global'`
    );
    const integrations = settingsRes.rows[0]?.integrations || {};
    const migrosConfig = integrations.migros || {};

    const keysRes = await pool.query(
      `SELECT COUNT(*) as count FROM migros_restaurant_keys WHERE is_active = true`
    );

    return {
      secretKeyExists: !!process.env.MIGROS_SECRET_KEY,
      lastSyncTime: migrosConfig.lastKeySync || null,
      lastApiSync: migrosConfig.lastKeySync || null,
      activeKeyCount: parseInt(keysRes.rows[0]?.count || 0, 10),
      lastError: migrosConfig.lastApiError || null,
    };
  } catch (err) {
    dlog("❌ Error getting health status:", err.message);
    return {
      secretKeyExists: false,
      lastSyncTime: null,
      activeKeyCount: 0,
      lastError: err.message,
    };
  }
}

module.exports = {
  syncMigrosRestaurantApiKeys,
  createMigrosRestaurantMapping,
  deactivateMigrosRestaurant,
  getMigrosIntegrationHealth,
};
