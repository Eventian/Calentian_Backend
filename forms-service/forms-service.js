/***********************************************************************
 * Forms-Service (Express, MySQL, CORS, JWT, Vault)
 *
 * Statische Assets, Formular-Config, Formular-Submission,
 * sichert Secrets über Vault, nutzt ES-Module.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import path from "path";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

// Vault-Settings laden (VAULT_ADDR, ROLE_ID, SECRET_ID, VAULT_SECRETS)
dotenv.config();

const app = express();

// Globals
let db;

// 1) Datenbankverbindung initialisieren
async function initDB() {
  db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  console.log("✅ MySQL verbunden");
}

// 2) Auth-Middleware
function authenticateToken(req, res, next) {
  const token = req.cookies["access_token"];
  if (!token) return res.status(401).json({ message: "Nicht authentifiziert" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Token ungültig" });
    req.user = user;
    next();
  });
}

// 3) Middleware
const corsOptions = {
  origin: ["https://dashboard.calentian.de", "http://localhost:4200"],
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

// 4) Statische Assets
app.use("/forms-service", express.static(path.resolve("./public")));

// 5) Rate Limiter
const submitLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: { message: "Zu viele Anfragen, bitte später erneut versuchen" },
});

// 6) Routen
// GET /form-config/:formId
app.get("/forms-service/form-config/:formId", cors(), async (req, res) => {
  const { formId } = req.params;
  try {
    const [[row]] = await db.execute(
      "SELECT config, styles FROM calentian_entries_forms WHERE id = ?",
      [formId]
    );
    if (!row)
      return res.status(404).json({ message: "Formular nicht gefunden" });
    const config =
      typeof row.config === "string" ? JSON.parse(row.config) : row.config;
    const styles =
      typeof row.styles === "string" ? JSON.parse(row.styles) : row.styles;
    res.json({ ...config, styles });
  } catch (err) {
    console.error("Config-Endpoint-Fehler:", err);
    res.status(500).json({ message: "Server-Fehler" });
  }
});

// POST /form-submit
app.post(
  "/forms-service/form-submit",
  cors(),
  submitLimiter,
  async (req, res) => {
    const { formId, data, recaptcha, calentian_menschlichkeit, ts } = req.body;
    // Honeypot
    if (calentian_menschlichkeit)
      return res.status(400).json({ message: "Spam erkannt" });
    // Zeit-Check
    const elapsed = Date.now() - Number(ts || 0);
    if (isNaN(elapsed) || elapsed < 3000)
      return res
        .status(400)
        .json({ message: "Formular zu schnell ausgefüllt" });

    // Formular-Config laden
    try {
      const [[cfgRow]] = await db.execute(
        "SELECT config FROM calentian_entries_forms WHERE id = ?",
        [formId]
      );
      if (!cfgRow)
        return res.status(404).json({ message: "Formular nicht gefunden" });
      const cfg =
        typeof cfgRow.config === "string"
          ? JSON.parse(cfgRow.config)
          : cfgRow.config;

      // Kundendaten anlegen
      const [custRes] = await db.execute(
        `INSERT INTO calentian_kundendaten
        (vorname,nachname,firma,strasse,plz,stadt,telefonnummer,calentian_entries_id)
       VALUES (?,?,?,?,?,?,?,?)`,
        [
          data.vorname,
          data.nachname,
          data.firma || null,
          data.strasse || null,
          data.plz || null,
          data.stadt || null,
          data.telefonnummer || null,
          cfg.calentian_entries_id,
        ]
      );
      const customerId = custRes.insertId;
      if (data.email) {
        await db.execute(
          "INSERT INTO calentian_kunden_emails_addresses (calentian_kundendaten_id,email,is_primary) VALUES (?,?,1)",
          [customerId, data.email]
        );
      }

      // Event anlegen
      const [evRes] = await db.execute(
        `INSERT INTO calentian_event_entries
         (calentian_kundendaten_id,location_id,datum,calentian_event_entries_veranstaltungsart_id,calentian_event_entries_status_id,calentian_entries_id,anzahl_personen_gesamt,anzahl_kinder,event_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          customerId,
          cfg.locationId,
          data.datum,
          cfg.eventTypeId,
          1,
          cfg.calentian_entries_id,
          data.anzahl_personen_gesamt || 0,
          data.anzahl_kinder || 0,
          `${cfg.name} von ${data.vorname}`,
        ]
      );
      return res.status(201).json({ success: true, eventId: evRes.insertId });
    } catch (err) {
      console.error("Form-Submit-Fehler:", err);
      return res.status(500).json({ message: "Server-Fehler" });
    }
  }
);

// POST /form-config
app.post(
  "/forms-service/form-config",
  cors(corsOptions),
  authenticateToken,
  async (req, res) => {
    const { calentian_entries_id, name, config, styles } = req.body;
    if (!calentian_entries_id || !name || !config || !styles)
      return res.status(400).json({ message: "Fehlende Pflicht-Felder" });
    if (Number(calentian_entries_id) !== req.user.calentian_entries_id)
      return res.status(403).json({ message: "Nicht berechtigt" });
    try {
      const [chk] = await db.execute(
        "SELECT id FROM calentian_entries WHERE id=?",
        [calentian_entries_id]
      );
      if (chk.length === 0)
        return res.status(400).json({ message: "Eintrag existiert nicht" });
      const [ins] = await db.execute(
        "INSERT INTO calentian_entries_forms (calentian_entries_id,name,config,styles) VALUES (?,?,?,?)",
        [
          calentian_entries_id,
          name,
          JSON.stringify(config),
          JSON.stringify(styles),
        ]
      );
      res.status(201).json({ id: ins.insertId });
    } catch (err) {
      console.error("Form-Config-POST-Fehler:", err);
      res.status(500).json({ message: "Server-Fehler", detail: err.message });
    }
  }
);

// PUT /form-config/:formId
app.put(
  "/forms-service/form-config/:formId",
  cors(corsOptions),
  authenticateToken,
  async (req, res) => {
    const { formId } = req.params;
    const { name, config, styles } = req.body;
    try {
      const [upd] = await db.execute(
        "UPDATE calentian_entries_forms SET name=?,config=?,styles=? WHERE id=?",
        [name, JSON.stringify(config), JSON.stringify(styles), formId]
      );
      if (upd.affectedRows === 0)
        return res.status(404).json({ message: "Formular nicht gefunden" });
      res.json({ id: Number(formId) });
    } catch (err) {
      console.error("Form-Config-PUT-Fehler:", err);
      res.status(500).json({ message: "Server-Fehler" });
    }
  }
);

// DELETE /form-config/:formId
app.delete(
  "/forms-service/form-config/:formId",
  cors(corsOptions),
  authenticateToken,
  async (req, res) => {
    const { formId } = req.params;
    try {
      const [del] = await db.execute(
        "DELETE FROM calentian_entries_forms WHERE id=?",
        [formId]
      );
      if (del.affectedRows === 0)
        return res.status(404).json({ message: "Formular nicht gefunden" });
      res.status(204).end();
    } catch (err) {
      console.error("Form-Config-DELETE-Fehler:", err);
      res.status(500).json({ message: "Server-Fehler" });
    }
  }
);

// Bootstrap: Vault → DB → Server
async function bootstrap() {
  try {
    await initVault();
    await initDB();
    const PORT = process.env.PORT || 6200;
    app.listen(PORT, () => console.log(`🚀 Forms-Service auf Port ${PORT}`));
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
}

bootstrap();
