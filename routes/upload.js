const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();

// Always use memory storage for direct Cloudinary uploads
const upload = multer({ storage: multer.memoryStorage() });

// FIELD NAME **MUST** be "file" for both frontend & backend!
router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Logging for debug:
  console.log("✅ [UPLOAD] Received file:", req.file.originalname, "-", req.file.mimetype);

  // Upload to Cloudinary using memory buffer
  const stream = cloudinary.uploader.upload_stream(
    { folder: "products" },
    (error, result) => {
      if (error) {
        console.error("❌ [UPLOAD] Cloudinary error:", error);
        return res.status(500).json({ error: "Cloudinary upload failed" });
      }
      if (!result || !result.secure_url) {
        console.error("❌ [UPLOAD] No URL returned from Cloudinary:", result);
        return res.status(500).json({ error: "No URL returned from Cloudinary" });
      }
      res.json({ url: result.secure_url });
    }
  );

  stream.end(req.file.buffer);
});

module.exports = router;
