// smtp-service-server.js
const dotenv = require('dotenv');
const cors = require('cors');
const express = require('express');
const axios = require('axios');

const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

// Environment-Variablen laden
dotenv.config();

// Express-Instanz
const app = express();

// CORS-Optionen
const corsOptions = {
  origin: ['http://localhost:4200', 'https://dashboard.calentian.de'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// 1) CORS für alle Routen aktivieren
app.use(cors(corsOptions));
// 2) Preflight (OPTIONS) global beantworten
app.options('*', cors(corsOptions));

// Body-Parser
app.use(express.json());

// JWT-Middleware
function checkJwt(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return res.status(403).json({ message: 'Kein Token, Zugriff verweigert' });
  }
  const token = auth.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ message: 'Ungültiges Token' });
  }
}

// Datenbankverbindung
async function initDB() {
  return mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

// Brevo/Sendinblue-Konfiguration
const BREVO_API_URL = 'https://api.sendinblue.com/v3/smtp/email';
const BREVO_API_KEY = process.env.BREVO_API_KEY;
if (!BREVO_API_KEY) {
  console.error('❌ BREVO_API_KEY fehlt in der .env');
  process.exit(1);
}

// Route: E-Mail versenden
app.post('/smtp-service/send-email', checkJwt, async (req, res) => {
  try {
    const { event_id, calentian_kundendaten_id, to, subject, text, htmlBody } = req.body;
    if (!to || !subject || !text) {
      return res.status(400).json({ message: 'Erforderliche Felder fehlen.' });
    }

    // Entry-ID aus JWT
    const entryId = req.user.calentian_entries_id;
    if (!entryId) {
      return res.status(400).json({ message: 'Keine entryId im Token.' });
    }

    // Eintragsdaten aus DB holen
    const db = await initDB();
    const [rows] = await db.execute(
      `SELECT
         calentian_entries_name AS name,
         calentian_entries_zusatz AS zusatz,
         calentian_entries_zusatz_davor AS zusatzDavor
       FROM calentian_entries
       WHERE id = ?
       LIMIT 1`,
      [entryId]
    );
    await db.end();

    if (!rows.length) {
      return res.status(404).json({ message: 'Entry nicht gefunden.' });
    }
    const { name, zusatz, zusatzDavor } = rows[0];

    // From-Name bauen
    let fromName = name;
    if (zusatz) {
      fromName = zusatzDavor == 1
        ? `${zusatz} ${name}`
        : `${name} ${zusatz}`;
    }

    // From-Adresse bauen
    const localPart = `${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-') + `-${entryId}`;
    const fromEmail = `${localPart}@mail-calentian.de`;

    // Payload für Brevo
    const brevoPayload = {
      sender:    { name: fromName, email: fromEmail },
      to:        [{ email: to }],
      subject,
      textContent: text,
      htmlContent: htmlBody || text,
      headers:     { 'X-MailC-alentian-Entry': String(entryId) }
    };

    // E-Mail via Brevo senden
    const brevoRes = await axios.post(BREVO_API_URL, brevoPayload, {
      headers: {
        'Content-Type': 'application/json',
        'api-key':       BREVO_API_KEY,
      }
    });

    // In eigener DB speichern
    const db2 = await initDB();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db2.execute(
      `INSERT INTO calentian_kunden_emails
        (subject, body, htmlBody, timestamp,
         sender, receiver,
         calentian_kundendaten_id,
         calentian_event_entries_id,
         attachments, status,
         calentian_entries_id, message_ingoing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subject,
        text,
        htmlBody || text,
        now,
        fromEmail,
        to,
        calentian_kundendaten_id || null,
        event_id              || null,
        null,  // attachments
        0,     // status: 0 = ausgehend
        entryId,
        0      // message_ingoing: 0 = ausgehend
      ]
    );
    await db2.end();

    // Erfolg zurückgeben
    return res.status(200).json({
      message:   'E-Mail erfolgreich versendet und gespeichert',
      brevoInfo: brevoRes.data
    });

  } catch (err) {
    console.error('Fehler in /send-email:', err.response?.data || err.message || err);
    return res.status(500).json({ message: 'E-Mail-Versand fehlgeschlagen.' });
  }
});

// Server starten
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`SMTP-Service-Server läuft auf Port ${PORT}`);
});
