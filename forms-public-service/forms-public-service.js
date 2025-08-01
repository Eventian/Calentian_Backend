const express = require("express");
const cors = require("cors");
require("dotenv").config();
const mysql = require("mysql2/promise");

const app = express();

// 🌍 Öffne CORS für alle Domains (z. B. www.kinderhospizdienst-offenburg.de)
app.use(cors({ origin: true }));

// 📦 JSON-Body aktivieren (nicht zwingend nötig für GET)
app.use(express.json());

// 🧠 Datenbankverbindung
async function initDB() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

// 🐞 Preflight-Handler (OPTIONS-Anfragen von Browsern)
app.options("/forms-public-service/availability-batch", (req, res) => {
  console.log("👉 OPTIONS-Preflight erkannt");
  console.log("🔍 Origin:", req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.sendStatus(204);
});

// 🧪 Verfügbarkeitsabfrage mit vollständiger CORS-Debug-Logik
app.get("/forms-public-service/availability-batch", async (req, res) => {
  console.log("👉 GET-Verfügbarkeitsroute aufgerufen");
  console.log("🔐 Origin:", req.headers.origin);
  console.log("🔐 Authorization:", req.get("Authorization"));

  // 🌍 Manuelles Setzen der CORS-Header
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

  const conn = await initDB();

  try {
    const [[formRow]] = await conn.execute(
      "SELECT calentian_entries_id FROM calentian_entries_forms WHERE id = ?",
      [form_id]
    );
    if (!formRow) {
      return res.status(404).json({ error: "Formular nicht gefunden" });
    }

    const entryId = formRow.calentian_entries_id;
    const startDate = `${year}-${month.padStart(2, "0")}-01`;
    const endDate = new Date(year, month, 0).toISOString().split("T")[0];

    const [eventBlocks] = await conn.execute(
      `SELECT datum, bis_datum FROM calentian_event_entries
       WHERE calentian_entries_id = ?
         AND calentian_event_entries_status_id IN (4, 5, 6, 8)
         AND (
           (datum BETWEEN ? AND ?)
           OR (bis_datum BETWEEN ? AND ?)
           OR (datum <= ? AND bis_datum >= ?)
         )`,
      [entryId, startDate, endDate, startDate, endDate, startDate, endDate]
    );

    const [closureBlocks] = await conn.execute(
      `SELECT start_date, end_date, type FROM calentian_closure_days
       WHERE calentian_entries_id = ?
         AND (
           (type = 'single' AND start_date BETWEEN ? AND ?)
           OR
           (type = 'period' AND (
             (start_date BETWEEN ? AND ?)
             OR (end_date BETWEEN ? AND ?)
             OR (start_date <= ? AND end_date >= ?)
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

    const blockedDates = new Set();
    const blockedReasons = {};

    eventBlocks.forEach((event) => {
      const start = new Date(event.datum);
      const end = new Date(event.bis_datum);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        if (dateStr >= startDate && dateStr <= endDate) {
          blockedDates.add(dateStr);
          blockedReasons[dateStr] = "event";
        }
      }
    });

    closureBlocks.forEach((closure) => {
      const start = new Date(closure.start_date);
      const end =
        closure.type === "single" ? start : new Date(closure.end_date);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        if (dateStr >= startDate && dateStr <= endDate) {
          blockedDates.add(dateStr);
          blockedReasons[dateStr] = "closure";
        }
      }
    });

    return res.json({
      blocked_dates: Array.from(blockedDates).sort(),
      blocked_reasons: blockedReasons,
    });
  } catch (err) {
    console.error("❌ Verfügbarkeitsprüfung fehlgeschlagen:", err);
    return res.status(500).json({ error: "Serverfehler" });
  } finally {
    await conn.end();
  }
});

// 🚀 Server starten
const PORT = process.env.PORT || 6201;
app.listen(PORT, () => {
  console.log(`Forms-Public-Service listening on port ${PORT}`);
});
