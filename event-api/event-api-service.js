require("dotenv").config();
const express = require("express");
// Verwende die promise-basierte Variante von mysql2:
const mysql = require("mysql2/promise");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ✅ Globale DB-Verbindung (für Endpunkte, die synchron arbeiten)
// Für Endpunkte, die async/await nutzen, verwenden wir initDB().
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.then((connection) => {
  console.log("✅ Mit der MySQL-Datenbank verbunden");
}).catch((err) => {
  console.error("❌ Fehler bei der Datenbankverbindung:", err);
});

// Neue Funktion: initDB für Endpunkte, die async/await nutzen
async function initDB() {
  return await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

// 🔐 Middleware: Token-Authentifizierung
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Kein Token gefunden." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Ungültiger Token." });
    }
    req.user = user;
    next();
  });
}

// 🔒 API-Route: Alle Locations mit Event-Zuordnung
app.get("/event-api/api/locations", authenticateToken, async (req, res) => {
  const query = `
    SELECT 
      l.id, 
      l.location_name, 
      e.id AS event_id, 
      va.name AS veranstaltungsart_label
    FROM calentian_entries_location l
    LEFT JOIN calentian_event_entries e ON l.id = e.location_id
    LEFT JOIN calentian_event_entries_veranstaltungsart va ON e.calentian_event_entries_veranstaltungsart_id = va.id
    WHERE l.calentian_entries_id = ?
  `;
  try {
    const connection = await initDB();
    const [results] = await connection.execute(query, [
      req.user.calentian_entries_id,
    ]);
    await connection.end();
    res.json(results);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Locations:", err);
    res.status(500).send("Fehler beim Abrufen der Locations");
  }
});

// 🔒 API-Route: Einzelnes Event nach ID abrufen
app.get("/event-api/api/events/:id", authenticateToken, async (req, res) => {
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
    const connection = await initDB();
    const [results] = await connection.execute(query, [
      eventId,
      req.user.calentian_entries_id,
    ]);
    await connection.end();

    if (results.length === 0) {
      return res.status(404).json({ message: "Event nicht gefunden" });
    }

    const event = results[0];
    // Falls customer_emails als kommagetrennte Liste in der DB gespeichert wurde,
    // konvertieren wir diese in ein Array.
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
app.post("/event-api/api/events", authenticateToken, async (req, res) => {
  const {
    kunden_id,
    location_id,
    datum,
    veranstaltungsart,
    status,
    anzahl_personen_gesamt,
    event_name,
    guest_groups,
  } = req.body;

  if (!kunden_id || !location_id || !datum || !veranstaltungsart || !status) {
    return res
      .status(400)
      .json({ message: "Alle Felder müssen ausgefüllt sein!" });
  }

  const connection = await initDB();

  try {
    // Veranstaltungsart-Label ermitteln
    const [vaRows] = await connection.execute(
      "SELECT name FROM calentian_event_entries_veranstaltungsart WHERE id = ?",
      [veranstaltungsart]
    );
    const label = vaRows.length > 0 ? vaRows[0].name : "";

    // Kundenvorname bzw. Firmenname ermitteln
    const [customerRows] = await connection.execute(
      "SELECT vorname, firma FROM calentian_kundendaten WHERE id = ?",
      [kunden_id]
    );
    let customerName = "";
    if (customerRows.length > 0) {
      customerName =
        customerRows[0].firma && customerRows[0].firma.trim() !== ""
          ? customerRows[0].firma
          : customerRows[0].vorname;
    }

    // Fallback für event_name, falls nicht gesetzt
    const finalEventName =
      event_name && event_name.trim() !== ""
        ? event_name
        : `${label} von ${customerName}`;

    // Hauptevent erstellen (ohne anzahl_kinder)
    const query = `
      INSERT INTO calentian_event_entries (
        calentian_kundendaten_id, 
        location_id, 
        datum, 
        calentian_event_entries_veranstaltungsart_id, 
        calentian_event_entries_status_id, 
        calentian_entries_id, 
        anzahl_personen_gesamt, 
        event_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await connection.execute(query, [
      kunden_id,
      location_id,
      datum,
      veranstaltungsart,
      status,
      req.user.calentian_entries_id,
      anzahl_personen_gesamt || 0,
      finalEventName,
    ]);

    const eventId = result.insertId;

    // Gästegruppen verarbeiten, falls vorhanden
    if (
      guest_groups &&
      Array.isArray(guest_groups) &&
      guest_groups.length > 0
    ) {
      for (const group of guest_groups) {
        // Passende Template-ID finden basierend auf title, min_age und max_age
        const [templateRows] = await connection.execute(
          `
          SELECT id FROM calentian_guest_group_template 
          WHERE title = ? AND min_age = ? AND max_age = ?
        `,
          [group.guest_group_title, group.min_age, group.max_age]
        );

        if (templateRows.length > 0) {
          const templateId = templateRows[0].id;

          // Gästegruppe in calentian_event_guest_count einfügen
          await connection.execute(
            `
            INSERT INTO calentian_event_guest_count (
              calentian_event_entries_id, 
              guest_group_template_id, 
              guest_count
            ) VALUES (?, ?, ?)
          `,
            [eventId, templateId, group.guest_count]
          );
        }
      }
    }

    await connection.end();
    res.status(201).json({
      message: "✅ Event erfolgreich erstellt",
      eventId: eventId,
    });
  } catch (err) {
    console.error("❌ Fehler beim Erstellen des Events:", err);
    await connection.end();
    res.status(500).json({ message: "Fehler beim Erstellen des Events" });
  }
});

// 🔓 API-Route: Alle Kunden abrufen (nach calentian_entries_id gefiltert)
app.get("/event-api/api/customers", authenticateToken, async (req, res) => {
  const userEntryId = req.user.calentian_entries_id;
  const query = `
    SELECT k.*, GROUP_CONCAT(a.email) AS emails
    FROM calentian_kundendaten k
    LEFT JOIN calentian_kunden_emails_addresses a ON a.calentian_kundendaten_id = k.id
    WHERE k.calentian_entries_id = ?
    GROUP BY k.id, k.vorname, k.nachname, k.firma, k.strasse, k.plz, k.stadt, k.telefonnummer, k.calentian_entries_id
  `;
  try {
    const connection = await initDB();
    const [results] = await connection.execute(query, [userEntryId]);
    await connection.end();
    results.forEach((customer) => {
      customer.emails = customer.emails ? customer.emails.split(",") : [];
    });
    res.json(results);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Kundendaten:", err);
    res.status(500).json({ message: "Fehler beim Abrufen der Kundendaten" });
  }
});

// 🔒 API-Route: Neuen Kunden anlegen (aktualisiert, E-Mail in separater Tabelle speichern)
app.post("/event-api/api/customers", authenticateToken, async (req, res) => {
  // Erwartete Felder: vorname, nachname, firma, strasse, plz, stadt, telefonnummer, email, calentian_entries_id, useFirma (optional)
  const {
    vorname,
    nachname,
    firma,
    strasse,
    plz,
    stadt,
    telefonnummer,
    email,
    calentian_entries_id,
  } = req.body;

  if (!vorname || !nachname || !email) {
    return res
      .status(400)
      .json({ message: "Vorname, Nachname und Email sind Pflichtfelder!" });
  }

  try {
    const connection = await initDB();
    // 1. Füge den Kunden in der Tabelle calentian_kundendaten ein – beide Felder werden getrennt übernommen
    const [result] = await connection.execute(
      `INSERT INTO calentian_kundendaten (vorname, nachname, firma, strasse, plz, stadt, telefonnummer, calentian_entries_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vorname,
        nachname,
        firma || null,
        strasse,
        plz,
        stadt,
        telefonnummer || null,
        calentian_entries_id,
      ]
    );
    const newCustomerId = result.insertId;
    // 2. Füge den E-Mail-Eintrag in der Tabelle calentian_kunden_emails_addresses ein (primär)
    await connection.execute(
      `INSERT INTO calentian_kunden_emails_addresses (calentian_kundendaten_id, email, is_primary)
       VALUES (?, ?, 1)`,
      [newCustomerId, email]
    );
    // 3. Lade den neuen Kunden inkl. der zugehörigen E-Mail(s) und sende ihn zurück
    const [rows] = await connection.execute(
      `SELECT k.id, k.vorname, k.nachname, k.firma, k.strasse, k.plz, k.stadt, k.telefonnummer, k.calentian_entries_id,
              GROUP_CONCAT(a.email) AS emails
       FROM calentian_kundendaten k
       LEFT JOIN calentian_kunden_emails_addresses a ON a.calentian_kundendaten_id = k.id
       WHERE k.id = ?
       GROUP BY k.id, k.vorname, k.nachname, k.firma, k.strasse, k.plz, k.stadt, k.telefonnummer, k.calentian_entries_id`,
      [newCustomerId]
    );
    await connection.end();

    if (rows[0] && rows[0].emails) {
      rows[0].emails = rows[0].emails.split(",");
    } else {
      rows[0].emails = [];
    }
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Fehler beim Erstellen des Kunden:", err);
    return res.status(500).json({ message: "Interner Serverfehler", err });
  }
});

// API-Route: Prüfen, ob eine E-Mail-Adresse bereits existiert (in der Tabelle calentian_kunden_emails_addresses)
app.get(
  "/event-api/api/customers/email-exists",
  authenticateToken,
  async (req, res) => {
    const email = req.query.email;
    if (!email) {
      return res.status(400).json({ message: "Email-Parameter fehlt." });
    }
    try {
      const connection = await initDB();
      const [rows] = await connection.execute(
        `SELECT COUNT(*) AS count FROM calentian_kunden_emails_addresses WHERE email = ?`,
        [email]
      );
      await connection.end();
      const exists = rows[0].count > 0;
      return res.json({ exists });
    } catch (err) {
      console.error("Fehler beim Überprüfen der E-Mail-Adresse:", err);
      return res.status(500).json({ message: "Interner Serverfehler", err });
    }
  }
);

// 🔒 API-Route: Alle Nachrichten für ein bestimmtes Event abrufen
app.get(
  "/event-api/api/emails/:eventId",
  authenticateToken,
  async (req, res) => {
    const eventId = req.params.eventId;
    const query = `
    SELECT *
    FROM calentian_kunden_emails
    WHERE calentian_event_entries_id = ?
    ORDER BY timestamp DESC
  `;
    try {
      const connection = await initDB();
      const [results] = await connection.execute(query, [eventId]);
      await connection.end();
      res.json(results);
    } catch (err) {
      console.error("❌ Fehler beim Abrufen der Nachrichten:", err);
      res
        .status(500)
        .json({ message: "Fehler beim Laden der Nachrichten", err });
    }
  }
);

//🔒 API-Route: Status der Nachrichten ändern
app.post(
  "/event-api/api/emails/update-status",
  authenticateToken,
  async (req, res) => {
    const { email_id, status } = req.body;

    // Es müssen sowohl eine Email-ID als auch ein Status (z. B. 1 für ungelesen, 2 für gelesen) übergeben werden.
    if (!email_id || status === undefined) {
      return res
        .status(400)
        .json({ message: "Email-ID und Status müssen angegeben werden." });
    }

    // Optional: Erlaube nur die Werte 1 (ungelesen) und 2 (gelesen)
    if (![1, 2].includes(status)) {
      return res.status(400).json({
        message:
          "Ungültiger Statuswert! Erlaubt sind 1 (ungelesen) und 2 (gelesen).",
      });
    }

    const query =
      "UPDATE calentian_kunden_emails SET calentian_email_status_id = ? WHERE id = ?";
    const values = [status, email_id];

    try {
      const connection = await initDB();
      const [result] = await connection.execute(query, values);
      await connection.end();

      // Wenn keine Zeile betroffen wurde, existiert die Email vermutlich nicht
      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Email nicht gefunden!" });
      }

      res.status(200).json({
        message: "✅ Email-Status erfolgreich aktualisiert",
        affectedRows: result.affectedRows,
      });
    } catch (err) {
      console.error("❌ Fehler beim Aktualisieren des Email-Status:", err);
      res
        .status(500)
        .json({ message: "Fehler beim Aktualisieren des Email-Status" });
    }
  }
);

// 🔒API-Route:  Diese Route gibt alle Einträge aus der Tabelle "calentian_entries_location" zurück,
// die zur aktuell angemeldeten Entry-ID gehören (aus dem Token, z. B. req.user.calentian_entries_id).
app.get(
  "/event-api/api/user-locations",
  authenticateToken,
  async (req, res) => {
    const entryId = req.user.calentian_entries_id;
    if (!entryId) {
      return res
        .status(400)
        .json({ message: "calentian_entries_id fehlt im Token." });
    }

    const query = `
    SELECT id, location_name 
    FROM calentian_entries_location 
    WHERE calentian_entries_id = ?
  `;
    try {
      const connection = await initDB();
      const [results] = await connection.execute(query, [entryId]);
      await connection.end();
      res.json(results);
    } catch (err) {
      console.error("❌ Fehler beim Abrufen der User-Locations:", err);
      res
        .status(500)
        .json({ message: "Fehler beim Abrufen der User-Locations" });
    }
  }
);

// 🔒 API-Route: Event aktualisieren (PUT)
app.put("/event-api/api/events/:id", authenticateToken, async (req, res) => {
  const eventId = req.params.id;
  const {
    veranstaltungsart,
    datum,
    status,
    location_id,
    event_name,
    calentian_kundendaten_id,
    anzahl_personen_gesamt,
    anzahl_kinder,
  } = req.body;

  // Dynamisch die Felder für das Update zusammenstellen
  const updates = [];
  const values = [];

  if (veranstaltungsart) {
    updates.push("calentian_event_entries_veranstaltungsart_id = ?");
    values.push(veranstaltungsart);
  }
  if (datum) {
    updates.push("datum = ?");
    values.push(datum);
  }
  if (status) {
    updates.push("calentian_event_entries_status_id = ?");
    values.push(status);
  }
  if (location_id) {
    updates.push("location_id = ?");
    values.push(location_id);
  }
  if (event_name) {
    updates.push("event_name = ?");
    values.push(event_name);
  }
  if (calentian_kundendaten_id) {
    updates.push("calentian_kundendaten_id = ?");
    values.push(calentian_kundendaten_id);
  }
  if (anzahl_personen_gesamt) {
    updates.push("anzahl_personen_gesamt = ?");
    values.push(anzahl_personen_gesamt);
  }
  if (anzahl_kinder) {
    updates.push("anzahl_kinder = ?");
    values.push(anzahl_kinder);
  }

  // Wenn keine Felder angegeben sind, Fehler zurückgeben
  if (updates.length === 0) {
    return res
      .status(400)
      .json({ message: "Keine Felder zum Aktualisieren angegeben!" });
  }

  // Query dynamisch zusammenstellen
  const query = `UPDATE calentian_event_entries SET ${updates.join(
    ", "
  )} WHERE id = ?`;
  values.push(eventId);

  try {
    const connection = await initDB();
    const [result] = await connection.execute(query, values);
    await connection.end();
    res.json({
      message: "✅ Event erfolgreich aktualisiert",
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error("❌ Fehler beim Aktualisieren des Events:", err);
    res.status(500).json({ message: "Fehler beim Aktualisieren des Events" });
  }
});

// 🔒 API-Route: Alle Status abrufen
app.get("/event-api/api/status", authenticateToken, async (req, res) => {
  try {
    const connection = await initDB();
    const [results] = await connection.execute(
      "SELECT id, label, css_class FROM calentian_event_entries_status"
    );
    await connection.end();
    res.json(results);
  } catch (err) {
    console.error("❌ Fehler beim Abrufen der Status:", err);
    res.status(500).json({ message: "Fehler beim Abrufen der Status" });
  }
});

// 🔒 API-Route: Alle Veranstaltungsarten abrufen
app.get(
  "/event-api/api/veranstaltungsart",
  authenticateToken,
  async (req, res) => {
    try {
      const connection = await initDB();
      const [results] = await connection.execute(
        "SELECT id, name FROM calentian_event_entries_veranstaltungsart"
      );
      await connection.end();
      res.json(results);
    } catch (err) {
      console.error("❌ Fehler beim Abrufen der Status:", err);
      res.status(500).json({ message: "Fehler beim Abrufen der Status" });
    }
  }
);

// 🔥 Server starten
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
