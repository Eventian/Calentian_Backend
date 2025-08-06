// database-service.js (Vault-kompatibel)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mysql from "mysql2/promise";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import initVault from "./vault-init.js"; // Vault-Init importieren
import dotenv from "dotenv";

const vaultReady = await initVault(); // Vault Secrets laden
if (!vaultReady) {
  console.error("❌ Vault konnte nicht initialisiert werden.");
  process.exit(1);
}
dotenv.config(); // .env danach laden (als Fallback)

const app = express();
const port = process.env.PORT || 4100;

app.use(helmet());
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

// 🌍 CORS-Konfiguration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:4200", "https://dashboard.calentian.de"];

// 🔐 Authentifizierungsmiddleware für geschützte Routen
const authenticateToken = (req, res, next) => {
  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
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

app.use(
  cors({
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
  })
);

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

// 🚨 Rate Limiting
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMITING_WINDOW_MS || "900000"),
    max: parseInt(process.env.RATE_LIMITING_MAX || "100"),
  })
);

// 🧠 MySQL-Verbindung (Promise-basiert)
const db = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

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

function buildWhereClause(where) {
  const mapping = {
    benutzer_id: "calentian_benutzer_id",
    eintrag_id: "calentian_entries_id",
  };

  const clauses = [];
  const values = [];

  for (const key in where) {
    const column = mapping[key] || key;
    const condition = where[key];

    if (typeof condition === "object" && condition !== null) {
      for (const op in condition) {
        const val = condition[op];

        switch (op) {
          case "_eq":
            clauses.push(`${column} = ?`);
            values.push(val);
            break;
          case "_like":
            clauses.push(`${column} LIKE ?`);
            values.push(val);
            break;
          case "_in":
            if (Array.isArray(val) && val.length > 0) {
              const placeholders = val.map(() => "?").join(", ");
              clauses.push(`${column} IN (${placeholders})`);
              values.push(...val);
            }
            break;
          // Weitere Operatoren wie _lt, _gt, _is_null etc. möglich
          default:
            console.warn(`⚠️ Unbekannter Operator: ${op}`);
        }
      }
    } else {
      // fallback: einfaches =
      clauses.push(`${column} = ?`);
      values.push(condition);
    }
  }

  return {
    clause: clauses.join(" AND "),
    values,
  };
}

function parseSimpleFilter(str) {
  const [column, operator, value] = str.split(":");

  if (!column || !operator || typeof value === "undefined") return null;

  const columnSafe = column.replace(/[^a-zA-Z0-9_]/g, ""); // Nur gültige Spaltennamen

  let clause = "";
  let val = value;

  switch (operator) {
    case "eq":
      clause = `\`${columnSafe}\` = ?`;
      break;
    case "neq":
      clause = `\`${columnSafe}\` != ?`;
      break;
    case "lt":
      clause = `\`${columnSafe}\` < ?`;
      break;
    case "lte":
      clause = `\`${columnSafe}\` <= ?`;
      break;
    case "gt":
      clause = `\`${columnSafe}\` > ?`;
      break;
    case "gte":
      clause = `\`${columnSafe}\` >= ?`;
      break;
    case "like":
      clause = `\`${columnSafe}\` LIKE ?`;
      break;
    case "in":
      const list = value.split(",").map((v) => v.trim());
      if (list.length === 0) return null;
      clause = `\`${columnSafe}\` IN (${list.map(() => "?").join(", ")})`;
      val = list;
      break;
    default:
      return null;
  }

  return {
    clause,
    values: Array.isArray(val) ? val : [val],
  };
}

// Datenbankroute für Abruf einer Tabelle
app.get("/database", authenticateToken, async (req, res) => {
  const { table, filter, limit, eventId, sort } = req.query;
  if (!table || !allowedTables.includes(table)) {
    return res.status(400).json({ message: "Ungültiger Tabellenname." });
  }

  let query = `SELECT * FROM \`${table}\``;
  const params = [];
  const where = [];

  if (tableFilters[table]) {
    where.push(tableFilters[table]);
    params.push(req.user.calentian_entries_id);
  }
  if (eventId) {
    where.push("calentian_event_entries_id = ?");
    params.push(eventId);
  }
  if (filter) {
    const parsed = parseSimpleFilter(filter);
    if (!parsed)
      return res.status(400).json({ message: "Ungültiger Filterausdruck." });
    where.push(parsed.clause);
    params.push(...parsed.values);
  }
  if (where.length) query += " WHERE " + where.join(" AND ");
  if (sort) query += ` ORDER BY ${sort}`;
  if (limit) {
    query += " LIMIT ?";
    params.push(parseInt(limit, 10));
  }

  console.log("📤 SQL:", query, params);
  try {
    const [rows] = await db.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error("❌ DB-Fehler:", err);
    return res.status(500).json({ message: "Fehler beim Abrufen der Daten." });
  }
});

// Datenbankroute für den Abruf mehrerer Tabellen
app.get("/database/multi-request", authenticateToken, async (req, res) => {
  const { requests } = req.body;
  if (!Array.isArray(requests) || requests.length === 0) {
    return res
      .status(400)
      .json({ message: "Keine gültigen Anfragen angegeben." });
  }

  const results = {};

  await Promise.all(
    requests.map(async (r) => {
      const table = r.table;
      if (!allowedTables.includes(table)) {
        results[table] = { error: "Ungültiger Tabellenname." };
        return;
      }

      // Basis-Query
      let sql = "SELECT * FROM ??";
      const params = [table];

      // Standard-Filter
      const filter = tableFilters[table];
      if (filter) {
        sql += " WHERE " + filter;
        params.push(req.user.calentian_entries_id);
      }

      // zusätzliche WHERE-Bedingungen
      if (r.where) {
        const { clause, values } = buildWhereClause(r.where);
        if (clause) {
          sql += filter ? " AND " + clause : " WHERE " + clause;
          params.push(...values);
        }
      }

      try {
        const [rows] = await db.query(sql, params);
        results[table] = rows;
      } catch (err) {
        results[table] = { error: "Fehler beim Abrufen: " + err.message };
      }
    })
  );

  res.json(results);
});

app.post("/database/multi-request", authenticateToken, async (req, res) => {
  const { requests } = req.body;

  console.log("🔐 Authentifizierter Benutzer:", req.user);
  console.log("📥 Eingehende Multi-Request:", requests);

  if (!Array.isArray(requests) || requests.length === 0) {
    return res
      .status(400)
      .json({ message: "Keine gültigen Anfragen angegeben." });
  }

  const results = {};

  await Promise.all(
    requests.map(async (r) => {
      const table = r.table;
      if (!allowedTables.includes(table)) {
        console.warn(`⚠️ Ungültiger Tabellenname: ${table}`);
        results[table] = { error: "Ungültiger Tabellenname." };
        return;
      }

      // Basis-Query
      let sql = "SELECT * FROM ??";
      const params = [table];

      // Standard-Filter
      const filter = tableFilters[table];
      if (filter) {
        sql += " WHERE " + filter;
        params.push(req.user.calentian_entries_id);
      }

      // Zusätzliche WHERE-Bedingungen
      if (r.where) {
        const { clause, values } = buildWhereClause(r.where);
        if (clause) {
          sql += filter ? " AND " + clause : " WHERE " + clause;
          params.push(...values);
        }
      }

      console.log(`📤 SQL-Query für Tabelle '${table}':`, sql);
      console.log("📤 SQL-Parameter:", params);

      try {
        const [rows] = await db.query(sql, params);
        console.log(`✅ Ergebnisse für Tabelle '${table}':`, rows.length);
        results[table] = rows;
      } catch (err) {
        console.error(`❌ Fehler beim Abrufen von '${table}':`, err.message);
        results[table] = { error: "Fehler beim Abrufen: " + err.message };
      }
    })
  );

  console.log("✅ Alle Multi-Requests abgeschlossen");
  res.json(results);
});

// Neuer Endpunkt für gefilterte Feiertage
app.post("/database/holidays", authenticateToken, async (req, res) => {
  const { year, month, laender, bundeslaender } = req.body;

  if (!year || !month) {
    return res.status(400).json({ message: "Jahr und Monat erforderlich." });
  }

  // Basis-Query
  let sql = `
    SELECT * 
    FROM calentian_holidays
    WHERE datum LIKE ?
      AND land IN (?)
  `;
  const params = [`${year}-${month}-%`, laender];

  // Bundesländer-Filter ergänzen
  if (Array.isArray(bundeslaender) && bundeslaender.length > 0) {
    sql += ` AND (bundesland IN (?) OR bundesland IS NULL)`;
    params.push(bundeslaender);
  }

  try {
    const [rows] = await db.query(sql, params);
    console.log(
      `Gefilterte Feiertage: ${rows.length} Einträge für ${year}-${month}`
    );
    return res.json({ holidays: rows });
  } catch (err) {
    console.error("❌ Fehler bei Feiertage-Abfrage:", err);
    return res
      .status(500)
      .json({ error: "Fehler beim Abrufen der Feiertage." });
  }
});

// Route zum Abrufen von mehreren Events - ANGEPASST für neue Struktur
app.get("/database/events", authenticateToken, async (req, res) => {
  const locationId = req.user.calentian_entries_id;
  if (!locationId) {
    return res
      .status(400)
      .json({ message: "calentian_entries_id fehlt im Token." });
  }

  const sql = `
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
        ) ORDER BY ggt.sort_order
      ) AS guest_groups
    FROM calentian_event_entries e
    JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
    JOIN calentian_entries_location l ON e.location_id = l.id
    LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    LEFT JOIN calentian_event_guest_count egc ON e.id = egc.calentian_event_entries_id
    LEFT JOIN calentian_guest_group_template ggt ON egc.guest_group_template_id = ggt.id
    WHERE e.calentian_entries_id = ?
    GROUP BY 
      e.id, k.vorname, k.nachname, k.firma, l.location_name, 
      s.label, s.css_class, va.name, va.icon_class, e.event_name
  `;

  console.log("📤 SQL-Query /database/events:", sql, [locationId]);
  try {
    const [rows] = await db.query(sql, [locationId]);
    console.log(`✅ Gefundene Events: ${rows.length}`);
    res.json(rows);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Events:", err);
    res.status(500).json({ message: "Fehler beim Abrufen der Events." });
  }
});

// Route zum Abrufen eines einzelnen Events - ANGEPASST für neue Struktur
app.get("/database/event/:id", authenticateToken, async (req, res) => {
  const eventId = req.params.id;

  const sql = `
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
        ) ORDER BY ggt.sort_order
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
    GROUP BY 
      e.id, e.calentian_kundendaten_id, e.calentian_entries_id, e.location_id,
      e.datum, e.bis_datum, e.start_time, e.calentian_event_entries_veranstaltungsart_id,
      e.calentian_event_entries_status_id, e.event_name, k.vorname, k.nachname, k.firma,
      l.location_name, s.label, s.css_class, va.name,
      ce.calentian_entries_name, ce.calentian_entries_zusatz, ce.calentian_entries_zusatz_davor
  `;

  console.log("📤 SQL-Query /database/event/:id:", sql, [
    eventId,
    req.user.calentian_entries_id,
  ]);
  try {
    const [rows] = await db.query(sql, [
      eventId,
      req.user.calentian_entries_id,
    ]);

    if (rows.length === 0) {
      console.log(`⚠️ Event ${eventId} nicht gefunden`);
      return res.status(404).json({ message: "Event nicht gefunden" });
    }

    const event = rows[0];
    event.customer_emails = event.customer_emails
      ? event.customer_emails.split(",")
      : [];

    console.log(`✅ Event ${eventId} geladen`);
    res.json(event);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen des Events:", err);
    res.status(500).json({ message: "Fehler beim Abrufen des Events." });
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

  try {
    const entriesId = req.user.calentian_entries_id;

    // Veranstaltungsart-Name holen
    const [[{ name: artName = "" }]] = await db.query(
      `SELECT name FROM calentian_event_entries_veranstaltungsart WHERE id = ?`,
      [calentian_event_entries_veranstaltungsart_id]
    );

    // Kundenname holen
    const [[customer]] = await db.query(
      `SELECT vorname, firma FROM calentian_kundendaten WHERE id = ?`,
      [calentian_kunden_id]
    );
    const kundeName = customer
      ? customer.firma?.trim() || customer.vorname
      : "";

    // Fallback für Eventname
    const finalEventName = event_name?.trim() || `${artName} von ${kundeName}`;

    // Haupt-Event einfügen
    const [{ insertId: eventId }] = await db.query(
      `INSERT INTO calentian_event_entries (
         calentian_kundendaten_id,
         calentian_entries_id,
         location_id,
         datum,
         bis_datum,
         start_time,
         calentian_event_entries_veranstaltungsart_id,
         calentian_event_entries_status_id,
         event_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        calentian_kunden_id,
        entriesId,
        location_id,
        datum,
        bis_datum || null,
        start_time || null,
        calentian_event_entries_veranstaltungsart_id,
        calentian_event_entries_status_id,
        finalEventName,
      ]
    );

    // Gästegruppen (optional)
    if (Array.isArray(calentian_event_guest_count)) {
      await Promise.all(
        calentian_event_guest_count.map((group) =>
          db.query(
            `INSERT INTO calentian_event_guest_count (
               calentian_event_entries_id,
               guest_group_template_id,
               guest_count
             ) VALUES (?, ?, ?)`,
            [eventId, group.id, group.guest_count || 0]
          )
        )
      );
    }

    res.status(201).json({
      message: "✅ Event erfolgreich erstellt",
      eventId,
    });
  } catch (err) {
    console.error("❌ Fehler beim Event erstellen:", err);
    res.status(500).json({ message: "Fehler beim Erstellen des Events" });
  }
});

app.get("/database/calendar-data", authenticateToken, async (req, res) => {
  const entriesId = req.user.calentian_entries_id;

  if (!entriesId) {
    return res
      .status(400)
      .json({ message: "calentian_entries_id fehlt im Token." });
  }

  // Queries vorbereiten
  const sqlEvents = `
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
        ) ORDER BY ggt.sort_order
      ) AS guest_groups
    FROM calentian_event_entries e
    LEFT JOIN calentian_kundendaten k ON e.calentian_kundendaten_id = k.id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    LEFT JOIN calentian_event_entries_status s ON e.calentian_event_entries_status_id = s.id
    LEFT JOIN calentian_event_guest_count egc ON e.id = egc.calentian_event_entries_id
    LEFT JOIN calentian_guest_group_template ggt ON egc.guest_group_template_id = ggt.id
    WHERE e.calentian_entries_id = ?
    GROUP BY 
      e.id, e.calentian_kundendaten_id, e.calentian_entries_id, e.location_id,
      e.datum, e.bis_datum, e.start_time, e.calentian_event_entries_veranstaltungsart_id,
      e.calentian_event_entries_status_id, e.event_name,
      k.vorname, k.nachname, k.firma, va.name, va.icon_class, s.css_class, s.label
  `;
  const sqlAppointments = `
    SELECT 
      a.*, 
      k.vorname,
      k.nachname, 
      k.firma
    FROM calentian_appointments a
    LEFT JOIN calentian_kundendaten k ON a.calentian_kundendaten_id = k.id
    WHERE a.calentian_entries_id = ?
  `;

  console.log("📤 SQL-Query /calendar-data Events:", sqlEvents, [entriesId]);
  console.log("📤 SQL-Query /calendar-data Appointments:", sqlAppointments, [
    entriesId,
  ]);

  try {
    // Beide Queries parallel ausführen
    const [[events], [appointments]] = await Promise.all([
      db.query(sqlEvents, [entriesId]),
      db.query(sqlAppointments, [entriesId]),
    ]);

    console.log(
      `✅ Gefundene Events: ${events.length}, Appointments: ${appointments.length}`
    );
    res.json({ events, appointments });
  } catch (err) {
    console.error("❌ Fehler bei /calendar-data:", err);
    res.status(500).json({ message: "Fehler beim Abrufen der Kalenderdaten." });
  }
});

// Kalender Einstellungen speichern
app.post("/database/calendar-settings", authenticateToken, async (req, res) => {
  const entriesId = req.user.calentian_entries_id;
  const benutzerId = req.user.calentian_benutzer_id;

  if (!entriesId || !benutzerId) {
    console.error("❌ Fehlende JWT-Daten:", {
      entriesId,
      benutzerId,
      user: req.user,
    });
    return res
      .status(401)
      .json({ message: "Ungültige Authentifizierung. Bitte erneut anmelden." });
  }

  // Nur gesendete Felder sammeln
  const {
    feiertage_anzeigen,
    laender,
    bundeslaender,
    default_view_mode,
    default_hidden_status_ids,
    opening_days,
    closing_days,
  } = req.body;
  const updateData = {};
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

  if (Object.keys(updateData).length === 0 && !Array.isArray(closing_days)) {
    return res
      .status(400)
      .json({ message: "Keine Daten zum Aktualisieren angegeben." });
  }

  console.log("📥 Kalendereinstellungen Update:", {
    entriesId,
    benutzerId,
    updateData,
    closing_days: Array.isArray(closing_days) ? closing_days.length : 0,
  });

  try {
    // Existenz prüfen
    const [existingRows] = await db.query(
      `SELECT id FROM calentian_calendar_settings WHERE calentian_entries_id = ? AND calentian_benutzer_id = ?`,
      [entriesId, benutzerId]
    );

    if (existingRows.length > 0) {
      // Update
      if (Object.keys(updateData).length) {
        const sets = Object.keys(updateData)
          .map((key) => `${key} = ?`)
          .join(", ");
        const values = [...Object.values(updateData), entriesId, benutzerId];
        console.log("🔄 Aktualisiere Kalender-Einstellungen:", sets);
        await db.query(
          `UPDATE calentian_calendar_settings SET ${sets} WHERE calentian_entries_id = ? AND calentian_benutzer_id = ?`,
          values
        );
      }
    } else {
      // Insert mit Defaults
      console.log("➕ Erstelle neuen Kalender-Eintrag");
      const data = {
        feiertage_anzeigen: updateData.feiertage_anzeigen ?? true,
        laender: updateData.laender ?? JSON.stringify(["DE"]),
        bundeslaender: updateData.bundeslaender ?? JSON.stringify(["BW", "BY"]),
        default_view_mode: updateData.default_view_mode ?? 2,
        default_hidden_status_ids:
          updateData.default_hidden_status_ids ?? JSON.stringify([]),
        opening_days:
          updateData.opening_days ?? JSON.stringify([1, 2, 3, 4, 5]),
      };
      await db.query(
        `INSERT INTO calentian_calendar_settings
         (calentian_entries_id, calentian_benutzer_id, feiertage_anzeigen, laender, bundeslaender, default_view_mode, default_hidden_status_ids, opening_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entriesId,
          benutzerId,
          data.feiertage_anzeigen,
          data.laender,
          data.bundeslaender,
          data.default_view_mode,
          data.default_hidden_status_ids,
          data.opening_days,
        ]
      );
    }

    // Schließtage
    if (Array.isArray(closing_days)) {
      console.log(`🗓️ Verarbeite ${closing_days.length} Schließtage`);
      // Alte löschen
      await db.query(
        `DELETE FROM calentian_closure_days WHERE calentian_entries_id = ?`,
        [entriesId]
      );
      // Neue einfügen
      await Promise.all(
        closing_days.map(({ type, start_date, end_date, description }) => {
          if (!type || !start_date || !description) {
            console.error("❌ Ungültiger Schließtag:", {
              type,
              start_date,
              end_date,
              description,
            });
            return Promise.resolve();
          }
          if (type === "period" && !end_date) {
            console.error("❌ Zeitraum ohne Enddatum:", {
              type,
              start_date,
              end_date,
            });
            return Promise.resolve();
          }
          if (type === "single" && end_date) {
            console.error("❌ Einzeltag mit Enddatum:", {
              type,
              start_date,
              end_date,
            });
            return Promise.resolve();
          }
          const sd = new Date(start_date);
          if (isNaN(sd)) {
            console.error("❌ Ungültiges Startdatum:", start_date);
            return Promise.resolve();
          }
          if (end_date) {
            const ed = new Date(end_date);
            if (isNaN(ed) || ed < sd) {
              console.error("❌ Ungültiges Enddatum:", end_date);
              return Promise.resolve();
            }
          }
          return db.query(
            `INSERT INTO calentian_closure_days
           (calentian_entries_id, type, start_date, end_date, description, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
            [
              entriesId,
              type,
              start_date,
              end_date || null,
              description,
              benutzerId,
            ]
          );
        })
      );
      console.log("✅ Schließtage verarbeitet");
    }

    console.log("✅ Kalendereinstellungen gespeichert");
    res
      .status(200)
      .json({
        success: true,
        message: "Kalendereinstellungen erfolgreich gespeichert.",
      });
  } catch (err) {
    console.error("❌ Fehler beim Speichern der Einstellungen:", err);
    res
      .status(500)
      .json({
        success: false,
        message: "Fehler beim Speichern. Bitte erneut versuchen.",
      });
  }
});

app.listen(port, () => {
  console.log(`✅ Server läuft auf Port ${port}`);
});
