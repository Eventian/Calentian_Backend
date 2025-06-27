require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 6100;

app.set('trust proxy', 1);
app.use(helmet());
app.use(cookieParser());
app.use(express.json());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:4200', 'https://dashboard.calentian.de'];

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 1000,
  queueLimit: 0,
});

// Authentifizierung via HTTP-only Cookie
function authenticateToken(req, res, next) {
  const token = req.cookies['access_token'];
  if (!token) return res.status(401).json({ error: 'Kein Token vorhanden.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, payload) => {
    if (err) return res.status(403).json({ error: 'Token ungültig.' });
    req.user = payload;
    next();
  });
}

// GET Notizen
app.get('/notes-service/notes', authenticateToken, (req, res) => {
  const eventId = req.query.eventId;
  if (!eventId) return res.status(400).json({ error: 'Event-ID fehlt.' });

  const sql = `
    SELECT n.id, n.time, n.note, n.calentian_event_entries_id, n.calentian_benutzer_id,
           b.benutzername, b.email
    FROM calentian_notes n
    LEFT JOIN calentian_benutzer b ON n.calentian_benutzer_id = b.id
    WHERE n.calentian_event_entries_id = ?
    ORDER BY n.time DESC
  `;
  pool.query(sql, [eventId], (err, results) => {
    if (err) return res.status(500).json({ error: err });
    res.json(results);
  });
});

// POST Notiz
app.post('/notes-service/notes', authenticateToken, (req, res) => {
  const { note, calentian_event_entries_id } = req.body;
  const userId = req.user.id;
  const entryId = calentian_event_entries_id || req.user.calentian_entries_id;

  if (!note) return res.status(400).json({ error: 'Notiz fehlt.' });

  const sql = `
    INSERT INTO calentian_notes (note, calentian_event_entries_id, calentian_benutzer_id)
    VALUES (?, ?, ?)
  `;
  pool.query(sql, [note, entryId, userId], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    pool.query('SELECT * FROM calentian_notes WHERE id = ?', [result.insertId], (err2, rows) => {
      if (err2) return res.status(500).json({ error: err2 });
      res.status(201).json(rows[0]);
    });
  });
});

// PUT Notiz
app.put('/notes-service/notes/:id', authenticateToken, (req, res) => {
  const noteId = req.params.id;
  const { note } = req.body;

  if (!note) return res.status(400).json({ error: 'Notiz fehlt.' });

  pool.query('SELECT * FROM calentian_notes WHERE id = ?', [noteId], (err, results) => {
    if (err) return res.status(500).json({ error: err });
    if (!results.length) return res.status(404).json({ error: 'Notiz nicht gefunden.' });

    if (results[0].calentian_benutzer_id !== req.user.id)
      return res.status(403).json({ error: 'Nicht berechtigt.' });

    pool.query('UPDATE calentian_notes SET note = ? WHERE id = ?', [note, noteId], err2 => {
      if (err2) return res.status(500).json({ error: err2 });

      pool.query('SELECT * FROM calentian_notes WHERE id = ?', [noteId], (err3, rows) => {
        if (err3) return res.status(500).json({ error: err3 });
        res.json(rows[0]);
      });
    });
  });
});

// DELETE Notiz
app.delete('/notes-service/notes/:id', authenticateToken, (req, res) => {
  const noteId = req.params.id;

  pool.query('SELECT * FROM calentian_notes WHERE id = ?', [noteId], (err, results) => {
    if (err) return res.status(500).json({ error: err });
    if (!results.length) return res.status(404).json({ error: 'Notiz nicht gefunden.' });

    if (results[0].calentian_benutzer_id !== req.user.id)
      return res.status(403).json({ error: 'Nicht berechtigt.' });

    pool.query('DELETE FROM calentian_notes WHERE id = ?', [noteId], err2 => {
      if (err2) return res.status(500).json({ error: err2 });
      res.json({ message: 'Notiz gelöscht.' });
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ Notes Service läuft auf Port ${PORT}`);
});
