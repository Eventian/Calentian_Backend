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
  "calentian_offer",
  "calentian_event_guest_count",
  "calentian_guest_group_template",
  "calentian_closure_days",
  "calentian_kunden_emails_addresses",
];

const tableFilters = {
  calentian_entries_location: "calentian_entries_id = ?",
  calentian_entries_forms: "calentian_entries_id = ?",
  calentian_benutzer: "calentian_entries_id = ?",
  calentian_appointments: "calentian_entries_id = ?",
  calentian_kundendaten: "calentian_entries_id = ?",
  calentian_kunden_emails: "calentian_entries_id = ?",
  calentian_calendar_settings: "calentian_entries_id = ?",
  calentian_closure_days: "calentian_entries_id = ?",
  calentian_guest_group_template: "calentian_entries_id = ?",
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

  // 1. Filter nach calentian_entries_id (z. B. Location-Owner)
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
app.get("/database/multi-request", authenticateToken, (req, res) => {
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

    // Standard-Filter für bestimmte Tabellen
    let filter = tableFilters[table] || null;
    if (filter) {
      query += " WHERE " + filter;
      params.push(req.user.calentian_entries_id);
    }

    // Zusätzliche WHERE-Bedingungen aus dem Request
    if (r.where) {
      const whereClause = buildWhereClause(r.where);
      if (whereClause) {
        query += filter ? " AND " + whereClause : " WHERE " + whereClause;
        // Parameter für WHERE-Bedingungen hinzufügen
      }
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

    // Standard-Filter für bestimmte Tabellen
    let filter = tableFilters[table] || null;
    if (filter) {
      query += " WHERE " + filter;
      params.push(req.user.calentian_entries_id);
    }

    // Zusätzliche WHERE-Bedingungen aus dem Request
    if (r.where) {
      const whereClause = buildWhereClause(r.where);
      if (whereClause) {
        query += filter ? " AND " + whereClause : " WHERE " + whereClause;
        // Parameter für WHERE-Bedingungen hinzufügen
      }
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

// Helper-Funktion für WHERE-Bedingungen
function buildWhereClause(where) {
  // Implementierung für _like, _in, _eq, etc.
}

// Neuer Endpunkt für gefilterte Feiertage
app.post("/database/holidays", authenticateToken, (req, res) => {
  const { year, month, laender, bundeslaender } = req.body;

  if (!year || !month) {
    return res.status(400).json({ message: "Jahr und Monat erforderlich." });
  }

  let query = `
    SELECT * FROM calentian_holidays 
    WHERE datum LIKE ? 
    AND land IN (?)
  `;

  const params = [`${year}-${month}-%`, laender];

  // Bundesländer-Filter hinzufügen
  if (bundeslaender && bundeslaender.length > 0) {
    query += ` AND (bundesland IN (?) OR bundesland IS NULL)`;
    params.push(bundeslaender);
  }

  db.query(query, params, (err, rows) => {
    if (err) {
      console.error("Fehler bei Feiertage-Abfrage:", err);
      return res
        .status(500)
        .json({ error: "Fehler beim Abrufen der Feiertage." });
    }

    console.log(
      `Gefilterte Feiertage: ${rows.length} Einträge für ${year}-${month}`
    );
    res.json({ holidays: rows });
  });
});

// Route zum Abrufen von mehreren Events - ANGEPASST für neue Struktur
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
      va.icon_class AS veranstaltungsart_icon,
      e.event_name,
      COALESCE(SUM(egc.guest_count), 0) AS anzahl_personen_gesamt,
      JSON_ARRAYAGG(
        JSON_OBJECT(
          'guest_group_title', ggt.title,
          'guest_count', egc.guest_count,
          'min_age', ggt.min_age,
          'max_age', ggt.max_age,
          'sort_order', ggt.sort_order
        )
        ORDER BY ggt.sort_order ASC
      ) AS guest_groups
    FROM calentian_event_entries e
    JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
    JOIN calentian_entries_location l ON e.location_id = l.id
    LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    LEFT JOIN calentian_event_guest_count egc ON e.id = egc.calentian_event_entries_id
    LEFT JOIN calentian_guest_group_template ggt ON egc.guest_group_template_id = ggt.id
    WHERE e.calentian_entries_id = ?
    GROUP BY e.id, e.calentian_kundendaten_id, e.calentian_entries_id, e.location_id, e.datum, e.bis_datum, e.start_time, e.calentian_event_entries_veranstaltungsart_id, e.calentian_event_entries_status_id, e.event_name, k.vorname, k.nachname, k.firma, l.location_name, s.label, s.css_class, va.name, va.icon_class
  `;

  try {
    const connection = await db.promise();
    const [results] = await connection.execute(query, [locationId]);
    res.json(results);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Events:", err);
    res.status(500).send("Fehler beim Abrufen der Events");
  }
});

// Route zum Abrufen eines einzelnen Events - ANGEPASST für neue Struktur
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
      ce.calentian_entries_zusatz_davor,
      COALESCE(SUM(egc.guest_count), 0) AS anzahl_personen_gesamt,
      JSON_ARRAYAGG(
        JSON_OBJECT(
          'guest_group_title', ggt.title,
          'guest_count', egc.guest_count,
          'min_age', ggt.min_age,
          'max_age', ggt.max_age,
          'sort_order', ggt.sort_order
        )
          ORDER BY ggt.sort_order ASC
      ) AS guest_groups
    FROM calentian_event_entries e
    JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
    JOIN calentian_entries_location l ON e.location_id = l.id
    LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    JOIN calentian_entries ce ON e.calentian_entries_id = ce.id
    LEFT JOIN calentian_event_guest_count egc ON e.id = egc.calentian_event_entries_id
    LEFT JOIN calentian_guest_group_template ggt ON egc.guest_group_template_id = ggt.id
    WHERE e.id = ? AND e.calentian_entries_id = ?
    GROUP BY e.id, e.calentian_kundendaten_id, e.calentian_entries_id, e.location_id, e.datum, e.bis_datum, e.start_time, e.calentian_event_entries_veranstaltungsart_id, e.calentian_event_entries_status_id, e.event_name, k.vorname, k.nachname, k.firma, l.location_name, s.label, s.css_class, va.name, ce.calentian_entries_name, ce.calentian_entries_zusatz, ce.calentian_entries_zusatz_davor
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

// 🔒 API-Route: Neues Event anlegen – GEÄNDERT (async/await, initDB)
app.post("/database/events/new-event", authenticateToken, async (req, res) => {
  const {
    calentian_kunden_id,
    location_id,
    datum,
    bis_datum,
    start_time,
    calentian_event_entries_veranstaltungsart_id,
    calentian_event_entries_status_id,
    event_name,
    calentian_event_guest_count,
  } = req.body;

  // Pflichtfelder prüfen
  if (
    !calentian_kunden_id ||
    !location_id ||
    !datum ||
    !calentian_event_entries_veranstaltungsart_id ||
    !calentian_event_entries_status_id
  ) {
    return res.status(400).json({ message: "Pflichtfelder fehlen!" });
  }

  const connection = await db.promise();

  try {
    const calentian_entries_id = req.user.calentian_entries_id;

    // Veranstaltungsart-Name holen
    const [vaRows] = await connection.execute(
      `SELECT name FROM calentian_event_entries_veranstaltungsart WHERE id = ?`,
      [calentian_event_entries_veranstaltungsart_id]
    );
    const artName = vaRows.length > 0 ? vaRows[0].name : "";

    // Kundenname holen
    const [customerRows] = await connection.execute(
      `SELECT vorname, firma FROM calentian_kundendaten WHERE id = ?`,
      [calentian_kunden_id]
    );
    let kundeName = "";
    if (customerRows.length > 0) {
      kundeName =
        customerRows[0].firma?.trim() !== ""
          ? customerRows[0].firma
          : customerRows[0].vorname;
    }

    // Fallback für Eventname
    const finalEventName =
      event_name?.trim() !== "" ? event_name : `${artName} von ${kundeName}`;

    // Haupt-Event einfügen
    const [eventResult] = await connection.execute(
      `
      INSERT INTO calentian_event_entries (
        calentian_kundendaten_id,
        calentian_entries_id,
        location_id,
        datum,
        bis_datum,
        start_time,
        calentian_event_entries_veranstaltungsart_id,
        calentian_event_entries_status_id,
        event_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        calentian_kunden_id,
        calentian_entries_id,
        location_id,
        datum,
        bis_datum || null,
        start_time || null,
        calentian_event_entries_veranstaltungsart_id,
        calentian_event_entries_status_id,
        finalEventName,
      ]
    );

    const eventId = eventResult.insertId;

    // Gästegruppen (optional)
    if (Array.isArray(calentian_event_guest_count)) {
      for (const group of calentian_event_guest_count) {
        await connection.execute(
          `
          INSERT INTO calentian_event_guest_count (
            calentian_event_entries_id,
            guest_group_template_id,
            guest_count
          ) VALUES (?, ?, ?)
        `,
          [eventId, group.id, group.guest_count || 0]
        );
      }
    }

    await connection.end();
    res.status(201).json({
      message: "✅ Event erfolgreich erstellt",
      eventId,
    });
  } catch (err) {
    console.error("❌ Fehler beim Event erstellen:", err);
    await connection.end();
    res.status(500).json({ message: "Fehler beim Erstellen des Events" });
  }
});

app.get("/database/calendar-data", authenticateToken, async (req, res) => {
  const id = req.user.calentian_entries_id;

  try {
    const connection = await db.promise();

    // Events mit JOINs - ANGEPASST für neue Struktur
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
        s.label AS event_status_name,
        COALESCE(SUM(egc.guest_count), 0) AS anzahl_personen_gesamt,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'guest_group_title', ggt.title,
            'guest_count', egc.guest_count,
            'min_age', ggt.min_age,
            'max_age', ggt.max_age,
            'sort_order', ggt.sort_order
          )
            ORDER BY ggt.sort_order ASC
        ) AS guest_groups
      FROM calentian_event_entries e
      LEFT JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
      LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
      LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
      LEFT JOIN calentian_event_guest_count egc ON e.id = egc.calentian_event_entries_id
      LEFT JOIN calentian_guest_group_template ggt ON egc.guest_group_template_id = ggt.id
      WHERE e.calentian_entries_id = ?
      GROUP BY e.id, e.calentian_kundendaten_id, e.calentian_entries_id, e.location_id, e.datum, e.bis_datum, e.start_time, e.calentian_event_entries_veranstaltungsart_id, e.calentian_event_entries_status_id, e.event_name, k.vorname, k.nachname, k.firma, va.name, va.icon_class, s.css_class, s.label
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

// Kalender Einstellungen speichern
app.post("/database/calendar-settings", authenticateToken, async (req, res) => {
  const calentian_entries_id = req.user.calentian_entries_id;
  const calentian_benutzer_id = req.user.calentian_benutzer_id;

  // Validierung der Benutzer-Daten - KEINE Fallback-Werte!
  if (!calentian_entries_id || !calentian_benutzer_id) {
    console.error("❌ Fehlende Benutzer-Daten aus JWT Token:", {
      calentian_entries_id,
      calentian_benutzer_id,
      user: req.user,
    });
    return res.status(401).json({
      message: "Ungültige Authentifizierung. Bitte erneut anmelden.",
    });
  }

  // Sammle nur die gesendeten Felder
  const updateData = {};
  const {
    feiertage_anzeigen,
    laender,
    bundeslaender,
    default_view_mode,
    default_hidden_status_ids,
    opening_days,
    closing_days,
  } = req.body;

  // Füge nur definierte Felder hinzu
  if (feiertage_anzeigen !== undefined)
    updateData.feiertage_anzeigen = feiertage_anzeigen;
  if (laender !== undefined) updateData.laender = JSON.stringify(laender);
  if (bundeslaender !== undefined)
    updateData.bundeslaender = JSON.stringify(bundeslaender);
  if (default_view_mode !== undefined)
    updateData.default_view_mode = default_view_mode;
  if (default_hidden_status_ids !== undefined)
    updateData.default_hidden_status_ids = JSON.stringify(
      default_hidden_status_ids
    );
  if (opening_days !== undefined)
    updateData.opening_days = JSON.stringify(opening_days);

  // Prüfe ob überhaupt Daten zum Update vorhanden sind
  if (Object.keys(updateData).length === 0 && !closing_days) {
    return res.status(400).json({
      message: "Keine Daten zum Aktualisieren angegeben.",
    });
  }

  // Debug-Ausgabe
  console.log("📥 Partielle Kalendereinstellungen Update:");
  console.log({
    calentian_entries_id,
    calentian_benutzer_id,
    updateData,
    closing_days: closing_days ? `${closing_days.length} Einträge` : "keine",
  });

  try {
    const connection = await db.promise();

    // Prüfen, ob bereits ein Eintrag existiert
    const [existing] = await connection.execute(
      `SELECT id FROM calentian_calendar_settings WHERE calentian_entries_id = ? AND calentian_benutzer_id = ?`,
      [calentian_entries_id, calentian_benutzer_id]
    );

    if (existing.length > 0) {
      // Update bestehenden Eintrag - nur gesendete Felder
      if (Object.keys(updateData).length > 0) {
        console.log("�� Update bestehender Eintrag:", Object.keys(updateData));

        const setClauses = Object.keys(updateData)
          .map((key) => `${key} = ?`)
          .join(", ");
        const values = Object.values(updateData);
        values.push(calentian_entries_id, calentian_benutzer_id);

        await connection.execute(
          `UPDATE calentian_calendar_settings 
           SET ${setClauses}
           WHERE calentian_entries_id = ? AND calentian_benutzer_id = ?`,
          values
        );
      }
    } else {
      // Neuen Eintrag erstellen - mit Standardwerten für fehlende Felder
      console.log("➕ Neuer Eintrag wird erstellt");

      const insertData = {
        calentian_entries_id,
        calentian_benutzer_id,
        feiertage_anzeigen: updateData.feiertage_anzeigen ?? true,
        laender: updateData.laender ?? JSON.stringify(["DE"]),
        bundeslaender: updateData.bundeslaender ?? JSON.stringify(["BW", "BY"]),
        default_view_mode: updateData.default_view_mode ?? 2,
        default_hidden_status_ids:
          updateData.default_hidden_status_ids ?? JSON.stringify([]),
        opening_days:
          updateData.opening_days ?? JSON.stringify([1, 2, 3, 4, 5]),
      };

      await connection.execute(
        `INSERT INTO calentian_calendar_settings 
         (calentian_entries_id, calentian_benutzer_id, feiertage_anzeigen, laender, bundeslaender, default_view_mode, default_hidden_status_ids, opening_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        Object.values(insertData)
      );
    }

    // Schließtage verarbeiten (falls vorhanden)
    if (closing_days && Array.isArray(closing_days)) {
      console.log(
        "🗓️ Verarbeite Schließtage:",
        closing_days.length,
        "Einträge"
      );

      // Erst alle bestehenden Schließtage für diesen Eintrag löschen
      await connection.execute(
        `DELETE FROM calentian_closure_days WHERE calentian_entries_id = ?`,
        [calentian_entries_id]
      );

      // Neue Schließtage einfügen
      for (const closingDay of closing_days) {
        const { type, start_date, end_date, description } = closingDay;

        // Validierung für jeden Schließtag
        if (!type || !start_date || !description) {
          console.error("❌ Ungültiger Schließtag:", closingDay);
          continue;
        }

        if (type === "period" && !end_date) {
          console.error("❌ Zeitraum ohne Enddatum:", closingDay);
          continue;
        }

        if (type === "single" && end_date) {
          console.error("❌ Einzeltag mit Enddatum:", closingDay);
          continue;
        }

        // Datum-Validierung
        const startDate = new Date(start_date);
        if (isNaN(startDate.getTime())) {
          console.error("❌ Ungültiges Startdatum:", start_date);
          continue;
        }

        if (end_date) {
          const endDate = new Date(end_date);
          if (isNaN(endDate.getTime())) {
            console.error("❌ Ungültiges Enddatum:", end_date);
            continue;
          }
          if (endDate < startDate) {
            console.error("❌ Enddatum vor Startdatum:", closingDay);
            continue;
          }
        }

        // Schließtag in Datenbank einfügen
        await connection.execute(
          `INSERT INTO calentian_closure_days 
           (calentian_entries_id, type, start_date, end_date, description, created_by) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            calentian_entries_id,
            type,
            start_date,
            end_date || null,
            description,
            calentian_benutzer_id,
          ]
        );
      }

      console.log("✅ Schließtage erfolgreich verarbeitet");
    }

    console.log("✅ Kalendereinstellungen erfolgreich gespeichert");
    res.status(200).json({
      success: true,
      message: "Kalendereinstellungen erfolgreich gespeichert.",
    });
  } catch (err) {
    console.error("❌ Fehler beim Speichern der Kalendereinstellungen:", err);
    res.status(500).json({
      success: false,
      message:
        "Fehler beim Speichern der Einstellungen. Bitte versuchen Sie es erneut.",
    });
  }
});

app.listen(port, () => {
  console.log(`✅ Server läuft auf Port ${port}`);
});
