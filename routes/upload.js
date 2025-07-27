// routes/upload.js
const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/", upload.single("file"), (req, res) => {
  try {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "products" },
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error);
          return res.status(500).json({ error: error.message });
        }
        res.json({ url: result.secure_url });
      }
    );
    stream.end(req.file.buffer);
  } catch (err) {
    console.error("Upload handler error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
