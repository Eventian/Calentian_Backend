/***********************************************************************
 * Notes-Service (Express, MySQL, CORS, JWT, Vault)
 *
 * Bietet CRUD-Endpunkte für Notizen, zieht DB- und JWT-Credentials aus Vault,
 * schützt Routen per JWT-Token in HTTP-only Cookie.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import express from "express";
import mysql from "mysql2/promise";
import jwt from "jsonwebtoken";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";

// Lade ENV und Vault-Settings
dotenv.config();

const app = express();

let dbPool;

// 1) DB-Pool initialisieren
async function initDB() {
  dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  console.log("✅ DB-Pool verbunden");
}

// 2) Auth-Middleware
function authenticateToken(req, res, next) {
  const token = req.cookies["access_token"];
  if (!token) return res.status(401).json({ error: "Kein Token vorhanden." });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token ungültig." });
    req.user = user;
    next();
  });
}

// 3) Middleware
app.set("trust proxy", 1);
app.use(helmet());
app.use(cookieParser());
app.use(express.json());

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Debug: Cookies
app.use((req, res, next) => {
  console.log("Cookies:", req.cookies);
  next();
});

// 4) Endpunkte
// GET /notes-service/notes?eventId=
app.get("/notes-service/notes", authenticateToken, async (req, res) => {
  const eventId = req.query.eventId;
  if (!eventId) return res.status(400).json({ error: "Event-ID fehlt." });
  try {
    const sql = `
      SELECT n.id, n.time, n.note, n.calentian_event_entries_id AS event_id, n.calentian_benutzer_id AS user_id,
             b.benutzername, b.email
      FROM calentian_notes n
      LEFT JOIN calentian_benutzer b ON n.calentian_benutzer_id = b.id
      WHERE n.calentian_event_entries_id = ?
      ORDER BY n.time DESC
    `;
    const [rows] = await dbPool.execute(sql, [eventId]);
    res.json(rows);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Notizen:", err);
    res.status(500).json({ error: "Fehler beim Abrufen der Notizen" });
  }
});

// POST /notes-service/notes
app.post("/notes-service/notes", authenticateToken, async (req, res) => {
  const { note, calentian_event_entries_id } = req.body;
  const userId = req.user.id;
  const entryId = calentian_event_entries_id || req.user.calentian_entries_id;
  if (!note) return res.status(400).json({ error: "Notiz fehlt." });
  try {
    const insertSql = `
      INSERT INTO calentian_notes (note, calentian_event_entries_id, calentian_benutzer_id)
      VALUES (?, ?, ?)
    `;
    const [result] = await dbPool.execute(insertSql, [note, entryId, userId]);
    const [[row]] = await dbPool.execute(
      "SELECT * FROM calentian_notes WHERE id = ?",
      [result.insertId]
    );
    res.status(201).json(row);
  } catch (err) {
    console.error("❌ Fehler beim Anlegen der Notiz:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Notiz" });
  }
});

// PUT /notes-service/notes/:id
app.put("/notes-service/notes/:id", authenticateToken, async (req, res) => {
  const noteId = req.params.id;
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: "Notiz fehlt." });
  try {
    const [[existing]] = await dbPool.execute(
      "SELECT * FROM calentian_notes WHERE id = ?",
      [noteId]
    );
    if (!existing)
      return res.status(404).json({ error: "Notiz nicht gefunden." });
    if (existing.calentian_benutzer_id !== req.user.id)
      return res.status(403).json({ error: "Nicht berechtigt." });
    await dbPool.execute("UPDATE calentian_notes SET note = ? WHERE id = ?", [
      note,
      noteId,
    ]);
    const [[row]] = await dbPool.execute(
      "SELECT * FROM calentian_notes WHERE id = ?",
      [noteId]
    );
    res.json(row);
  } catch (err) {
    console.error("❌ Fehler beim Aktualisieren der Notiz:", err);
    res.status(500).json({ error: "Fehler beim Aktualisieren der Notiz" });
  }
});

// DELETE /notes-service/notes/:id
app.delete("/notes-service/notes/:id", authenticateToken, async (req, res) => {
  const noteId = req.params.id;
  try {
    const [[existing]] = await dbPool.execute(
      "SELECT * FROM calentian_notes WHERE id = ?",
      [noteId]
    );
    if (!existing)
      return res.status(404).json({ error: "Notiz nicht gefunden." });
    if (existing.calentian_benutzer_id !== req.user.id)
      return res.status(403).json({ error: "Nicht berechtigt." });
    await dbPool.execute("DELETE FROM calentian_notes WHERE id = ?", [noteId]);
    res.json({ message: "Notiz gelöscht." });
  } catch (err) {
    console.error("❌ Fehler beim Löschen der Notiz:", err);
    res.status(500).json({ error: "Fehler beim Löschen der Notiz" });
  }
});

// 5) Bootstrap: Vault → DB → Server
async function bootstrap() {
  try {
    await initVault();
    await initDB();
    const port = process.env.PORT || 6100;
    app.listen(port, () => console.log(`🚀 Notes-Service auf Port ${port}`));
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
}

bootstrap();
