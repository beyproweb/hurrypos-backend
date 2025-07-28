// routes/upload.js
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

console.log("🌩️ Uploading to Cloudinary:", {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() }); // Use memory for Cloudinary

// FIELD NAME MUST BE "file" HERE:
// ✅ Final working setup:
router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  console.log("✅ Received file:", req.file.originalname);

  const stream = cloudinary.uploader.upload_stream(
    { folder: "products" },
    (error, result) => {
      if (error) {
        console.error("❌ Cloudinary upload error:", error);
        return res.status(500).json({ error });
      }
      res.json({ url: result.secure_url });
    }
  );

  stream.end(req.file.buffer);
});


module.exports = router;
