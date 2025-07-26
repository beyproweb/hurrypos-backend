const express = require("express");
const router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const { pool } = require("../db");
const fs = require("fs");

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post("/", upload.single("image"), async (req, res) => {
  const { category } = req.body;
  if (!category || !req.file) {
    return res.status(400).json({ error: "Category and image required" });
  }

  const uploadDir = path.join(__dirname, "..", "public", "uploads");
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  const filename = `catimg_${Date.now()}.jpg`;

  await sharp(req.file.buffer)
    .resize(200, 200, { fit: "cover" })
    .jpeg({ quality: 80 })
    .toFile(path.join(uploadDir, filename));

  await pool.query(
    `INSERT INTO category_images (category, image)
     VALUES ($1, $2)
     ON CONFLICT (category) DO UPDATE SET image = EXCLUDED.image`,
    [category, filename]
  );

  res.json({ success: true, image: filename });
});

router.get("/", async (req, res) => {
  const { category } = req.query;
  const query = category
    ? "SELECT category, image FROM category_images WHERE category = $1"
    : "SELECT category, image FROM category_images";
  const params = category ? [category] : [];
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

module.exports = router;
