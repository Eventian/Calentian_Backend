import dotenv from "dotenv";
dotenv.config(); // Damit VAULT_* geladen wird

import initVault from "./vault-init.js";
import express from "express";
import jwt from "jsonwebtoken";
import cors from "cors";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import mysql from "mysql2/promise";
import bcrypt from "bcrypt";

// Hole Secrets aus Vault
(async () => {
  const secretPaths = process.env.VAULT_SECRETS?.split(",") || [
    "database",
    "jwt",
  ];
  await initVault(secretPaths);

  console.log("Starte Login-Service...");
  console.log("ENV geladen:", process.env.DB_HOST); // Optional Debug

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
      process.exit(1);
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

  app.use(cookieParser());
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

      const token = jwt.sign(
        {
          calentian_benutzer_email: user.email,
          calentian_entries_id: user.calentian_entries_id,
          calentian_benutzer_id: user.id,
        },
        SECRET_KEY,
        { expiresIn: "12h" }
      );

      const isLocalhost =
        req.hostname === "localhost" ||
        req.headers.origin?.includes("localhost");

      res.cookie("access_token", token, {
        httpOnly: true,
        secure: req.hostname !== "localhost",
        sameSite: req.hostname !== "localhost" ? "None" : "Lax",
        maxAge: 60 * 60 * 1000,
      });

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

  // 🔐 Session prüfen anhand des HttpOnly-Cookies
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
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    res.status(200).json({ message: "Logout erfolgreich" });
  });

  app.listen(PORT, () => {
    console.log(`🚀 Login-Service läuft auf Port ${PORT}`);
  });
})();
