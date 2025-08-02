console.log("Starte Login-Service...");
require("dotenv").config();
console.log("ENV geladen:", process.env.DB_HOST); // z. B. eine deiner Variablen
const express = require("express");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cookieParser = require("cookie-parser"); // ✅ NEU
const bodyParser = require("body-parser");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

const SECRET_KEY = process.env.JWT_SECRET || "default_secret_key";

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.getConnection()
  .then(() => console.log("✅ Datenbankverbindung erfolgreich"))
  .catch((err) => {
    console.error("❌ Fehler bei der DB-Verbindung:", err.message);
    process.exit(1); // Verhindert Endlosschleife durch Docker
  });

const app = express();
const PORT = 3000;

const allowedOrigins = [
  "http://localhost:4200",
  "https://dashboard.calentian.de",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        callback(null, true);
      } else {
        console.warn(`❌ Blockierter Origin: ${origin}`);
        callback(new Error("Nicht erlaubter Ursprung: " + origin));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Für Preflight explizit freigeben
app.options(
  "*",
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        callback(null, true);
      } else {
        callback(new Error("Nicht erlaubter Ursprung: " + origin));
      }
    },
    credentials: true,
  })
);

app.use(cookieParser()); // ✅ aktivieren
app.use(bodyParser.json());

// 🔐 LOGIN
app.post("/login-service/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const [rows] = await db.query(
      "SELECT * FROM calentian_benutzer WHERE email = ?",
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten" });
    }

    const user = rows[0];

    if (!password || !user.passwort) {
      return res.status(400).json({ error: "Fehlende Anmeldedaten" });
    }

    const isMatch = bcrypt.compareSync(password, user.passwort);
    if (!isMatch) {
      return res.status(401).json({ error: "Ungültige Anmeldedaten" });
    }

    // ✅ Token generieren
    const token = jwt.sign(
      {
        calentian_benutzer_email: user.email,
        calentian_entries_id: user.calentian_entries_id,
        calentian_benutzer_id: user.id,
      },
      SECRET_KEY,
      { expiresIn: "1h" }
    );

    // ✅ Setze HttpOnly-Cookie
    const isLocalhost =
      req.hostname === "localhost" || req.headers.origin?.includes("localhost");

    res.cookie("access_token", token, {
      httpOnly: true,
      secure: req.hostname !== "localhost", // ✅ Nur wenn NICHT lokal
      sameSite: req.hostname !== "localhost" ? "None" : "Lax", // ✅ Sicherer Fallback
      maxAge: 60 * 60 * 1000,
    });

    // ✅ Rückmeldung ohne Token
    res.status(200).json({
      message: "Login erfolgreich",
      user: {
        calentian_benutzer_id: user.id,
        calentian_benutzer_email: user.email,
        calentian_entries_id: user.calentian_entries_id,
      },
    });
  } catch (err) {
    console.error("Fehler beim Login:", err);
    res.status(500).json({ error: "Serverfehler" });
  }
});

// 🔐  Session prüfen anhand des HttpOnly-Cookies
app.get("/login-service/session", async (req, res) => {
  try {
    const token = req.cookies.access_token;
    if (!token) {
      return res.status(200).json({ authenticated: false });
    }

    const decoded = jwt.verify(token, SECRET_KEY);
    const [rows] = await db.query(
      "SELECT id, email, calentian_entries_id FROM calentian_benutzer WHERE id = ?",
      [decoded.calentian_benutzer_id]
    );

    if (rows.length === 0) {
      return res.status(200).json({ authenticated: false });
    }

    const user = rows[0];

    res.status(200).json({
      authenticated: true,
      user: {
        calentian_benutzer_id: user.id,
        calentian_benutzer_email: user.email,
        calentian_entries_id: user.calentian_entries_id,
      },
    });
  } catch (err) {
    console.error("❌ Fehler bei Session-Prüfung:", err.message);
    res.status(200).json({ authenticated: false });
  }
});

app.post("/login-service/logout", (req, res) => {
  res.clearCookie("access_token", {
    httpOnly: true,
    secure: true, // nur über HTTPS löschen
    sameSite: "Strict", // verhindert CSRF
    path: "/", // wichtig, wenn der Cookie mit path gesetzt wurde
  });
  res.status(200).json({ message: "Logout erfolgreich" });
});

app.listen(PORT, () => {
  console.log(`🚀 Login-Service läuft auf Port ${PORT}`);
});
