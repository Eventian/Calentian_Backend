import cors from 'cors';
import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { createClient } from 'webdav';

dotenv.config();
const app = express();
const upload = multer();

// 🌍 Zulässige Ursprünge
const allowedOrigins = [
  'http://localhost:4200',
  'https://dashboard.calentian.de',
];

// 🔧 Zusätzlicher Header-Schutz – auch für Fehlerfälle
const setCORSHeaders = (req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
};

// 🧠 Reihenfolge ist wichtig!
app.use(setCORSHeaders);
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());

// 🔐 Auth Middleware – liest Token aus Cookie
const authMiddleware = (req, res, next) => {
  const token = req.cookies['access_token'];
  if (!token) {
    return res.status(401).json({ message: 'Token fehlt' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Token ungültig oder abgelaufen' });
    }
    req.user = user;
    next();
  });
};

// 📦 WebDAV-Client
const getWebdavClient = () =>
  createClient(process.env.STORAGEBOX_HOST, {
    username: process.env.STORAGEBOX_USER,
    password: process.env.STORAGEBOX_PASS,
  });

// 📤 Profilbild abrufen
app.get('/data-storage/profilbild', authMiddleware, async (req, res) => {
  const userId = req.user.calentian_benutzer_id;
  const path = `/calentian_benutzer/${userId}/profilbild.jpg`;
  const client = getWebdavClient();

  try {
    console.log(`[GET] Profilbild-Request für User ${userId}`);

    const stream = await client.createReadStream(path);
  console.log('Stream erhalten, sende Bild...');

    // Cache-Header abhängig vom Query-Parameter
    if (!req.query.t) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 Tag
    } else {
      res.setHeader('Cache-Control', 'no-store'); // Kein Caching
    }

    res.setHeader('Content-Type', 'image/jpeg');
    stream.pipe(res);
  } catch (err) {
      console.error('Fehler beim Laden des Bildes:', err.message);

    res.status(404).json({ message: 'Datei nicht gefunden.' });
  }
});

// 📥 Profilbild hochladen
app.post('/data-storage/profilbild', authMiddleware, upload.single('file'), async (req, res) => {
  const userId = req.user.id;
  const path = `/calentian_benutzer/${userId}/profilbild.jpg`;
  const client = getWebdavClient();

  try {
    await client.putFileContents(path, req.file.buffer, { overwrite: true });

    res.json({
      message: 'Upload erfolgreich.',
      timestamp: Date.now(), // für Cache-Buster
    });
  } catch (err) {
    res.status(500).json({ message: 'Upload fehlgeschlagen.', fehler: err.message });
  }
});

// 🚀 Server starten
const PORT = process.env.PORT || 4200;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});

