// �� Notwendige Imports
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import stream from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// 📄 .env laden
dotenv.config();

// 🚀 Express Setup
const app = express();

// 📤 Multer Konfiguration für Datei-Uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    // Nur Bilder erlauben
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Nur Bilddateien sind erlaubt"), false);
    }
  },
});

// �� Erlaubte Ursprünge
const allowedOrigins = [
  "http://localhost:4200",
  "https://dashboard.calentian.de",
];

// 🛡️ CORS Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  next();
});
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// 🔐 Auth Middleware
const authMiddleware = (req, res, next) => {
  const token = req.cookies["access_token"];
  if (!token) return res.status(401).json({ message: "Token fehlt" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err)
      return res
        .status(403)
        .json({ message: "Token ungültig oder abgelaufen" });
    req.user = user;
    next();
  });
};

// 🌐 S3 Client Setup
const s3 = new S3Client({
  region: process.env.SCW_REGION,
  endpoint: process.env.SCW_ENDPOINT,
  credentials: {
    accessKeyId: process.env.SCW_ACCESS_KEY,
    secretAccessKey: process.env.SCW_SECRET_KEY,
  },
});

// �� Upload Profilbild
app.post(
  "/data-storage/profilbild",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "Keine Datei hochgeladen" });
    }

    const userId = req.user.calentian_benutzer_id;
    const key = `calentian_benutzer/${userId}/profilbild.jpg`;

    try {
      const command = new PutObjectCommand({
        Bucket: process.env.SCW_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || "image/jpeg",
        Metadata: {
          userId: userId.toString(),
          uploadedAt: new Date().toISOString(),
        },
      });

      await s3.send(command);
      res.json({
        message: "Upload erfolgreich.",
        timestamp: Date.now(),
        fileName: `profilbild_${userId}_${Date.now()}.jpg`,
      });
    } catch (err) {
      console.error("Upload-Fehler:", err);
      res
        .status(500)
        .json({ message: "Upload fehlgeschlagen.", fehler: err.message });
    }
  }
);

// 📥 Download Profilbild
app.get("/data-storage/profilbild", authMiddleware, async (req, res) => {
  const userId = req.user.calentian_benutzer_id;
  const key = `calentian_benutzer/${userId}/profilbild.jpg`;

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.SCW_BUCKET,
      Key: key,
    });

    const result = await s3.send(command);
    const bodyStream = result.Body;

    if (!req.query.t) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }

    res.setHeader("Content-Type", result.ContentType || "image/jpeg");
    bodyStream.pipe(res);
  } catch (err) {
    console.error("Download-Fehler:", err.message);

    // Spezifische Fehlerbehandlung
    if (err.name === "NoSuchKey") {
      return res.status(404).json({ message: "Profilbild nicht gefunden." });
    }

    res.status(500).json({ message: "Fehler beim Laden des Profilbilds." });
  }
});

// 📤 Upload Anbieter-Logo
app.post(
  "/data-storage/logo",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ message: "Keine Datei hochgeladen" });
    }

    const entryId = req.user.calentian_entries_id;
    const key = `entries/${entryId}/logo.jpg`;

    try {
      const command = new PutObjectCommand({
        Bucket: process.env.SCW_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || "image/jpeg",
        Metadata: {
          entryId: entryId.toString(),
          uploadedAt: new Date().toISOString(),
        },
      });

      await s3.send(command);
      res.json({
        message: "Logo-Upload erfolgreich.",
        timestamp: Date.now(),
        fileName: `logo_${entryId}_${Date.now()}.jpg`,
      });
    } catch (err) {
      console.error("Logo-Upload-Fehler:", err);
      res.status(500).json({
        message: "Logo-Upload fehlgeschlagen.",
        fehler: err.message,
      });
    }
  }
);

// 📥 Download Anbieter-Logo
app.get("/data-storage/logo", authMiddleware, async (req, res) => {
  const entryId = req.user.calentian_entries_id;
  const key = `entries/${entryId}/logo.jpg`;

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.SCW_BUCKET,
      Key: key,
    });

    const result = await s3.send(command);
    const bodyStream = result.Body;

    // Cache-Control basierend auf Query-Parameter
    if (!req.query.t) {
      res.setHeader("Cache-Control", "public, max-age=86400"); // 24 Stunden Cache
    } else {
      res.setHeader("Cache-Control", "no-store"); // Kein Cache bei Cache-Busting
    }

    res.setHeader("Content-Type", result.ContentType || "image/jpeg");
    bodyStream.pipe(res);
  } catch (err) {
    console.error("Logo-Download-Fehler:", err.message);

    // Spezifische Fehlerbehandlung
    if (err.name === "NoSuchKey") {
      return res.status(404).json({ message: "Anbieter-Logo nicht gefunden." });
    }

    res.status(500).json({ message: "Fehler beim Laden des Anbieter-Logos." });
  }
});

// 🔗 Presigned Upload-URL generieren
app.post("/data-storage/presigned-upload", authMiddleware, async (req, res) => {
  const { entryId, eventId, filename, contentType } = req.body;

  if (!entryId || !eventId || !filename || !contentType) {
    return res.status(400).json({ message: "Pflichtfelder fehlen." });
  }

  // Zugriffsschutz – prüfen, ob Nutzer zu entryId gehört
  if (req.user.calentian_entries_id !== entryId) {
    return res
      .status(403)
      .json({ message: "Zugriff verweigert – falscher Anbieter." });
  }

  const key = `entries/${entryId}/events/${eventId}/uploads/${filename}`;

  try {
    const command = new PutObjectCommand({
      Bucket: process.env.SCW_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 Min gültig

    res.json({ url: signedUrl, key });
  } catch (err) {
    console.error("Presigned URL Fehler:", err);
    res
      .status(500)
      .json({ message: "Presigned Upload URL konnte nicht erstellt werden." });
  }
});

// 🚀 Server starten
const PORT = process.env.PORT || 4200;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
