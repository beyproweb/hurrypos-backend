const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const router = express.Router();
const MAX_VIDEO_UPLOAD_MB = Number(process.env.MAX_VIDEO_UPLOAD_MB || 95);
const MAX_VIDEO_UPLOAD_BYTES = Math.max(
  1,
  Math.floor(MAX_VIDEO_UPLOAD_MB * 1024 * 1024)
);

// Always use memory storage for direct Cloudinary uploads
const upload = multer({ storage: multer.memoryStorage() });

// FIELD NAME **MUST** be "file" for both frontend & backend!
router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Logging for debug:
  const sizeBytes = Number(req.file.size || 0);
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log(
    "✅ [UPLOAD] Received file:",
    req.file.originalname,
    "-",
    req.file.mimetype,
    `(${sizeMb} MB)`
  );
  const mimeType = String(req.file.mimetype || "").toLowerCase();
  const isVideoUpload = mimeType.startsWith("video/");
  const cloudinaryResourceType = isVideoUpload ? "video" : "image";
  const targetFolder = isVideoUpload ? "videos" : "products";
  if (isVideoUpload && sizeBytes > MAX_VIDEO_UPLOAD_BYTES) {
    return res.status(413).json({
      error: `Video is too large (${sizeMb} MB). Max allowed is ${MAX_VIDEO_UPLOAD_MB} MB.`,
    });
  }

  // Upload to Cloudinary using memory buffer
  const stream = cloudinary.uploader.upload_stream(
    { folder: targetFolder, resource_type: cloudinaryResourceType },
    (error, result) => {
      if (error) {
        console.error("❌ [UPLOAD] Cloudinary error:", error);
        if (Number(error?.http_code) === 413) {
          return res.status(413).json({
            error: `Cloudinary rejected this file as too large. Please compress the video to under ${MAX_VIDEO_UPLOAD_MB} MB.`,
          });
        }
        return res.status(500).json({
          error: `Cloudinary upload failed: ${error?.message || "Unknown error"}`,
        });
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
