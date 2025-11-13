// routes/yemeksepetiMenu.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const axios = require("axios");
const extApiAuth = require("../middleware/externalApiAuth");

const YS_MENU_TRIGGER_RESPONSE_URL = process.env.YS_MENU_TRIGGER_RESPONSE_URL;
const YS_MENU_STATUS_CALLBACK_URL = process.env.YS_MENU_STATUS_CALLBACK_URL;


//
// 1️⃣ MENU IMPORT TRIGGER (GET)
//    GET /api/integrations/yemeksepeti/menuimport/:remoteId
//
router.get("/menuimport/:remoteId", extApiAuth, async (req, res) => {
  const remoteId = req.params.remoteId;
  const vendorCode = req.query.vendorCode;
  const menuImportId = req.query.menuImportId;

  // Map remoteId → restaurant_id
  const r = await pool.query(
    "SELECT id FROM restaurants WHERE external_remote_id = $1 LIMIT 1",
    [remoteId]
  );

  if (!r.rows.length) return res.status(404).send();

  const restaurantId = r.rows[0].id;

  // MUST send 202 immediately
  res.status(202).send();

  setTimeout(async () => {
    try {
      const menuPayload = await buildMenu(restaurantId);

      await axios.post(YS_MENU_TRIGGER_RESPONSE_URL, {
        vendorCode,
        menuImportId,
        menu: menuPayload
      });

      await sendCatalogStatus(menuImportId, vendorCode, "done", "Menu imported");

    } catch (err) {
      console.error("❌ Failed menu import:", err);

      await sendCatalogStatus(menuImportId, vendorCode, "failed", err.message);
    }
  }, 50);
});


//
// 2️⃣ CATALOG IMPORT STATUS RECEIVER
//    POST /api/integrations/yemeksepeti/menuimport/callback
//
router.post("/menuimport/callback", extApiAuth, async (req, res) => {
  console.log("📥 Catalog import callback:", req.body);

  return res.status(200).send();
});


//
// Menu Builder (tenant-safe)
//
async function buildMenu(restaurantId) {
  const { rows: categories } = await pool.query(
    `SELECT id, name FROM categories WHERE restaurant_id = $1 ORDER BY sequence ASC`,
    [restaurantId]
  );

  const { rows: products } = await pool.query(
    `SELECT id, name, price, category_id, external_code AS remoteCode
     FROM products WHERE restaurant_id = $1 AND active IS NOT FALSE`,
    [restaurantId]
  );

  const { rows: groups } = await pool.query(
    `SELECT id, name FROM extras_groups WHERE restaurant_id = $1`,
    [restaurantId]
  );

  const { rows: items } = await pool.query(
    `SELECT id, group_id, ingredient_name, price, external_code AS remoteCode
     FROM extras_group_items WHERE restaurant_id = $1`,
    [restaurantId]
  );

  return {
    categories: categories.map(c => ({
      id: `CAT_${c.id}`,
      name: c.name
    })),

    products: products.map(p => ({
      id: `PROD_${p.id}`,
      name: p.name,
      categoryId: `CAT_${p.category_id}`,
      price: Number(p.price),
      remoteCode: p.remoteCode,
      images: [],
      variations: []
    })),

    options: groups.map(g => ({
      id: `OPT_${g.id}`,
      name: g.name,
      type: "multiple",
      minChoices: 0,
      maxChoices: 20,
      items: items
        .filter(i => i.group_id === g.id)
        .map((i, idx) => ({
          id: `MOD_${i.id}`,
          sequence: idx + 1
        }))
    })),

    modifiers: items.map(i => ({
      id: `MOD_${i.id}`,
      name: i.ingredient_name,
      price: Number(i.price),
      remoteCode: i.remoteCode
    })),

    availability: Object.fromEntries(
      products.map(p => [`PROD_${p.id}`, { available: true }])
    )
  };
}


//
// Send catalog import status
//
async function sendCatalogStatus(catalogId, vendorCode, status, message) {
  await axios.post(YS_MENU_STATUS_CALLBACK_URL, {
    catalogImportId: catalogId,
    status,
    message,
    details: [
      {
        vendorCode,
        status,
        message
      }
    ]
  });
}

module.exports = router;
