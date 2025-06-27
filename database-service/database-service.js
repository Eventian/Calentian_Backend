const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mysql = require("mysql2");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 4100;

// Sicherheitsheader
app.use(helmet());

// Trust Proxy bei Einsatz von Reverse Proxies
app.set("trust proxy", 1);

// JSON-Parser und Cookie-Parser
app.use(express.json());
app.use(cookieParser());

// CORS-Konfiguration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:4200", "https://dashboard.calentian.de"];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Origin not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));

// OPTIONS-Vorkonfiguration für CORS
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Credentials", "true");
    return res.sendStatus(200);
  }
  next();
});

// Rate Limiting
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMITING_WINDOW_MS || "900000"),
    max: parseInt(process.env.RATE_LIMITING_MAX || "100"),
  })
);

// MySQL-Verbindung
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("Fehler beim Verbinden zur Datenbank: " + err.stack);
    return;
  }
  console.log("Verbunden mit der Datenbank als ID " + connection.threadId);
  connection.release();
});

// Authentifizierungsmiddleware
const authenticateToken = (req, res, next) => {
  const token =
    req.header("Authorization")?.replace("Bearer ", "") ||
    req.cookies?.access_token;

  if (!token) {
    return res.status(403).json({ message: "Token fehlt oder ist ungültig." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Token ungültig." });
    }
    req.user = user;
    next();
  });
};

// Erlaubte Tabellen und optionale Filter
const allowedTables = [
  "calentian_event_entries_veranstaltungsart",
  "calentian_event_entries_status",
  "calentian_entries_location",
  "calentian_event_entries",
  "calentian_entries_forms",
  "calentian_kundendaten",
  "calentian_kunden_emails_addresses",
  "calentian_benutzer",
  "calentian_appointments",
  "calentian_kunden_emails",
  "calentian_holidays",
  "calentian_calendar_settings",
];

const tableFilters = {
  calentian_entries_location: "calentian_entries_id = ?",
  calentian_entries_forms: "calentian_entries_id = ?",
  calentian_benutzer: "calentian_entries_id = ?",
  calentian_appointments: "calentian_entries_id = ?",
  calentian_kundendaten: "calentian_entries_id = ?",
  calentian_kunden_emails: "calentian_entries_id = ?",
  calentian_calendar_settings: "calentian_entries_id = ?",
};

// Datenbankroute für Abruf einer Tabelle
app.get("/database", authenticateToken, (req, res) => {
  const { table, filter, limit, eventId, sort } = req.query;

  if (!table || !allowedTables.includes(table)) {
    return res.status(400).json({ message: "Ungültiger Tabellenname." });
  }

  let query = `SELECT * FROM \`${table}\``; // sicher, da in allowedTables geprüft
  const params = [];
  const whereClauses = [];

  // 1. Filter nach calentian_entries_id (z. B. Location-Owner)
  if (tableFilters[table]) {
    whereClauses.push(tableFilters[table]);
    params.push(req.user.calentian_entries_id);
  }

  // 2. Filter nach eventId
  if (eventId) {
    whereClauses.push("calentian_event_entries_id = ?");
    params.push(eventId);
  }

  // 3. Optionaler zusätzlicher Filter
  if (filter) {
    whereClauses.push(`(${filter})`);
  }

  if (whereClauses.length > 0) {
    query += " WHERE " + whereClauses.join(" AND ");
  }

  // Optionales Sorting
  if (sort) {
    query += ` ORDER BY ${sort}`;
  }

  // Optionales Limit
  if (limit) {
    query += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }

  console.log("SQL-Query:", query);
  console.log("SQL-Params:", params);

  db.query(query, params, (err, results) => {
    if (err) {
      console.error("❌ Fehler beim Abrufen der Daten:", err);
      return res
        .status(500)
        .json({ message: "Fehler beim Abrufen der Daten." });
    }
    res.json(results);
  });
});

// Datenbankroute für den Abruf mehrerer Tabellen
app.post("/database/multi-request", authenticateToken, (req, res) => {
  const { requests } = req.body;

  if (!Array.isArray(requests) || requests.length === 0) {
    return res
      .status(400)
      .json({ message: "Keine gültigen Anfragen angegeben." });
  }

  const results = {};
  let completed = 0;

  requests.forEach((r) => {
    const table = r.table;
    if (!allowedTables.includes(table)) {
      results[table] = { error: "Ungültiger Tabellenname." };
      if (++completed === requests.length) return res.json(results);
      return;
    }

    let query = "SELECT * FROM ??";
    const params = [table];

    let filter = tableFilters[table] || null;
    if (filter) {
      query += " WHERE " + filter;
      params.push(req.user.calentian_entries_id);
    }

    db.query(query, params, (err, rows) => {
      if (err) {
        results[table] = { error: "Fehler beim Abrufen: " + err.message };
      } else {
        results[table] = rows;
      }
      if (++completed === requests.length) {
        res.json(results);
      }
    });
  });
});

// Route zum Abrufen von mehreren Events
app.get("/database/events", authenticateToken, async (req, res) => {
  const locationId = req.user.calentian_entries_id;

  if (!locationId) {
    return res
      .status(400)
      .json({ message: "calentian_entries_id fehlt im Token." });
  }

  const query = `
    SELECT 
      e.*, 
      k.vorname, 
      k.nachname, 
      k.firma, 
      l.location_name, 
      s.label AS event_status_label, 
      s.css_class AS event_status_css,
      va.name AS veranstaltungsart_label,
      e.anzahl_personen_gesamt, 
      e.event_name
    FROM calentian_event_entries e
    JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
    JOIN calentian_entries_location l ON e.location_id = l.id
    LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    WHERE e.calentian_entries_id = ?
  `;

  try {
    const connection = await db.promise(); // Falls du mit `mysql2` arbeitest
    const [results] = await connection.execute(query, [locationId]);
    res.json(results);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Events:", err);
    res.status(500).send("Fehler beim Abrufen der Events");
  }
});

// Route zum Abrufen eines einzelnen Events
app.get("/database/event/:id", authenticateToken, async (req, res) => {
  const eventId = req.params.id;

  const query = `
    SELECT 
      e.*, 
      k.vorname, 
      k.nachname, 
      k.firma, 
      l.location_name, 
      s.label AS event_status_label, 
      s.css_class AS event_status_css, 
      va.name AS veranstaltungsart_label,
      ce.calentian_entries_name,
      ce.calentian_entries_zusatz,
      ce.calentian_entries_zusatz_davor
    FROM calentian_event_entries e
    JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
    JOIN calentian_entries_location l ON e.location_id = l.id
    LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    JOIN calentian_entries ce ON e.calentian_entries_id = ce.id
    WHERE e.id = ? AND e.calentian_entries_id = ?
  `;

  try {
    const [results] = await db
      .promise()
      .execute(query, [eventId, req.user.calentian_entries_id]);

    if (results.length === 0) {
      return res.status(404).json({ message: "Event nicht gefunden" });
    }

    const event = results[0];

    event.customer_emails = event.customer_emails
      ? event.customer_emails.split(",")
      : [];

    res.json(event);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen des Events:", err);
    res.status(500).send("Fehler beim Abrufen des Events");
  }
});

app.get("/database/calendar-data", authenticateToken, async (req, res) => {
  const id = req.user.calentian_entries_id;

  try {
    const connection = await db.promise();

    // Events mit JOINs
    const [events] = await connection.execute(
      `
      SELECT 
        e.*, 
        k.vorname,
        k.nachname, 
        k.firma, 
        va.name AS veranstaltungsart_name,
        va.icon_class AS veranstaltungsart_icon,
        s.css_class AS event_status_css,
        s.label AS event_status_name
      FROM calentian_event_entries e
      LEFT JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
      LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
      LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
      WHERE e.calentian_entries_id = ?
    `,
      [id]
    );

    // Appointments mit JOINs
    const [appointments] = await connection.execute(
      `
      SELECT 
        a.*, 
        k.vorname,
        k.nachname, 
        k.firma
      FROM calentian_appointments a
      LEFT JOIN calentian_kundendaten k ON a.calentian_kundendaten_id = k.id
      WHERE a.calentian_entries_id = ?
    `,
      [id]
    );

    res.json({ events, appointments });
  } catch (err) {
    console.error("❌ Fehler bei /calendar/data:", err);
    res.status(500).json({ message: "Fehler beim Abrufen der Kalenderdaten." });
  }
});

app.listen(port, () => {
  console.log(`✅ Server läuft auf Port ${port}`);
});
