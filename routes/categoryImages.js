// routes/categoryImages.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { pool } = require("../db");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Upload category image
router.post("/", upload.single("image"), async (req, res) => {
  try {
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
          console.error("Cloudinary upload error:", err);
          return res.status(500).json({ error: "Image upload failed" });
        }

        // Save URL in DB (with category in lowercase)
        await pool.query(
          `INSERT INTO category_images (category, image)
           VALUES ($1, $2)
           ON CONFLICT (category) DO UPDATE SET image = EXCLUDED.image`,
          [category, result.secure_url]
        );

        res.json({ success: true, image: result.secure_url });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (e) {
    console.error("❌ Category upload failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Fetch category image(s)
router.get("/", async (req, res) => {
  try {
    let { category } = req.query;

    let query, params;
    if (category) {
      query = "SELECT category, image FROM category_images WHERE category = $1";
      params = [category.trim().toLowerCase()];
    } else {
      query = "SELECT category, image FROM category_images";
      params = [];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows); // each row has full Cloudinary URL now
  } catch (e) {
    console.error("❌ Category image fetch failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
