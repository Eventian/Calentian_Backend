import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

dotenv.config();

const app = express();

// ✅ CORS Setup mit Credentials
const corsOptions = {
  origin: ['https://dashboard.calentian.de', 'http://localhost:4200'],
  methods: ['GET', 'POST'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// ✅ Debug-Middleware (optional)
app.use((req, res, next) => {
  console.log('Cookies:', req.cookies);
  next();
});

// ✅ DB-Verbindung (Pool)
let dbPool;
async function initDB() {
  dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
  console.log('✅ DB verbunden');
}

// ✅ Authentifizierungs-Middleware
function authenticateToken(req, res, next) {
  const token = req.cookies['access_token'];
  if (!token) return res.status(401).json({ message: 'Kein Token gefunden.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Ungültiger Token.' });
    req.user = user;
    next();
  });
}

// ✅ Route: Ungelesene E-Mails
app.get('/mail-service/api/emails/unread', authenticateToken, async (req, res) => {
  try {
    const locationId = req.user.calentian_entries_id;

    const [emails] = await dbPool.query(`
      SELECT e.id, e.subject, e.body, e.htmlBody, e.timestamp, e.sender, e.receiver, 
             e.calentian_event_entries_id, e.status, e.calentian_email_status_id,
             COALESCE(ev.event_name, 'Unbenanntes Event') AS event_name
      FROM calentian_kunden_emails e
      LEFT JOIN calentian_event_entries ev ON e.calentian_event_entries_id = ev.id
      WHERE e.message_ingoing = 1 
        AND e.calentian_email_status_id = 1
        AND e.calentian_entries_id = ?
    `, [locationId]);

    res.status(200).json(emails.length ? emails : []);
  } catch (err) {
    console.error('❌ Fehler beim Abrufen der ungelesenen E-Mails:', err);
    res.status(500).json({ message: 'Fehler beim Abrufen der E-Mails' });
  }
});


// ✅ Route: Zu zuordnende E-Mails
app.get('/mail-service/api/emails/to-assign', authenticateToken, async (req, res) => {
  try {
    const locationId = req.user.calentian_entries_id;

    const [emails] = await dbPool.query(`
      SELECT e.id, e.subject, e.body, e.timestamp, e.sender, e.receiver, 
             e.calentian_event_entries_id, e.status, e.calentian_email_status_id,
             COALESCE(ev.event_name, 'Unbenanntes Event') AS event_name
      FROM calentian_kunden_emails e
      LEFT JOIN calentian_event_entries ev ON e.calentian_event_entries_id = ev.id
      WHERE e.message_ingoing = 1 
        AND (e.calentian_email_status_id = 2 OR e.calentian_email_status_id = 3) 
        AND e.calentian_entries_id = ?
    `, [locationId]);

    res.status(200).json(emails.length ? emails : []);
  } catch (err) {
    console.error('❌ Fehler beim Abrufen der zuzuweisenden E-Mails:', err);
    res.status(500).json({ message: 'Fehler beim Abrufen der E-Mails' });
  }
});


// ✅ Route: Manuelle Zuordnung
app.post('/mail-service/api/emails/assign', authenticateToken, async (req, res) => {
  const { emailId, eventId, customerId } = req.body;

  try {
    const updates = [
      'calentian_event_entries_id = ?',
      'calentian_email_status_id = 1',
    ];
    const values = [eventId];

    if (customerId) {
      updates.push('customer_id = ?');
      values.push(customerId);
    }

    values.push(emailId);

    await dbPool.query(`
      UPDATE calentian_kunden_emails 
      SET ${updates.join(', ')} 
      WHERE id = ?
    `, values);

    res.status(200).json({ message: 'E-Mail erfolgreich zugeordnet' });
  } catch (err) {
    console.error('❌ Fehler beim Zuordnen der E-Mail:', err);
    res.status(500).json({ message: 'Fehler beim Zuordnen der E-Mail' });
  }
});


// E-Mail-Status (z. B. gelesen/ungelesen) aktualisieren
app.post('/mail-service/api/emails/update-status', authenticateToken, async (req, res) => {
  const { email_id, status } = req.body;

  // 1. Validierung: Muss beides vorhanden sein
  if (!email_id || status === undefined) {
    return res.status(400).json({
      message: 'Email-ID und Status müssen angegeben werden.',
    });
  }

  // 2. Optional: Nur erlaubte Statuswerte zulassen
  const allowedStatuses = [1, 2]; // 1 = ungelesen, 2 = gelesen
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      message: 'Ungültiger Statuswert! Erlaubt sind 1 (ungelesen) und 2 (gelesen).',
    });
  }

  // 3. SQL-Abfrage vorbereiten
  const query = `
    UPDATE calentian_kunden_emails
    SET calentian_email_status_id = ?
    WHERE id = ?
  `;
  const values = [status, email_id];

  try {
    const [result] = await dbPool.execute(query, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Email nicht gefunden!' });
    }

    return res.status(200).json({
      message: '✅ Email-Status erfolgreich aktualisiert',
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error('❌ Fehler beim Aktualisieren des Email-Status:', err);
    return res.status(500).json({ message: 'Fehler beim Aktualisieren des Email-Status' });
  }
});



// ✅ Server starten
const port = process.env.PORT || 5300;
app.listen(port, () => {
  console.log(`🚀 Server läuft auf Port ${port}`);
});

// ✅ DB verbinden beim Start
(async () => {
  try {
    await initDB();
  } catch (err) {
    console.error('❌ Fehler beim Starten der API:', err);
    process.exit(1);
  }
})();
