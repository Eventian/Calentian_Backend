/***********************************************************************
 * IMAP-Service (IMAP Polling, Mailparser, MySQL, Vault)
 *
 * Pollt Postfach, parst Mails, speichert Inhalte & Anhänge in DB,
 * zieht IMAP- und DB-Credentials sicher aus Vault.
 ***********************************************************************/

import * as dotenv from "dotenv";
import initVault from "./vault-init.js";
import Imap from "imap";
import { simpleParser } from "mailparser";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";

// Vault-Settings & ENV laden
dotenv.config();

const attachmentsDir =
  process.env.ATTACHMENTS_DIR || "/opt/imap-server/attachments";
let dbPool;
let imap;

// 1) Sicherstellen des Attachments-Verzeichnisses
async function ensureAttachmentsDir() {
  try {
    await fs.mkdir(attachmentsDir, { recursive: true });
    console.log(`✅ Attachments-Verzeichnis: ${attachmentsDir}`);
  } catch (err) {
    console.error("❌ Fehler beim Erstellen Attachments-Dir:", err);
  }
}

// 2) DB-Pool initialisieren
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
  console.log("✅ DB-Pool initialisiert");
}

// 3) IMAP-Client erstellen
function initImap() {
  imap = new Imap({
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASSWORD,
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    tls: true,
    keepalive: false,
  });

  imap.once("ready", () => {
    console.log("📬 IMAP ready, starte Polling...");
    pollMailbox();
  });

  imap.once("error", (err) => console.error("IMAP-Fehler:", err));
  imap.once("end", async () => {
    console.log("❌ IMAP-Verbindung beendet");
    if (dbPool) await dbPool.end();
    process.exit(0);
  });

  imap.connect();
}

// 4) Polling-Loop
function pollMailbox() {
  imap.openBox("INBOX", false, (err, box) => {
    if (err) return retryPoll(60000, "Fehler beim Öffnen INBOX", err);
    imap.search(["ALL"], (err, uids) => {
      if (err) return retryPoll(60000, "Fehler bei Suche", err);
      if (!uids.length)
        return retryPoll(30000, "Keine Nachrichten, warte", null, true);

      const newest = Math.max(...uids);
      console.log(`🔍 Neue Mail UID=${newest}`);
      processNewestMail(newest, () => {
        imap.closeBox(true, () => setTimeout(pollMailbox, 1000));
      });
    });
  });
}

function retryPoll(delay, msg, err, close = false) {
  console.warn(`⚠️ ${msg}:`, err);
  if (close) imap.closeBox(false, () => setTimeout(pollMailbox, delay));
  else setTimeout(pollMailbox, delay);
}

// 5) Einzelne Mail verarbeiten
async function processNewestMail(uid, callback) {
  let buffer = "";
  const fetch = imap.fetch([uid], { bodies: "", struct: true, uid: true });

  fetch.on("message", (msg) => {
    msg.on("body", (stream) => stream.on("data", (chunk) => (buffer += chunk)));
  });

  fetch.once("error", (err) => {
    console.error(`❌ FETCH-Fehler UID=${uid}:`, err);
    callback();
  });

  fetch.once("end", async () => {
    try {
      const parsed = await simpleParser(buffer);
      const attachmentPaths = await saveAttachments(parsed.attachments, uid);
      await saveMailToDB(parsed, uid, attachmentPaths);
      await moveMessage(uid, "DONE");
    } catch (err) {
      console.error(`❌ Fehler Verarbeitung UID=${uid}:`, err);
      await moveMessage(uid, "FAILED");
    } finally {
      callback();
    }
  });
}

// 6) Mail verschieben
function moveMessage(uid, box) {
  return new Promise((resolve) => {
    let called = false;
    const timeout = setTimeout(() => {
      if (!called) resolve();
    }, 2000);
    imap.move([uid], box, { uid: true }, (err) => {
      called = true;
      clearTimeout(timeout);
      if (err) console.error(`❌ Move UID=${uid}→${box} Fehler:`, err);
      else console.log(`✅ UID=${uid}→${box}`);
      resolve();
    });
  });
}

// 7) Mail in DB speichern
async function saveMailToDB(parsed, uid, attachments) {
  const subject = parsed.subject || "";
  const text = parsed.text || "";
  const html = parsed.html || `<pre>${text.replace(/</g, "&lt;")}</pre>`;
  const sender = parsed.from?.value?.[0]?.address || "";
  const receiver = parsed.to?.value?.[0]?.address || "";
  const receiverUnparsed = parsed.to?.text || receiver;
  const date = parsed.date
    ? parsed.date.toISOString().slice(0, 19).replace("T", " ")
    : new Date().toISOString().slice(0, 19).replace("T", " ");

  const eidMatch = subject.match(/event[-\s]*id[:\s]*(\d+)/i);
  const eventId = eidMatch ? Number(eidMatch[1]) : null;

  await dbPool.execute(
    `INSERT INTO calentian_kunden_emails
     (subject, body, htmlBody, timestamp, sender, receiver, receiver_unparsed, message_ingoing, calentian_event_entries_id, attachments)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      subject,
      text,
      html,
      date,
      sender,
      receiver,
      receiverUnparsed,
      1,
      eventId,
      attachments.length ? JSON.stringify(attachments) : null,
    ]
  );
  console.log(`💾 Mail UID=${uid} gespeichert, eid=${eventId}`);
}

// 8) Attachments speichern
async function saveAttachments(list, uid) {
  const paths = [];
  for (const a of list) {
    const fname = a.filename || `attachment_${uid}`;
    let dest = path.join(attachmentsDir, fname);
    let cnt = 1;
    const ext = path.extname(fname);
    const base = path.basename(fname, ext);
    while (true) {
      try {
        await fs.access(dest);
        dest = path.join(attachmentsDir, `${base}(${cnt++})${ext}`);
      } catch {
        break;
      }
    }
    await fs.writeFile(dest, a.content);
    const url = `/attachments/${path.basename(dest)}`;
    paths.push(url);
  }
  return paths;
}

// 9) Bootstrap: Vault → Anhänge → DB → IMAP
(async () => {
  try {
    await initVault();
    await ensureAttachmentsDir();
    await initDB();
    initImap();
  } catch (err) {
    console.error("Startup-Error:", err);
    process.exit(1);
  }
})();
