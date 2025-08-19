// routes/categoryImages.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { pool } = require("../db");
const cloudinary = require("../cloudinary"); // <-- use cloudinary
const streamifier = require("streamifier");

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/", upload.single("image"), async (req, res) => {
  try {
    const { category } = req.body;
    if (!category || !req.file) {
      return res.status(400).json({ error: "Category and image required" });
    }

    // Upload to Cloudinary
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "category_images", public_id: `cat_${Date.now()}` },
      async (err, result) => {
        if (err || !result) {
          console.error("Cloudinary upload error:", err);
          return res.status(500).json({ error: "Image upload failed" });
        }

        // Save URL in DB
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

router.get("/", async (req, res) => {
  try {
    const { category } = req.query;
    const query = category
      ? "SELECT category, image FROM category_images WHERE category = $1"
      : "SELECT category, image FROM category_images";
    const params = category ? [category] : [];
    const { rows } = await pool.query(query, params);

    // images are already full Cloudinary URLs
    res.json(rows);
  } catch (e) {
    console.error("❌ Category image fetch failed:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
