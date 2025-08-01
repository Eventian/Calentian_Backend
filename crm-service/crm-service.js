// 📦 Imports
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");

// 📄 .env laden
dotenv.config();

// 🚀 Express Setup
const app = express();

// 🌐 CORS + Parser
app.use(
  cors({
    origin: ["https://dashboard.calentian.de", "http://localhost:4200"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// 🧠 Middleware: Token prüfen
function authenticateToken(req, res, next) {
  const token = req.cookies["access_token"];
  if (!token) return res.status(401).json({ message: "Nicht authentifiziert" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err)
      return res
        .status(403)
        .json({ message: "Token ungültig oder abgelaufen" });
    req.user = user;
    next();
  });
}

// 🔌 Datenbankverbindung
async function initDB() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

// 🧾 Debug: Logge alle Routen
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 🧩 CRM-Routen

// Kundenliste
app.get("/crm-service/customers", authenticateToken, async (req, res) => {
  const conn = await initDB();
  const [rows] = await conn.query(
    "SELECT * FROM calentian_kundendaten WHERE calentian_entries_id = ?",
    [req.user.calentian_entries_id]
  );
  res.json(rows);
});

// Kunde anlegen
app.post("/crm-service/customers", authenticateToken, async (req, res) => {
  const { firma, vorname, nachname, strasse, plz, stadt, telefonnummer } =
    req.body;
  const conn = await initDB();
  const [result] = await conn.query(
    `INSERT INTO calentian_kundendaten 
     (firma, vorname, nachname, strasse, plz, stadt, telefonnummer, calentian_entries_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      firma,
      vorname,
      nachname,
      strasse,
      plz,
      stadt,
      telefonnummer,
      req.user.calentian_entries_id,
    ]
  );
  res.json({ id: result.insertId });
});

// Kunde aktualisieren
app.put("/crm-service/customers/:id", authenticateToken, async (req, res) => {
  const customerId = parseInt(req.params.id);
  const { firma, vorname, nachname, strasse, plz, stadt, telefonnummer } =
    req.body;
  const conn = await initDB();
  await conn.query(
    `UPDATE calentian_kundendaten 
     SET firma = ?, vorname = ?, nachname = ?, strasse = ?, plz = ?, stadt = ?, telefonnummer = ?
     WHERE id = ? AND calentian_entries_id = ?`,
    [
      firma,
      vorname,
      nachname,
      strasse,
      plz,
      stadt,
      telefonnummer,
      customerId,
      req.user.calentian_entries_id,
    ]
  );
  res.json({ success: true });
});

// Kunde löschen
app.delete(
  "/crm-service/customers/:id",
  authenticateToken,
  async (req, res) => {
    const customerId = parseInt(req.params.id);
    const conn = await initDB();
    await conn.query(
      "DELETE FROM calentian_kundendaten WHERE id = ? AND calentian_entries_id = ?",
      [customerId, req.user.calentian_entries_id]
    );
    res.json({ success: true });
  }
);

// E-Mails abrufen
app.get(
  "/crm-service/customers/:id/emails",
  authenticateToken,
  async (req, res) => {
    const customerId = parseInt(req.params.id);
    const conn = await initDB();
    const [rows] = await conn.query(
      "SELECT * FROM calentian_kundendaten_email WHERE calentian_kundendaten_id = ?",
      [customerId]
    );
    res.json(rows);
  }
);

// E-Mail hinzufügen
app.post(
  "/crm-service/customers/:id/emails",
  authenticateToken,
  async (req, res) => {
    const customerId = parseInt(req.params.id);
    const { email, is_primary } = req.body;
    const conn = await initDB();
    const [result] = await conn.query(
      `INSERT INTO calentian_kundendaten_email (calentian_kundendaten_id, email, is_primary)
     VALUES (?, ?, ?)`,
      [customerId, email, is_primary ? 1 : 0]
    );
    res.json({ id: result.insertId });
  }
);

// E-Mail bearbeiten
app.put("/crm-service/emails/:emailId", authenticateToken, async (req, res) => {
  const emailId = parseInt(req.params.emailId);
  const { email, is_primary } = req.body;
  const conn = await initDB();
  await conn.query(
    `UPDATE calentian_kundendaten_email SET email = ?, is_primary = ? WHERE id = ?`,
    [email, is_primary ? 1 : 0, emailId]
  );
  res.json({ success: true });
});

// E-Mail löschen
app.delete(
  "/crm-service/emails/:emailId",
  authenticateToken,
  async (req, res) => {
    const emailId = parseInt(req.params.emailId);
    const conn = await initDB();
    await conn.query("DELETE FROM calentian_kundendaten_email WHERE id = ?", [
      emailId,
    ]);
    res.json({ success: true });
  }
);

// 🟢 Server starten
const PORT = process.env.PORT || 6203;
app.listen(PORT, () => {
  console.log(`✅ CRM-Service läuft auf Port ${PORT}`);
});
