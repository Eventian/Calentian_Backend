/***********************************************************************
 * SMTP-Service (Express, MySQL, CORS, JWT, Vault)
 *
 * Sendet E-Mails über Brevo (Sendinblue) und speichert sie in der DB.
 * Zieht alle Secrets sicher aus Vault und nutzt ES-Module.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import express from "express";
import cors from "cors";
import axios from "axios";
import mysql from "mysql2/promise";
import jwt from "jsonwebtoken";

// Lade ENV und Vault-Settings
dotenv.config();

const app = express();
let db;

// 1) DB-Verbindung initialisieren
async function initDB() {
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  console.log("✅ Mit der MySQL-Datenbank verbunden");
}

// 2) Auth-Middleware
function checkJwt(req, res, next) {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    return res.status(403).json({ message: "Kein Token, Zugriff verweigert" });
  }
  const token = auth.split(" ")[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ message: "Ungültiges Token" });
  }
}

// 3) Middleware
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// 4) Brevo-Konfiguration prüfen
const BREVO_API_URL = "https://api.sendinblue.com/v3/smtp/email";
const BREVO_API_KEY = process.env.BREVO_API_KEY;
if (!BREVO_API_KEY) {
  console.error("❌ BREVO_API_KEY fehlt");
  process.exit(1);
}

// 5) Route: E-Mail versenden
app.post("/smtp-service/send-email", checkJwt, async (req, res) => {
  try {
    const { event_id, calentian_kundendaten_id, to, subject, text, htmlBody } =
      req.body;
    if (!to || !subject || !text) {
      return res.status(400).json({ message: "Erforderliche Felder fehlen." });
    }

    const entryId = req.user.calentian_entries_id;
    if (!entryId) {
      return res.status(400).json({ message: "Keine entryId im Token." });
    }

    // Entry-Daten
    const [rows] = await db.execute(
      `SELECT calentian_entries_name AS name,
              calentian_entries_zusatz AS zusatz,
              calentian_entries_zusatz_davor AS zusatzDavor
       FROM calentian_entries
       WHERE id = ? LIMIT 1`,
      [entryId]
    );
    if (!rows.length) {
      return res.status(404).json({ message: "Entry nicht gefunden." });
    }
    const { name, zusatz, zusatzDavor } = rows[0];

    // From-Name und From-E-Mail
    const fromName = zusatz
      ? zusatzDavor === 1
        ? `${zusatz} ${name}`
        : `${name} ${zusatz}`
      : name;
    const localPart =
      `${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-") + `-${entryId}`;
    const fromEmail = `${localPart}@mail-calentian.de`;

    // Brevo-Payload
    const brevoPayload = {
      sender: { name: fromName, email: fromEmail },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: htmlBody || text,
      headers: { "X-MailC-alentian-Entry": String(entryId) },
    };

    // Senden
    const brevoRes = await axios.post(BREVO_API_URL, brevoPayload, {
      headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    });

    // Speichern
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.execute(
      `INSERT INTO calentian_kunden_emails
         (subject, body, htmlBody, timestamp,
          sender, receiver,
          calentian_kundendaten_id,
          calentian_event_entries_id,
          attachments, status,
          calentian_entries_id, message_ingoing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, null, 0, ?, 0)`,
      [
        subject,
        text,
        htmlBody || text,
        now,
        fromEmail,
        to,
        calentian_kundendaten_id || null,
        event_id || null,
        entryId,
      ]
    );

    res.json({
      message: "E-Mail versendet & gespeichert",
      brevoInfo: brevoRes.data,
    });
  } catch (err) {
    console.error("Fehler in send-email:", err.response?.data || err.message);
    res.status(500).json({ message: "E-Mail-Versand fehlgeschlagen." });
  }
});

// 6) Bootstrap: Vault → DB → Server starten
async function bootstrap() {
  try {
    await initVault();
    await initDB();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`🚀 SMTP-Service auf Port ${PORT}`));
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
}
bootstrap();
