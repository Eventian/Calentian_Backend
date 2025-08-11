// calentian-ai-service.js
import express from "express";
import crypto from "crypto";
import { ImapFlow } from "imapflow";
import { v4 as uuid } from "uuid";
import mysql from "mysql2/promise";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import initVault from "./vault-init.js";
import { simpleParser } from "mailparser";
import { htmlToText } from "html-to-text";

// ---------------- Config ----------------
const BASE = "/calentian-ai";
let ENC_KEY,
  OLLAMA_URL,
  OLLAMA_MODEL,
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET;

// Utility: ENV erzwingen
function requireEnv(keys) {
  const miss = keys.filter((k) => !process.env[k]);
  if (miss.length) throw new Error("Missing env: " + miss.join(", "));
}

// ---------------- Verschlüsselung ----------------
const ALGO = "aes-256-gcm";
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, ENC_KEY, iv);
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([c.update(pt), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
function open(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = crypto.createDecipheriv(ALGO, ENC_KEY, iv);
  d.setAuthTag(tag);
  const dec = Buffer.concat([d.update(enc), d.final()]);
  return JSON.parse(dec.toString("utf8"));
}

// ---------------- In-Memory Store ----------------
const credStore = new Map();
const analysisStore = new Map(); // NEU: Analysis Store

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of credStore.entries())
    if (v.expiresAt <= now) credStore.delete(k);
}, 30_000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of analysisStore.entries())
    if (v.expiresAt <= now) analysisStore.delete(k);
}, 30_000).unref();

// ---------------- DB ----------------
let pool;
async function initDb() {
  requireEnv(["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"]);
  pool = await mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 100,
    queueLimit: 0,
  });
}

// ---------------- App ----------------
const app = express();

// CORS & Preflight
requireEnv(["ALLOWED_ORIGINS"]);
const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
  o.trim()
);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Health
app.get(`${BASE}/health`, (req, res) => res.json({ ok: true }));

// Auth
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

// Hilfsfunktion für IMAP-Verbindungen
async function withImap(creds, callback) {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });

  try {
    await client.connect();
    const result = await callback(client);
    return result;
  } finally {
    await client.logout();
  }
}

// Erstellt den Prompt für den Chat (ohne Absenden)
function createAnalysisPrompt(emails, analysisType) {
  const emailData = emails
    .map(
      (email) => `
BETREFF: ${email.subject}
INHALT: ${email.body}
---`
    )
    .join("\n");

  const prompt = `
Analysiere die folgenden E-Mails und erstelle eine FAQ (Frequently Asked Questions) Liste.

REGELN:
- Erstelle maximal 150 FAQ-Einträge
- Keine persönlichen Daten verwenden
- Fasse ähnliche Fragen zusammen
- Verwende klare, verständliche Sprache
- Strukturiere die Antworten logisch

ANALYSE-TYP: ${analysisType || "Allgemein"}

E-MAIL-DATEN (${emails.length} E-Mails):
${emailData}

Erstelle eine JSON-Struktur mit folgendem Format:
{
  "faqs": [
    {
      "id": "unique-id",
      "question": "Frage hier",
      "answer": "Antwort hier",
      "tags": ["tag1", "tag2"],
      "category": "Kategorie"
    }
  ],
  "summary": {
    "totalFaqs": 0,
    "categories": [],
    "analysisType": "${analysisType || "Allgemein"}"
  }
}

Antworte NUR mit der JSON-Struktur, keine zusätzlichen Erklärungen.
`;

  return prompt;
}

async function fetchSubjectsAndBodiesSimple(client, folder) {
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const messageIds = await client.search({ all: true });

      if (!messageIds || messageIds.length === 0) {
        console.log(`📭 Keine Nachrichten in ${folder} gefunden`);
        return [];
      }

      console.log(`📧 ${messageIds.length} Nachrichten in ${folder} gefunden`);
      const emails = [];

      for (const messageId of messageIds) {
        try {
          console.log(`🔍 Verarbeite Nachricht ${messageId}...`);

          const message = await client.fetchOne(messageId, {
            envelope: true,
            source: true, // wichtig, um den Body zu bekommen
          });

          if (!message) {
            console.log(`⚠️ Nachricht ${messageId} ist null`);
            continue;
          }

          const subject = message.envelope?.subject || "Kein Betreff";

          let body = "";
          if (message.source) {
            const parsed = await simpleParser(message.source);
            body = (parsed.text || "").trim();
            if (!body && parsed.html) {
              body = htmlToText(parsed.html, { wordwrap: 0 }).trim();
            }
          }

          emails.push({
            index: messageId,
            subject,
            body,
            bodyLength: body.length,
          });

          console.log(
            `✅ Nachricht ${messageId}: "${subject}" - ${body.length} Zeichen`
          );
        } catch (messageError) {
          console.error(
            `❌ Fehler bei Nachricht ${messageId}:`,
            messageError.message
          );
        }
      }

      return emails;
    } finally {
      lock.release();
    }
  } catch (error) {
    console.error(`❌ Fehler beim Öffnen des Ordners ${folder}:`, error);
    return [];
  }
}

// Vollständige Ollama-Integration mit Cloudflare-Schutz
async function streamOllama({ url, headers, payload, onDelta, onInfo }) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
      ...headers,
    },
    body: JSON.stringify({ ...payload, stream: true }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama API Fehler ${res.status}: ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON nach Zeilen aufteilen
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Rest für nächsten Chunk

    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      let evt;
      try {
        evt = JSON.parse(l);
      } catch {
        continue; // unvollständige Zeile ignorieren
      }

      if (evt.response) onDelta?.(evt.response);
      if (evt.done) {
        onInfo?.(evt); // enthält Stats wie total_duration etc.
        return evt;
      }
    }
  }
}

// --- NEU: Streaming-Version verhindert Cloudflare 524 ---
async function generateFaqsWithAI(taskId, prompt) {
  const analysis = analysisStore.get(taskId);
  if (!analysis) return;

  try {
    analysis.currentStep = "Verbinde mit Ollama (Streaming)…";
    analysis.progress = 5;
    analysisStore.set(taskId, analysis);

    const url = `${OLLAMA_URL}/api/generate`;
    const headers = {
      "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
    };

    const payload = {
      model: OLLAMA_MODEL,
      prompt,
      // WICHTIG: stream wird in streamOllama gesetzt
      options: {
        temperature: 0.7,
        top_p: 0.9,
        // lass max_tokens moderat; zu groß erhöht Latenz
        max_tokens: 3000,
      },
    };

    let assembled = "";
    let tokensSeen = 0;

    const doneInfo = await streamOllama({
      url,
      headers,
      payload,
      onDelta: (chunk) => {
        assembled += chunk;
        tokensSeen += 1;
        // simple Progress-Heuristik (max 90 bis zum Parse-Schritt)
        if (tokensSeen % 25 === 0) {
          analysis.currentStep = `Ollama streamt… (${tokensSeen} Tokens)`;
          analysis.progress = Math.min(90, 5 + Math.floor(tokensSeen / 2));
          analysisStore.set(taskId, analysis);
        }
      },
      onInfo: (info) => {
        // optional: info.total_duration, info.eval_count, …
        analysis.ollamaInfo = info;
      },
    });

    analysis.currentStep = "Antwort verarbeiten…";
    analysis.progress = 92;
    analysisStore.set(taskId, analysis);

    // JSON aus dem zusammengesetzten Text extrahieren
    let faqs = {};
    try {
      const jsonMatch = assembled.match(/\{[\s\S]*\}$/); // greedy bis zum letzten }
      if (!jsonMatch) throw new Error("Kein JSON in Ollama-Antwort gefunden");
      faqs = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error("JSON-Parsing Fehler:", parseError);
      // Fallback
      faqs = {
        faqs: [
          {
            id: "fallback-1",
            question: "E-Mail-Analyse abgeschlossen",
            answer:
              "Die Ollama-Analyse wurde gestreamt, aber die JSON-Antwort konnte nicht vollständig geparst werden. Auszug: " +
              assembled.substring(0, 500),
            tags: ["system"],
            category: "System",
          },
        ],
        summary: {
          totalFaqs: 1,
          categories: ["System"],
          analysisType: analysis.analysisType,
        },
      };
    }

    analysis.currentStep = "FAQ-Generierung abgeschlossen";
    analysis.progress = 100;
    analysis.status = "completed";
    analysis.faqs = faqs;
    analysis.completedAt = new Date().toISOString();
    analysisStore.set(taskId, analysis);

    console.log(
      `✅ Ollama-Analyse (stream) fertig für Task ${taskId}: ${
        faqs.faqs?.length || 0
      } FAQs`
    );
  } catch (error) {
    console.error(
      `❌ Ollama-Analyse fehlgeschlagen für Task ${taskId}:`,
      error
    );
    analysis.status = "error";
    analysis.error = error.message;
    analysis.currentStep = "Fehler bei der Ollama-Analyse";
    analysisStore.set(taskId, analysis);
  }
}

// Router
const r = express.Router();

// 1) IMAP-Creds anlegen
r.post("/imap/credentials", async (req, res) => {
  let { host, port, username, password, tls } = req.body || {};

  // Validierung der Eingabedaten
  if (!host || !port || !username || !password) {
    return res.status(400).json({
      message:
        "Bitte füllen Sie alle Felder aus (Host, Port, Benutzername, Passwort)",
    });
  }

  port = Number(port);

  // Plausibilisierung der Port-Konfiguration
  if (port === 993 && tls !== true) {
    return res.status(400).json({
      message: "Port 993 erfordert TLS. Bitte aktivieren Sie 'TLS verwenden'.",
    });
  }

  if (port === 143 && tls === true) {
    return res.status(400).json({
      message:
        "Port 143 unterstützt kein TLS. Bitte deaktivieren Sie 'TLS verwenden'.",
    });
  }

  try {
    // Teste IMAP-Verbindung
    const client = new ImapFlow({
      host,
      port,
      secure: tls,
      auth: { user: username, pass: password },
      logger: false,
    });

    await client.connect();
    console.log(`✅ IMAP-Verbindung erfolgreich zu ${host}:${port}`);

    // Hole alle Ordner und zähle sie
    const folders = await client.list();
    const totalFolders = folders.length;
    console.log(`📁 ${totalFolders} Ordner gefunden`);

    await client.logout();

    // Erstelle Session
    const sessionId = uuid();
    const sealedCreds = seal({ host, port, username, password, tls });

    credStore.set(sessionId, {
      creds: sealedCreds,
      expiresAt: Date.now() + Number(process.env.IMAP_TTL_SECONDS) * 1000,
      totalFolders: totalFolders,
    });

    console.log(
      `✅ Session ${sessionId} erstellt für ${username}@${host} mit ${totalFolders} Ordnern`
    );

    res.json({
      sessionId,
      ttl: Number(process.env.IMAP_TTL_SECONDS),
      message: "IMAP-Verbindung erfolgreich hergestellt",
      totalFolders: totalFolders,
    });
  } catch (error) {
    console.error("❌ IMAP-Verbindung fehlgeschlagen:", error);

    let userMessage = "Verbindung fehlgeschlagen";
    let details = error.message;

    if (error.code === "ENOTFOUND") {
      userMessage =
        "Host nicht gefunden. Bitte überprüfen Sie die IMAP-Server-Adresse.";
    } else if (error.code === "ECONNREFUSED") {
      userMessage =
        "Verbindung verweigert. Bitte überprüfen Sie Port und TLS-Einstellungen.";
    } else if (error.code === "ETIMEDOUT") {
      userMessage =
        "Verbindung zeitüberschritten. Bitte überprüfen Sie Ihre Internetverbindung.";
    } else if (error.code === "ECONNRESET") {
      userMessage = "Verbindung unterbrochen. Bitte versuchen Sie es erneut.";
    } else if (error.message.includes("Invalid credentials")) {
      userMessage =
        "Ungültige Anmeldedaten. Bitte überprüfen Sie Benutzername und Passwort.";
    } else if (error.message.includes("AUTHENTICATE")) {
      userMessage =
        "Authentifizierung fehlgeschlagen. Bitte überprüfen Sie Ihre Anmeldedaten.";
    } else if (error.message.includes("LOGIN")) {
      userMessage =
        "Login fehlgeschlagen. Bitte überprüfen Sie Benutzername und Passwort.";
    }

    res.status(400).json({ message: userMessage, details });
  }
});

// 2) Ordner scannen
r.post("/imap/scan", async (req, res) => {
  const { sessionId, unseenOnly = false } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ message: "Session-ID erforderlich" });
  }

  const entry = credStore.get(sessionId);
  if (!entry) {
    return res
      .status(404)
      .json({ message: "Session abgelaufen oder nicht gefunden" });
  }

  try {
    const creds = open(entry.creds);
    console.log(`�� Starte Ordner-Scan für ${creds.username}@${creds.host}`);

    const folders = await withImap(creds, async (client) => {
      const allFolders = [];

      try {
        // Hole alle Ordner mit ImapFlow 1.0.93
        const folderList = await client.list();
        console.log(`📁 ${folderList.length} Ordner gefunden`);

        // Verarbeite jeden Ordner
        for (const folder of folderList) {
          try {
            console.log(`�� Verarbeite Ordner: ${folder.path}`);

            // Versuche Ordner zu öffnen und Nachrichten zu zählen
            const lock = await client.getMailboxLock(folder.path);
            try {
              // Zähle Nachrichten im Ordner
              const messageIds = await client.search({ all: true });
              const messageCount = messageIds.length;

              allFolders.push({
                name: folder.path,
                flags: folder.flags || [],
                count: messageCount,
                unseenOnly: unseenOnly,
                error: null,
              });

              console.log(`✅ ${folder.path}: ${messageCount} Nachrichten`);
            } finally {
              lock.release();
            }
          } catch (folderError) {
            console.error(
              `❌ Fehler beim Ordner ${folder.path}:`,
              folderError.message
            );

            // Füge Ordner trotz Fehler hinzu, aber markiere ihn als fehlerhaft
            allFolders.push({
              name: folder.path,
              flags: folder.flags || [],
              count: null,
              unseenOnly: unseenOnly,
              error: `Fehler beim Laden: ${folderError.message}`,
            });
          }
        }
      } catch (listError) {
        console.error("❌ Fehler beim Auflisten der Ordner:", listError);
        throw new Error(`Konnte Ordner nicht auflisten: ${listError.message}`);
      }

      return allFolders;
    });

    // Berechne Gesamtstatistiken
    const validFolders = folders.filter((f) => !f.error && f.count !== null);
    const totalMessages = validFolders.reduce(
      (sum, f) => sum + (f.count || 0),
      0
    );
    const totalFolders = folders.length;

    console.log(
      `✅ Scan abgeschlossen: ${totalFolders} Ordner, ${totalMessages} Nachrichten`
    );

    res.json({
      folders: folders,
      totalFolders: totalFolders,
      totalMessages: totalMessages,
    });
  } catch (error) {
    console.error("❌ Ordner-Scan fehlgeschlagen:", error);
    res.status(500).json({
      message: "Fehler beim Scannen der Ordner: " + error.message,
    });
  }
});

// 3) Manuelles Vergessen der IMAP-Creds
r.delete("/imap/credentials/:sessionId", (req, res) => {
  const entry = credStore.get(req.params.sessionId);
  const owner = req.user?.calentian_entries_id ?? req.user?.id ?? "unknown";

  if (entry && entry.owner !== owner) {
    return res.status(403).json({ message: "Zugriff verweigert" });
  }

  const removed = credStore.delete(req.params.sessionId);
  if (!removed) {
    return res.status(404).json({ message: "Session nicht gefunden" });
  }

  res.status(204).end();
});

// 4) Analyse starten (E-Mail-Extraktion ohne LLM)
r.post("/imap/analyze", async (req, res) => {
  const { sessionId, folders, analysisType } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ message: "Session-ID erforderlich" });
  }

  if (!folders || !Array.isArray(folders) || folders.length === 0) {
    return res
      .status(400)
      .json({ message: "Mindestens ein Ordner muss ausgewählt werden" });
  }

  const entry = credStore.get(sessionId);
  if (!entry) {
    return res
      .status(404)
      .json({ message: "Session abgelaufen oder nicht gefunden" });
  }

  const taskId = uuid();
  const startTime = Date.now();

  try {
    const creds = open(entry.creds);
    console.log(`�� Starte Analyse für ${folders.length} Ordner`);

    // Sammle alle E-Mails aus den ausgewählten Ordnern
    const allEmails = await withImap(creds, async (client) => {
      const emails = [];

      for (const folder of folders) {
        try {
          console.log(`�� Verarbeite Ordner: ${folder}`);

          const folderEmails = await fetchSubjectsAndBodiesSimple(
            client,
            folder
          );
          emails.push(...folderEmails);

          console.log(`✅ ${folder}: ${folderEmails.length} E-Mails gefunden`);
        } catch (folderError) {
          console.error(
            `❌ Fehler beim Ordner ${folder}:`,
            folderError.message
          );
          // Fahre mit anderen Ordnern fort
        }
      }

      return emails;
    });

    const analysisDuration = Date.now() - startTime;

    console.log(
      `📊 Gesamt: ${allEmails.length} E-Mails aus ${folders.length} Ordnern gefunden`
    );
    console.log(`⏱️ Analyse-Dauer: ${analysisDuration}ms`);

    // Erstelle den Prompt für den Chat (ohne Absenden)
    const chatPrompt = createAnalysisPrompt(allEmails, analysisType);

    // Erstelle das Ergebnis-Objekt
    const analysisResult = {
      taskId: taskId,
      analysisType: analysisType,
      folders: folders,
      totalEmails: allEmails.length,
      analysisDuration: analysisDuration,
      emails: allEmails,
      chatPrompt: chatPrompt,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 Stunden
    };

    // Speichere das Ergebnis
    analysisStore.set(taskId, analysisResult);

    console.log(`✅ Analyse abgeschlossen: Task ${taskId}`);

    res.json({
      taskId: taskId,
      message: "Analyse erfolgreich abgeschlossen",
      totalEmails: allEmails.length,
      analysisDuration: analysisDuration,
      chatPrompt: chatPrompt,
    });
  } catch (error) {
    console.error("❌ Analyse fehlgeschlagen:", error);
    res.status(500).json({
      message: "Fehler bei der Analyse: " + error.message,
    });
  }
});

// 5) Status Route für Analyse-Abfrage (ERWEITERT)
r.get("/analysis/:taskId/status", (req, res) => {
  const { taskId } = req.params;
  const analysis = analysisStore.get(taskId);

  if (!analysis) {
    return res.status(404).json({ message: "Analyse nicht gefunden" });
  }

  res.json({
    status: analysis.status || "completed",
    progress: analysis.progress || 100,
    message: analysis.currentStep || "Analyse abgeschlossen",
    totalEmails: analysis.totalEmails,
    analysisDuration: analysis.analysisDuration,
    error: analysis.error || null,
    faqs: analysis.faqs || null,
  });
});

// 6) Analyse-Ergebnisse abrufen
r.get("/analysis/:taskId", (req, res) => {
  const { taskId } = req.params;
  const analysis = analysisStore.get(taskId);

  if (!analysis) {
    return res.status(404).json({ message: "Analyse nicht gefunden" });
  }

  res.json({
    taskId: analysis.taskId,
    createdAt: analysis.createdAt,
    totalEmails: analysis.totalEmails,
    analysisDuration: analysis.analysisDuration,
    emails: analysis.emails,
    chatPrompt: analysis.chatPrompt,
  });
});

// 7) Ollama FAQ-Generierung starten
r.post("/analysis/:taskId/generate-faqs", async (req, res) => {
  const { taskId } = req.params;
  const analysis = analysisStore.get(taskId);

  if (!analysis) {
    return res.status(404).json({ message: "Analyse nicht gefunden" });
  }

  try {
    console.log(`�� Starte Ollama-Analyse für Task ${taskId}...`);
    console.log(`🔐 Verwende Cloudflare-Schutz für Ollama-Zugriff`);

    // Status auf "processing" setzen
    analysis.status = "processing";
    analysis.progress = 0;
    analysis.currentStep = "Ollama-Analyse gestartet";
    analysisStore.set(taskId, analysis);

    // Ollama-Analyse asynchron starten
    generateFaqsWithAI(taskId, analysis.chatPrompt);

    res.json({
      taskId: taskId,
      message: "Ollama-Analyse gestartet",
      status: "processing",
    });
  } catch (error) {
    console.error("❌ Ollama-Analyse-Start fehlgeschlagen:", error);
    res.status(500).json({
      message: "Fehler beim Starten der Ollama-Analyse: " + error.message,
    });
  }
});

// Mount
app.use(BASE, authenticateToken, r);

// Boot
const boot = async () => {
  await initVault();
  requireEnv([
    "PORT",
    "IMAP_ENC_KEY",
    "IMAP_TTL_SECONDS",
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "JWT_SECRET",
    "ALLOWED_ORIGINS",
    "OLLAMA_URL", // NEU: Ollama URL
    "OLLAMA_MODEL", // NEU: Ollama Model
    "CF_ACCESS_CLIENT_ID", // NEU: Cloudflare Client ID
    "CF_ACCESS_CLIENT_SECRET", // NEU: Cloudflare Client Secret
  ]);

  ENC_KEY = Buffer.from(process.env.IMAP_ENC_KEY, "hex");

  // NEU: Ollama Config setzen
  OLLAMA_URL = process.env.OLLAMA_URL;
  OLLAMA_MODEL = process.env.OLLAMA_MODEL;
  CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
  CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

  await initDb();
  app.listen(Number(process.env.PORT), () =>
    console.log(`Calentian AI listening on :${process.env.PORT}${BASE}`)
  );
};

boot().catch((err) => {
  console.error("Boot failed:", err);
  process.exit(1);
});
