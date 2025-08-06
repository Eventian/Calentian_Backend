/***********************************************************************
 * Holiday-Service (Express, MySQL, Vault, Cron)
 *
 * Synchronisiert Feie rtage von date.nager.at in DB,
 * plant Initial- und monatlichen Sync via node-cron,
 * zieht DB-Credentials sicher aus Vault.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import express from "express";
import axios from "axios";
import mysql from "mysql2/promise";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(express.json());

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

// 2) Feiertage synchronisieren
async function syncHolidays(year, country) {
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`;
  const response = await axios.get(url);

  for (const holiday of response.data) {
    const datum = holiday.date;
    const name = holiday.localName;
    const bundeslaender = holiday.counties || [null];
    const ist_offiziell = holiday.types?.includes("Public") ?? true;
    const quelle = "date.nager.at";
    const countryCode = holiday.countryCode;

    for (const bl of bundeslaender) {
      const region = bl?.split("-")[1] ?? null;
      await db.execute(
        `INSERT INTO calentian_holidays (datum, land, bundesland, name, ist_offiziell, quelle)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name         = VALUES(name),
           ist_offiziell= VALUES(ist_offiziell),
           quelle       = VALUES(quelle),
           system_timestamp = CURRENT_TIMESTAMP`,
        [datum, countryCode, region, name, ist_offiziell, quelle]
      );
    }
  }
}

// 3) HTTP-Endpoint zum manuellen Sync
app.post("/internal/holidays/sync", async (req, res) => {
  const { year, country } = req.body;
  if (!year || !country) {
    return res
      .status(400)
      .json({ error: "year und country sind erforderlich" });
  }
  try {
    await syncHolidays(year, country);
    res.json({ message: `Feiertage für ${year}-${country} synchronisiert` });
  } catch (err) {
    console.error("Fehler beim Feiertagssync:", err);
    res.status(500).json({ error: "Fehler beim Abrufen der Feiertage" });
  }
});

// 4) Bootstrap: Vault → DB → Initial-Sync → Cron
async function bootstrap() {
  try {
    // Vault-Login und Secrets laden
    await initVault();

    // DB initialisieren
    await initDB();

    // Initial Sync
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 5;
    const endYear = currentYear + 15;
    const countries = (process.env.SYNC_COUNTRIES || "DE").split(",");

    for (let y = startYear; y <= endYear; y++) {
      for (const c of countries) {
        console.log(`🔁 Initial Sync für ${y}-${c}`);
        try {
          await syncHolidays(y, c);
          console.log(`✅ Sync ${y}-${c} abgeschlossen`);
        } catch (e) {
          console.error(`❌ Fehler bei ${y}-${c}:`, e);
        }
      }
    }

    // Cron-Job: monatlicher Sync am 1. Tag um 00:00
    cron.schedule("0 0 1 * *", async () => {
      console.log("🕛 Monatlicher Feiertagssync gestartet");
      for (let y = startYear; y <= endYear; y++) {
        for (const c of countries) {
          try {
            await syncHolidays(y, c);
          } catch (e) {
            console.error(e);
          }
        }
      }
      console.log("✅ Monatlicher Feiertagssync beendet");
    });

    // HTTP-Server starten
    const PORT = process.env.PORT || 4100;
    app.listen(PORT, () => console.log(`🚀 Holiday-Service auf Port ${PORT}`));
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
}

bootstrap();
