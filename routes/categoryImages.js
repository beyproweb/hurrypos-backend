// routes/categoryImages.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { pool } = require("../db");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");
const authMiddleware = require("../middleware/authMiddleware");

const storage = multer.memoryStorage();
const upload = multer({ storage });
// Authenticated routes below
router.use(authMiddleware);

async function resolveRestaurantId(req) {
  const identifier = req.query.identifier;
  let restaurant_id = req.user?.restaurant_id;

  if (identifier) {
    if (/^\d+$/.test(identifier)) {
      restaurant_id = Number(identifier);
    } else {
      const result = await pool.query("SELECT id FROM restaurants WHERE slug = $1", [identifier]);
      restaurant_id = result.rows[0]?.id;
    }
  }

  return restaurant_id;
}

// Fetch category image(s) (public)
router.get("/", async (req, res) => {
  try {
    const restaurant_id = await resolveRestaurantId(req);
    if (!restaurant_id) return res.status(400).json({ error: "Invalid restaurant" });

    let { category } = req.query;

    let query, params;
    if (category) {
      query = `
        SELECT category, image
        FROM category_images
        WHERE restaurant_id = $1 AND category = $2
      `;
      params = [restaurant_id, category.trim().toLowerCase()];
    } else {
      query = `
        SELECT category, image
        FROM category_images
        WHERE restaurant_id = $1
      `;
      params = [restaurant_id];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows); // each row has full Cloudinary URL now
  } catch (e) {
    // Keep: Useful for production debugging
    console.error("❌ Category image fetch failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});



// Upload category image
router.post("/", upload.single("image"), async (req, res) => {
  try {
    const restaurant_id = await resolveRestaurantId(req);
    if (!restaurant_id) return res.status(400).json({ error: "Invalid restaurant" });

    let { category } = req.body;
    if (!category || !req.file) {
      return res.status(400).json({ error: "Category and image required" });
    }

    // Always normalize category to lowercase
    category = category.trim().toLowerCase();

    // Upload to Cloudinary
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "category_images", public_id: `cat_${Date.now()}` },
      async (err, result) => {
        if (err || !result) {
          // Keep: Useful for production debugging
          console.error("Cloudinary upload error:", err);
          return res.status(500).json({ error: "Image upload failed" });
        }

        // Save URL in DB (with category in lowercase)
        await pool.query(
          `INSERT INTO category_images (restaurant_id, category, image)
           VALUES ($1, $2, $3)
           ON CONFLICT (restaurant_id, category) DO UPDATE SET image = EXCLUDED.image`,
          [restaurant_id, category, result.secure_url]
        );

        res.json({ success: true, image: result.secure_url });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (e) {
    // Keep: Useful for production debugging
    console.error("❌ Category upload failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
