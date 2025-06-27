const cors = require('cors');
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mysql = require('mysql2/promise');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const app = express();

// ✅ CORS Setup mit Cookies
const corsOptions = {
  origin: ['https://dashboard.calentian.de', 'http://localhost:4200'],
  credentials: true,
};
app.use(cors(corsOptions));

// ✅ Body-Parser und Cookie-Parser
app.use(express.json());
app.use(cookieParser());

// ✅ Debug: Cookies anzeigen (optional)
app.use((req, res, next) => {
  console.log('Cookies:', req.cookies);
  next();
});

// ✅ Statische Assets (Widget + Loader)
app.use('/forms-service', express.static(path.join(__dirname, 'public')));

// ✅ Rate Limiter für Submits
const submitLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: { message: 'Zu viele Anfragen, bitte später erneut versuchen' },
});

// ✅ Datenbankverbindung
async function initDB() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

// ✅ Authentifizierungsmiddleware
function authenticateToken(req, res, next) {
  const token = req.cookies['access_token'];
  if (!token) return res.status(401).json({ message: 'Nicht authentifiziert' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token ungültig oder abgelaufen' });
    req.user = user;
    next();
  });
}


// 6) GET /form-config/:formId
//    Lädt config + styles zusammen aus der Tabelle
app.get(
  '/forms-service/form-config/:formId',
  cors(), // CORS für alle Domains erlauben, keine Credentials
  async (req, res) => {
    const { formId } = req.params;
    const conn = await initDB();
    try {
      const [rows] = await conn.execute(
        `SELECT config, styles
           FROM calentian_entries_forms
          WHERE id = ?`,
        [formId]
      );
      if (!rows.length) {
        return res.status(404).json({ message: 'Formular nicht gefunden' });
      }
      let config = rows[0].config;
      if (typeof config === 'string') config = JSON.parse(config);
      let styles = rows[0].styles;
      if (typeof styles === 'string') styles = JSON.parse(styles);

      res.json({ ...config, styles });
    } catch (err) {
      console.error('Config-Endpoint-Fehler:', err);
      res.status(500).json({ message: 'Server-Fehler' });
    } finally {
      await conn.end();
    }
  }
);


// 7) POST /form-submit
//    Honeypot, Zeitcheck, optional reCAPTCHA, Daten in DB
app.post(
  '/forms-service/form-submit',
  cors(),          // Offen für alle Domains, keine Credentials nötig
  submitLimiter,
  async (req, res) => {
    const { formId, data, recaptcha, calentian_menschlichkeit, ts } = req.body;

    // a) Honeypot prüfen
    if (calentian_menschlichkeit) {
      return res.status(400).json({ message: 'Spam erkannt' });
    }
    // b) Zeit-Check (mind. 3s)
    const elapsed = Date.now() - Number(ts || 0);
    if (isNaN(elapsed) || elapsed < 3_000) {
      return res.status(400).json({ message: 'Formular zu schnell ausgefüllt' });
    }

    // d) Formular-Config laden
    const conn0 = await initDB();
    let cfg;
    try {
      const [[row]] = await conn0.execute(
        'SELECT config FROM calentian_entries_forms WHERE id = ?',
        [formId]
      );
      if (!row) {
        return res.status(404).json({ message: 'Formular nicht gefunden' });
      }
      cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } catch (err) {
      console.error('Config-Lesen-Fehler:', err);
      return res.status(500).json({ message: 'Server-Fehler' });
    } finally {
      await conn0.end();
    }

    // e) Kundendaten anlegen
    let customerId;
    try {
      const conn1 = await initDB();
      const [custResult] = await conn1.execute(
        `INSERT INTO calentian_kundendaten 
           (vorname, nachname, firma, strasse, plz, stadt, telefonnummer, calentian_entries_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      customerId = custResult.insertId;
      // Email
      if (data.email) {
        await conn1.execute(
          `INSERT INTO calentian_kunden_emails_addresses 
             (calentian_kundendaten_id, email, is_primary)
           VALUES (?, ?, 1)`,
          [customerId, data.email]
        );
      }
      await conn1.end();
    } catch (err) {
      console.error('Kundenanlage-Fehler:', err);
      return res.status(500).json({ message: 'Fehler beim Anlegen des Kunden' });
    }

    // f) Event anlegen
    try {
      const conn2 = await initDB();
      const [eventResult] = await conn2.execute(
        `INSERT INTO calentian_event_entries
           (calentian_kundendaten_id,
            location_id,
            datum,
            calentian_event_entries_veranstaltungsart_id,
            calentian_event_entries_status_id,
            calentian_entries_id,
            anzahl_personen_gesamt,
            anzahl_kinder,
            event_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerId,
          cfg.locationId,
          data.datum,
          cfg.eventTypeId,
          1, // Status=neu
          cfg.calentian_entries_id,
          data.anzahl_personen_gesamt || 0,
          data.anzahl_kinder || 0,
          `${cfg.name} von ${data.vorname}`
        ]
      );
      await conn2.end();
      return res.status(201).json({ success: true, eventId: eventResult.insertId });
    } catch (err) {
      console.error('Eventanlage-Fehler:', err);
      return res.status(500).json({ message: 'Fehler beim Anlegen des Events' });
    }
  }
);


// 8) POST /form-config
//    Formular anlegen (für Dein Request-Tool)
//    Payload: { calentian_entries_id, name, config, styles }
app.post('/forms-service/form-config', cors(corsOptions), authenticateToken, async (req, res) => {
  const { calentian_entries_id, name, config, styles } = req.body;

  // Pflichtfelder prüfen
  if (!calentian_entries_id || !name || !config || !styles) {
    return res.status(400).json({
      message: 'Fehlende Pflicht-Felder: [calentian_entries_id, name, config, styles]',
    });
  }

  // Berechtigung prüfen: darf nur auf eigenen Eintrag zugreifen
  if (Number(calentian_entries_id) !== req.user.calentian_entries_id) {
    return res.status(403).json({
      message: 'Nicht berechtigt, dieses Formular anzulegen',
    });
  }

  // Parent-Eintrag existiert?
  const connCheck = await initDB();
  try {
    const [[parent]] = await connCheck.execute(
      'SELECT id FROM calentian_entries WHERE id = ?',
      [calentian_entries_id]
    );

    if (!parent) {
      return res.status(400).json({
        message: `Eintrag ${calentian_entries_id} existiert nicht`,
      });
    }
  } catch (err) {
    console.error('Parent-Check-Fehler:', err);
    return res.status(500).json({ message: 'Server-Fehler beim Prüfen des Eintrags' });
  } finally {
    await connCheck.end();
  }

  // Insert in forms-Tabelle
  try {
    const conn = await initDB();
    const [result] = await conn.execute(
      `INSERT INTO calentian_entries_forms
         (calentian_entries_id, name, config, styles)
       VALUES (?, ?, ?, ?)`,
      [
        calentian_entries_id,
        name,
        JSON.stringify(config),
        JSON.stringify(styles),
      ]
    );
    await conn.end();
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error('Fehler beim Anlegen des Formulars:', err);
    res.status(500).json({
      message: 'Server-Fehler beim Anlegen des Formulars',
      detail: err.message || err,
    });
  }
});

// 10) PUT /form-config/:formId — Update eines bestehenden Formulars
app.put('/forms-service/form-config/:formId', cors(corsOptions), authenticateToken, async (req, res) => {
  const { formId } = req.params;
  const { name, config, styles, calentian_entries_id } = req.body;
  const conn = await initDB();
  try {
    const [result] = await conn.execute(
      `UPDATE calentian_entries_forms 
           SET name = ?, config = ?, styles = ?
         WHERE id = ?`,
      [
        name,
        JSON.stringify(config),
        JSON.stringify(styles),
        formId
      ]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Formular nicht gefunden' });
    }
    res.json({ id: Number(formId) });
  } catch (err) {
    console.error('Update-Fehler:', err);
    res.status(500).json({ message: 'Server-Fehler beim Aktualisieren' });
  } finally {
    await conn.end();
  }
});

// 9) DELETE /form-config/:formId
//    Formular löschen
app.delete('/forms-service/form-config/:formId', cors(corsOptions), authenticateToken, async (req, res) => {
  const { formId } = req.params;
  const conn = await initDB();
  try {
    const [result] = await conn.execute(
      'DELETE FROM calentian_entries_forms WHERE id = ?',
      [formId]
    );
    await conn.end();
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Formular nicht gefunden' });
    }
    res.status(204).end(); // No Content
  } catch (err) {
    console.error('Fehler beim Löschen des Formulars:', err);
    res.status(500).json({ message: 'Server-Fehler beim Löschen' });
  }
});

// 9) Server starten
const PORT = process.env.PORT || 6200;
app.listen(PORT, () => {
  console.log(`Forms-Service listening on port ${PORT}`);
});
