/***********************************************************************
 * Forms-Public-Service (Express, MySQL, CORS, Vault)
 *
 * Bietet eine Verfügbarkeits-Abfrage via /forms-public-service/availability-batch
 * Authentifiziert per Token (EMBED_FORM_TOKEN) und zieht DB-Credentials
 * sowie das Embed-Token sicher aus Vault.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";

// Lade Vault-Settings (VAULT_ADDR, VAULT_ROLE_ID, VAULT_SECRET_ID, VAULT_SECRETS)
dotenv.config();

const app = express();

// Globale DB-Variable
let dbConnection;

// Initialisierung der DB-Verbindung
async function initDB() {
  dbConnection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  console.log("✅ Mit der MySQL-Datenbank verbunden");
}

// CORS- und JSON-Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Preflight für Verfügbarkeits-Route
app.options("/forms-public-service/availability-batch", (req, res) => {
  console.log("👉 OPTIONS-Preflight erkannt", req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(204);
});

// Verfügbarkeits-Route
app.get("/forms-public-service/availability-batch", async (req, res) => {
  console.log("👉 GET /availability-batch aufgerufen", req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  const token = req.get("Authorization")?.replace("Bearer ", "");
  if (token !== process.env.EMBED_FORM_TOKEN) {
    console.warn("❌ Ungültiger Token:", token);
    return res.status(403).json({ error: "Unauthorized" });
  }

  const { form_id, year, month } = req.query;
  if (!form_id || !year || !month) {
    console.warn("❌ Fehlende Parameter:", req.query);
    return res
      .status(400)
      .json({ error: "Fehlende Parameter: form_id, year und month" });
  }

  try {
    // Lade entryId zum Formular
    const [[formRow]] = await dbConnection.execute(
      `SELECT calentian_entries_id FROM calentian_entries_forms WHERE id = ?`,
      [form_id]
    );
    if (!formRow) {
      return res.status(404).json({ error: "Formular nicht gefunden" });
    }

    const entryId = formRow.calentian_entries_id;
    const startDate = `${year}-${month.toString().padStart(2, "0")}-01`;
    const endDate = new Date(year, month, 0).toISOString().split("T")[0];

    // Event-Blöcke
    const [eventBlocks] = await dbConnection.execute(
      `SELECT datum, bis_datum FROM calentian_event_entries
       WHERE calentian_entries_id = ?
         AND calentian_event_entries_status_id IN (4,5,6,8)
         AND (
           (datum BETWEEN ? AND ?) OR
           (bis_datum BETWEEN ? AND ?) OR
           (datum <= ? AND bis_datum >= ?)
         )`,
      [entryId, startDate, endDate, startDate, endDate, startDate, endDate]
    );

    // Schließungs-Blöcke
    const [closureBlocks] = await dbConnection.execute(
      `SELECT start_date, end_date, type FROM calentian_closure_days
       WHERE calentian_entries_id = ?
         AND (
           (type='single' AND start_date BETWEEN ? AND ?) OR
           (type='period' AND (
             (start_date BETWEEN ? AND ?) OR
             (end_date BETWEEN ? AND ?) OR
             (start_date <= ? AND end_date >= ?)
           ))
         )`,
      [
        entryId,
        startDate,
        endDate,
        startDate,
        endDate,
        startDate,
        endDate,
        startDate,
        endDate,
      ]
    );

    // Zusammenführen
    const blockedDates = new Set();
    const blockedReasons = {};

    for (const ev of eventBlocks) {
      const from = new Date(ev.datum);
      const to = new Date(ev.bis_datum);
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const iso = d.toISOString().split("T")[0];
        if (iso >= startDate && iso <= endDate) {
          blockedDates.add(iso);
          blockedReasons[iso] = "event";
        }
      }
    }

    for (const cl of closureBlocks) {
      const from = new Date(cl.start_date);
      const to =
        cl.type === "single" ? new Date(cl.start_date) : new Date(cl.end_date);
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const iso = d.toISOString().split("T")[0];
        if (iso >= startDate && iso <= endDate) {
          blockedDates.add(iso);
          blockedReasons[iso] = "closure";
        }
      }
    }

    res.json({
      blocked_dates: Array.from(blockedDates).sort(),
      blocked_reasons: blockedReasons,
    });
  } catch (err) {
    console.error("❌ Verfügbarkeitsprüfung fehlgeschlagen:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// Bootstrap: Vault → DB → Server starten
async function bootstrap() {
  try {
    // Vault-Login & Secrets laden
    const secrets = await initVault();
    console.log("🔑 Vault-Secrets geladen");

    // DB-Verbindung aufbauen
    await initDB();

    // Server starten
    const PORT = process.env.PORT || 6201;
    app.listen(PORT, () =>
      console.log(`🚀 Forms-Public-Service auf Port ${PORT}`)
    );
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
}

bootstrap();
