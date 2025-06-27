// holiday-service.js
import express from "express";
import axios from "axios";
import mysql from "mysql2/promise";
import cron from "node-cron";

const app = express();
app.use(express.json());

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function syncHolidays(year, land) {
  const response = await axios.get(
    `https://date.nager.at/api/v3/PublicHolidays/${year}/${land}`
  );

  for (const holiday of response.data) {
    const datum = holiday.date;
    const name = holiday.localName;
    const bundeslaender = holiday.counties || [null];
    const ist_offiziell = holiday.types?.includes("Public") ?? true;
    const quelle = "date.nager.at";

    for (const bundesland of bundeslaender) {
      const landCode = holiday.countryCode;
      const region = bundesland?.split("-")[1] ?? null;

      await db.execute(
        `INSERT INTO calentian_holidays (datum, land, bundesland, name, ist_offiziell, quelle)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           ist_offiziell = VALUES(ist_offiziell),
           quelle = VALUES(quelle),
           system_timestamp = CURRENT_TIMESTAMP`,
        [datum, landCode, region, name, ist_offiziell, quelle]
      );
    }
  }
}

app.post("/internal/holidays/sync", async (req, res) => {
  const { year, land } = req.body;

  if (!year || !land) {
    return res.status(400).json({ error: "year and land are required" });
  }

  try {
    await syncHolidays(year, land);
    res.status(200).json({
      message: `Feiertage für ${year}-${land} erfolgreich synchronisiert.`,
    });
  } catch (error) {
    console.error("Fehler beim Feiertagssync:", error);
    res.status(500).json({ error: "Fehler beim Abruf der Feiertage." });
  }
});

const port = process.env.PORT || 4100;
app.listen(port, () => console.log(`Holiday service läuft auf Port ${port}`));

// 🟢 Initialsync beim Start
(async () => {
  const yearStart = new Date().getFullYear() - 5;
  const yearEnd = new Date().getFullYear() + 15;
  const countries = (process.env.SYNC_COUNTRIES || "DE").split(",");

  for (let jahr = yearStart; jahr <= yearEnd; jahr++) {
    for (const land of countries) {
      console.log(`🔁 Starte Sync für ${jahr}-${land}...`);
      try {
        await syncHolidays(jahr, land);
        console.log(`✅ Sync für ${jahr}-${land} abgeschlossen`);
      } catch (err) {
        console.error(`❌ Fehler bei ${jahr}-${land}:`, err);
      }
    }
  }
})();

// 🕛 Monatlicher Sync um 00:00 Uhr am 1. Tag des Monats
cron.schedule("0 0 1 * *", async () => {
  const yearStart = new Date().getFullYear() - 5;
  const yearEnd = new Date().getFullYear() + 15;
  const countries = (process.env.SYNC_COUNTRIES || "DE").split(",");

  for (let jahr = yearStart; jahr <= yearEnd; jahr++) {
    for (const land of countries) {
      console.log(`📅 Monatlicher Sync für ${jahr}-${land} gestartet...`);
      try {
        await syncHolidays(jahr, land);
        console.log(`✅ Monatlicher Sync für ${jahr}-${land} abgeschlossen`);
      } catch (err) {
        console.error(`❌ Fehler beim Sync für ${jahr}-${land}:`, err);
      }
    }
  }
});
