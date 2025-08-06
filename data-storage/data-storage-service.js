// data-storage-service.js
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
import initVault from "./vault-init.js";

// 📄 .env laden (für Vault und Bootstrap)
dotenv.config();

const allowedOrigins =
  process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) || [];

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: allowedOrigins, credentials: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Nur Bilddateien sind erlaubt"), false);
  },
});

const authMiddleware = (req, res, next) => {
  const token = req.cookies["access_token"];
  if (!token) return res.status(401).json({ message: "Token fehlt" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Token ungültig" });
    req.user = user;
    next();
  });
};

(async () => {
  const success = await initVault();
  if (!success) {
    console.error("❌ Vault-Initialisierung fehlgeschlagen.");
    process.exit(1);
  }

  const requiredScwSecrets = [
    "SCW_REGION",
    "SCW_ENDPOINT",
    "SCW_ACCESS_KEY",
    "SCW_SECRET_KEY",
    "SCW_BUCKET",
  ];
  const missingScwSecrets = requiredScwSecrets.filter(
    (key) => !process.env[key]
  );

  if (missingScwSecrets.length > 0) {
    console.warn(
      "⚠️ Scaleway-Konfiguration unvollständig! Fehlende Variablen:",
      missingScwSecrets
    );
  } else {
    console.log("✅ Scaleway-Konfiguration vollständig geladen.");
  }

  console.log("✅ Erlaubte CORS-Domains:", allowedOrigins);

  const s3 = new S3Client({
    region: process.env.SCW_REGION,
    endpoint: process.env.SCW_ENDPOINT,
    credentials: {
      accessKeyId: process.env.SCW_ACCESS_KEY,
      secretAccessKey: process.env.SCW_SECRET_KEY,
    },
  });

  app.post(
    "/data-storage/profilbild",
    authMiddleware,
    upload.single("file"),
    async (req, res) => {
      if (!req.file)
        return res.status(400).json({ message: "Keine Datei hochgeladen" });
      const userId = req.user.calentian_benutzer_id;
      const key = `calentian_benutzer/${userId}/profilbild.jpg`;

      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: process.env.SCW_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype || "image/jpeg",
            Metadata: {
              userId: userId.toString(),
              uploadedAt: new Date().toISOString(),
            },
          })
        );
        res.json({ message: "Upload erfolgreich.", fileName: key });
      } catch (err) {
        console.error("Upload-Fehler:", err);
        res.status(500).json({ message: "Upload fehlgeschlagen." });
      }
    }
  );

  app.get("/data-storage/profilbild", authMiddleware, async (req, res) => {
    const userId = req.user.calentian_benutzer_id;
    const key = `calentian_benutzer/${userId}/profilbild.jpg`;

    try {
      const result = await s3.send(
        new GetObjectCommand({ Bucket: process.env.SCW_BUCKET, Key: key })
      );
      res.setHeader("Content-Type", result.ContentType || "image/jpeg");
      res.setHeader(
        "Cache-Control",
        req.query.t ? "no-store" : "public, max-age=86400"
      );
      result.Body.pipe(res);
    } catch (err) {
      console.error("Download-Fehler:", err.message);
      res
        .status(err.name === "NoSuchKey" ? 404 : 500)
        .json({
          message:
            err.name === "NoSuchKey"
              ? "Profilbild nicht gefunden."
              : "Fehler beim Laden.",
        });
    }
  });

  app.post(
    "/data-storage/logo",
    authMiddleware,
    upload.single("file"),
    async (req, res) => {
      if (!req.file)
        return res.status(400).json({ message: "Keine Datei hochgeladen" });
      const entryId = req.user.calentian_entries_id;
      const key = `entries/${entryId}/logo.jpg`;

      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: process.env.SCW_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype || "image/jpeg",
            Metadata: {
              entryId: entryId.toString(),
              uploadedAt: new Date().toISOString(),
            },
          })
        );
        res.json({ message: "Logo-Upload erfolgreich.", fileName: key });
      } catch (err) {
        console.error("Logo-Upload-Fehler:", err);
        res.status(500).json({ message: "Logo-Upload fehlgeschlagen." });
      }
    }
  );

  app.get("/data-storage/logo", authMiddleware, async (req, res) => {
    const entryId = req.user.calentian_entries_id;
    const key = `entries/${entryId}/logo.jpg`;

    try {
      const result = await s3.send(
        new GetObjectCommand({ Bucket: process.env.SCW_BUCKET, Key: key })
      );
      res.setHeader("Content-Type", result.ContentType || "image/jpeg");
      res.setHeader(
        "Cache-Control",
        req.query.t ? "no-store" : "public, max-age=86400"
      );
      result.Body.pipe(res);
    } catch (err) {
      console.error("Logo-Download-Fehler:", err.message);
      res
        .status(err.name === "NoSuchKey" ? 404 : 500)
        .json({
          message:
            err.name === "NoSuchKey"
              ? "Logo nicht gefunden."
              : "Fehler beim Laden des Logos.",
        });
    }
  });

  app.post(
    "/data-storage/presigned-upload",
    authMiddleware,
    async (req, res) => {
      const { entryId, eventId, filename, contentType } = req.body;
      if (!entryId || !eventId || !filename || !contentType)
        return res.status(400).json({ message: "Pflichtfelder fehlen." });
      if (req.user.calentian_entries_id !== entryId)
        return res
          .status(403)
          .json({ message: "Zugriff verweigert – falscher Anbieter." });

      const key = `entries/${entryId}/events/${eventId}/uploads/${filename}`;
      try {
        const command = new PutObjectCommand({
          Bucket: process.env.SCW_BUCKET,
          Key: key,
          ContentType: contentType,
        });
        const signedUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
        res.json({ url: signedUrl, key });
      } catch (err) {
        console.error("Presigned URL Fehler:", err);
        res
          .status(500)
          .json({ message: "Presigned Upload URL fehlgeschlagen." });
      }
    }
  );

  const PORT = process.env.PORT || 4200;
  app.listen(PORT, () => {
    console.log(`✅ Server läuft auf Port ${PORT}`);
  });
})();
