/**
 * Migration: Add camera.live permission to all roles
 * 
 * This script adds the "camera.live" permission to existing roles in the database.
 * It can be run multiple times safely (idempotent).
 */

const { pool } = require("../db");

async function addCameraLivePermission() {
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    
    console.log("🎥 Adding camera.live permission to roles...\n");

    // Get all restaurants with users settings
    const restaurantsResult = await client.query(
      `SELECT restaurant_id, value FROM settings WHERE key = 'users' AND value IS NOT NULL`
    );

    let updatedCount = 0;

    for (const row of restaurantsResult.rows) {
      const restaurantId = row.restaurant_id;
      let config = row.value;

      // Parse if string
      if (typeof config === "string") {
        config = JSON.parse(config);
      }

      // Initialize roles if not present
      if (!config.roles) {
        config.roles = {};
      }

      console.log(`📋 Restaurant ID: ${restaurantId}`);
      console.log(`   Current roles: ${Object.keys(config.roles).join(", ")}`);

      // Add camera.live to each role if not already present
      for (const [roleName, permissions] of Object.entries(config.roles)) {
        if (!Array.isArray(permissions)) {
          console.log(`   ⚠️  Role '${roleName}' has invalid permissions format, skipping`);
          continue;
        }

        // Normalize permissions to lowercase
        const normalizedPerms = permissions.map((p) => String(p).toLowerCase());

        // Check if camera.live already exists
        if (!normalizedPerms.includes("camera.live")) {
          normalizedPerms.push("camera.live");
          config.roles[roleName] = normalizedPerms;
          console.log(`   ✅ Added camera.live to role: ${roleName}`);
        } else {
          console.log(`   ℹ️  Role ${roleName} already has camera.live`);
        }
      }

      // Save updated config
      await client.query(
        `
        UPDATE settings 
        SET value = $1::jsonb
        WHERE restaurant_id = $2 AND key = 'users'
        `,
        [JSON.stringify(config), restaurantId]
      );

      updatedCount++;
      console.log(`   💾 Saved for restaurant ${restaurantId}\n`);
    }

    await client.query("COMMIT");

    console.log(`✅ Migration complete!`);
    console.log(`   Updated ${updatedCount} restaurant(s)`);
    console.log(`   All roles now include 'camera.live' permission`);
    
    process.exit(0);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
  }
}

// Run if called directly
if (require.main === module) {
  addCameraLivePermission();
}

module.exports = { addCameraLivePermission };
