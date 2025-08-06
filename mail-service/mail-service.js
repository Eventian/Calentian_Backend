/***********************************************************************
 * Mail-Service (Express, MySQL, CORS, JWT, Vault)
 *
 * Liefert Endpunkte für ungelesene und zuzuordnende Mails,
 * manuelle Zuweisung und Status-Update,
 * zieht DB- und JWT-Credentials sicher aus Vault.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

// Vault und ENV laden
dotenv.config();

// Express-App
const app = express();

// Globals
let dbPool;

// 1) DB-Pool initialisieren
async function initDB() {
  dbPool = mysql.createPool({
    host: process.env.DB_HOST,
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
  if (!token) return res.status(401).json({ message: "Kein Token gefunden." });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Ungültiger Token." });
    req.user = user;
    next();
  });
}

// 3) Middleware
const corsOptions = {
  origin: ["https://dashboard.calentian.de", "http://localhost:4200"],
  methods: ["GET", "POST"],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
// Debug: Cookies
app.use((req, res, next) => {
  console.log("Cookies:", req.cookies);
  next();
});

// 4) Endpunkte
// GET unread emails
app.get(
  "/mail-service/api/emails/unread",
  authenticateToken,
  async (req, res) => {
    try {
      const entryId = req.user.calentian_entries_id;
      const [emails] = await dbPool.query(
        `SELECT e.id, e.subject, e.body, e.htmlBody, e.timestamp, e.sender, e.receiver,
              e.calentian_event_entries_id AS event_id,
              e.status,
              e.calentian_email_status_id AS email_status_id,
              COALESCE(ev.event_name,'Unbenanntes Event') AS event_name
        FROM calentian_kunden_emails e
        LEFT JOIN calentian_event_entries ev ON e.calentian_event_entries_id = ev.id
       WHERE e.message_ingoing = 1
         AND e.calentian_email_status_id = 1
         AND e.calentian_entries_id = ?`,
        [entryId]
      );
      res.json(emails || []);
    } catch (err) {
      console.error("❌ Fehler beim Abrufen ungelesener E-Mails:", err);
      res.status(500).json({ message: "Fehler beim Abrufen der E-Mails" });
    }
  }
);

// GET to-assign emails
app.get(
  "/mail-service/api/emails/to-assign",
  authenticateToken,
  async (req, res) => {
    try {
      const entryId = req.user.calentian_entries_id;
      const [emails] = await dbPool.query(
        `SELECT e.id, e.subject, e.body, e.timestamp, e.sender, e.receiver,
              e.calentian_event_entries_id AS event_id,
              e.status, e.calentian_email_status_id AS email_status_id,
              COALESCE(ev.event_name,'Unbenanntes Event') AS event_name
        FROM calentian_kunden_emails e
        LEFT JOIN calentian_event_entries ev ON e.calentian_event_entries_id = ev.id
       WHERE e.message_ingoing = 1
         AND e.calentian_email_status_id IN (2,3)
         AND e.calentian_entries_id = ?`,
        [entryId]
      );
      res.json(emails || []);
    } catch (err) {
      console.error("❌ Fehler beim Abrufen zuzuordnender E-Mails:", err);
      res.status(500).json({ message: "Fehler beim Abrufen der E-Mails" });
    }
  }
);

// POST manual assignment
app.post(
  "/mail-service/api/emails/assign",
  authenticateToken,
  async (req, res) => {
    const { emailId, eventId, customerId } = req.body;
    try {
      const sets = [
        "calentian_event_entries_id = ?",
        "calentian_email_status_id = 1",
      ];
      const vals = [eventId];
      if (customerId) {
        sets.push("calentian_kundendaten_id = ?");
        vals.push(customerId);
      }
      vals.push(emailId);
      await dbPool.query(
        `UPDATE calentian_kunden_emails SET ${sets.join(", ")} WHERE id = ?`,
        vals
      );
      res.json({ message: "E-Mail erfolgreich zugeordnet" });
    } catch (err) {
      console.error("❌ Fehler beim Zuordnen der E-Mail:", err);
      res.status(500).json({ message: "Fehler beim Zuordnen der E-Mail" });
    }
  }
);

// POST update status
app.post(
  "/mail-service/api/emails/update-status",
  authenticateToken,
  async (req, res) => {
    const { email_id, status } = req.body;
    if (!email_id || status === undefined) {
      return res
        .status(400)
        .json({ message: "Email-ID und Status müssen angegeben werden." });
    }
    if (![1, 2].includes(status)) {
      return res
        .status(400)
        .json({ message: "Ungültiger Status! Erlaubt: 1,2." });
    }
    try {
      const [result] = await dbPool.execute(
        `UPDATE calentian_kunden_emails SET calentian_email_status_id = ? WHERE id = ?`,
        [status, email_id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Email nicht gefunden!" });
      }
      res.json({
        message: "✅ Status aktualisiert",
        affectedRows: result.affectedRows,
      });
    } catch (err) {
      console.error("❌ Fehler beim Aktualisieren des Status:", err);
      res
        .status(500)
        .json({ message: "Fehler beim Aktualisieren des Email-Status" });
    }
  }
);

// 5) Bootstrap: Vault → DB → Server starten
async function bootstrap() {
  try {
    await initVault();
    await initDB();
    const PORT = process.env.PORT || 5300;
    app.listen(PORT, () =>
      console.log(`🚀 Mail-Service läuft auf Port ${PORT}`)
    );
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
}

bootstrap();
