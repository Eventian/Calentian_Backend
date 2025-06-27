/******************************************************
 * imap-service-server.js – Polling-Loop: Verarbeite die neuste Mail
 * mit Event-ID-Extraktion und Speicherung von Anhängen
 ******************************************************/

import Imap from 'imap';
import * as dotenv from 'dotenv';
import { simpleParser } from 'mailparser';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';

dotenv.config();

// Definiere den Pfad zum Attachments-Verzeichnis
const attachmentsDir = '/opt/imap-server/attachments';

// Stelle sicher, dass das Attachments-Verzeichnis existiert
async function ensureAttachmentsDir() {
  try {
    await fs.mkdir(attachmentsDir, { recursive: true });
    console.log(`Attachments-Verzeichnis sichergestellt unter ${attachmentsDir}`);
  } catch (err) {
    console.error('Fehler beim Erstellen des Attachments-Verzeichnisses:', err);
  }
}

// Globaler DB-Pool
let dbPool;

// DB-Pool aufbauen
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
  console.log('Mit der DB verbunden (Pool).');
}

// IMAP-Konfiguration
const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASSWORD,
  host: process.env.IMAP_HOST,
  port: Number(process.env.IMAP_PORT) || 993,  // Standard 993, falls nicht gesetzt
  tls: true,
  keepalive: false, // Deaktiviert Keepalive, da wir den Polling-Prozess selbst steuern
});

// Hauptstart: Zuerst Attachments-Ordner sicherstellen, dann DB verbinden und IMAP starten
(async () => {
  try {
    await ensureAttachmentsDir();
    await initDB();
    console.log('Starte IMAP-Connect...');
    imap.connect();
  } catch (err) {
    console.error('Fehler beim Start:', err);
    process.exit(1);
  }
})();

// Sobald IMAP "ready" ist, starte den Polling-Loop
imap.once('ready', () => {
  console.log('IMAP ready. Starte Polling-Loop...');
  pollMailbox();
});

/**
 * pollMailbox() öffnet den Posteingang, sucht nach allen Nachrichten und
 * verarbeitet jeweils die neueste Mail (höchste UID). Ist der Posteingang leer,
 * wartet es 60 Sekunden und prüft dann erneut.
 */
function pollMailbox() {
  imap.openBox('INBOX', false, (err, box) => {
    if (err) {
      console.error('Fehler beim Öffnen der INBOX:', err);
      return setTimeout(pollMailbox, 60000);
    }
    console.log('INBOX geöffnet. Suche Nachrichten ...');
    imap.search(['ALL'], (err, results) => {
      if (err) {
        console.error('Fehler bei der Suche:', err);
        return setTimeout(pollMailbox, 60000);
      }
      if (!results || results.length === 0) {
        console.log('Posteingang ist leer. Warte 30 Sekunden und prüfe erneut...');
        imap.closeBox(false, () => setTimeout(pollMailbox, 30000));
        return;
      }
      console.log(`Gefundene Nachrichten: ${results.length} UIDs:`, results);
      // Wähle die höchste UID (neueste Mail)
      const newestUID = Math.max(...results);
      console.log(`>>> Verarbeite die neuste Mail mit UID: ${newestUID}`);
      processNewestMail(newestUID, () => {
        // Nach der Verarbeitung: Schließe die Mailbox und starte nach 1 Sekunde neu
        imap.closeBox(true, (closeErr) => {
          if (closeErr) console.error('Fehler beim Schließen der Mailbox:', closeErr);
          console.log('Mailbox geschlossen. Starte neue Suche in 1 Sekunde ...');
          setTimeout(pollMailbox, 1000);
        });
      });
    });
  });
}

/**
 * processNewestMail() verarbeitet eine einzelne Mail:
 * - Abrufen der Mail per UID
 * - Parsen mit simpleParser
 * - Speichern in der DB (inklusive Extraktion der Event-ID)
 * - Speichern der Anhänge in einem lokalen Ordner und Speichern der URL(s) in der DB
 * - Verschieben in den Ordner "DONE" (bei Erfolg) oder "FAILED" (bei DB-Fehler)
 * Nach Abschluss wird der callback() aufgerufen.
 */
function processNewestMail(uid, callback) {
  const f = imap.fetch([uid], { bodies: '', struct: true, uid: true });
  let mailBuffer = '';

  f.on('message', (msg) => {
    console.log(`--- FETCH: Empfange Daten für UID ${uid} ...`);
    msg.on('body', (stream) => {
      stream.on('data', (chunk) => {
        mailBuffer += chunk.toString('utf8');
      });
    });
    msg.once('end', () => {
      console.log(`--- FETCH: UID ${uid} - Empfang beendet, bodyLength=${mailBuffer.length}`);
    });
  });

  f.once('error', (err) => {
    console.error(`!!! FETCH-Fehler bei UID ${uid}:`, err);
    callback();
  });

  f.once('end', async () => {
    console.log(`--- FETCH: 'end'-Event für UID ${uid} - beginne DB-Speicherung...`);
    try {
      const parsed = await simpleParser(mailBuffer);
      // Speichere Anhänge (falls vorhanden) und erhalte ein Array von URL-Pfaden
      let attachmentPaths = [];
      if (parsed.attachments && parsed.attachments.length > 0) {
        attachmentPaths = await saveAttachments(parsed.attachments, uid);
      }
      // Speichere Mail inkl. Event-ID-Extraktion und Attachment-Pfaden in der DB
      await saveMailToDB(parsed, uid, attachmentPaths);
      console.log(`--- DB: UID ${uid} gespeichert. Verschiebe nach "DONE"...`);

      let moveCallbackCalled = false;
      const moveTimeout = setTimeout(() => {
        if (!moveCallbackCalled) {
          console.log("Move-Callback-Timeout erreicht, fahre mit der nächsten Iteration fort...");
          callback();
        }
      }, 2000);

      imap.move([uid], 'DONE', { uid: true }, (moveErr) => {
        moveCallbackCalled = true;
        clearTimeout(moveTimeout);
        console.log(`########## MOVE-CALLBACK für UID ${uid} erreicht`);
        if (moveErr) {
          console.error(`!!! Fehler beim Verschieben UID ${uid}:`, moveErr);
        } else {
          console.log(`>>> UID ${uid} erfolgreich nach "DONE" verschoben.`);
        }
        console.log('########## Nächste Iteration: Weiter zur nächsten Mail ...');
        callback();
      });
    } catch (err) {
      console.error(`!!! Fehler beim Verarbeiten UID ${uid}:`, err);
      console.log(`Verschiebe UID ${uid} in den Ordner "FAILED"...`);
      let moveCallbackCalled = false;
      const moveTimeout = setTimeout(() => {
        if (!moveCallbackCalled) {
          console.log("Move-Callback-Timeout (FAILED) erreicht, fahre mit der nächsten Iteration fort...");
          callback();
        }
      }, 2000);
      imap.move([uid], 'FAILED', { uid: true }, (moveErr) => {
        moveCallbackCalled = true;
        clearTimeout(moveTimeout);
        console.log(`########## MOVE-CALLBACK für UID ${uid} (FAILED) erreicht`);
        if (moveErr) {
          console.error(`!!! Fehler beim Verschieben UID ${uid} in FAILED:`, moveErr);
        } else {
          console.log(`>>> UID ${uid} erfolgreich nach "FAILED" verschoben.`);
        }
        console.log('########## Weiter zur nächsten Mail nach FAILED-Versuch ...');
        callback();
      });
    }
  });
}

/**
 * Speichert die geparste Mail in der DB.
 * Extrahiert dabei optional die Event-ID aus dem Betreff (z.B. "//Event-ID: 26")
 * und speichert die Attachment-URLs als JSON-String.
 */
async function saveMailToDB(parsed, uid, attachmentPaths) {
  const subject = parsed.subject || '';
  const textBody = parsed.text || '';
  const htmlBody = parsed.html
    ? parsed.html
    : `<pre>${textBody.replace(/&/g, '&amp;')
                       .replace(/</g, '&lt;')
                       .replace(/>/g, '&gt;')}</pre>`;
  const sender = (parsed.from && parsed.from.value && parsed.from.value.length > 0)
    ? parsed.from.value[0].address
    : '';
  const receiver = (parsed.to && parsed.to.value && parsed.to.value.length > 0)
    ? parsed.to.value[0].address
    : '';
  // Den unparsierten Empfänger-String aus dem Header auslesen (z.B. "Max Mustermann <max@example.com>")
  const receiverUnparsed = (parsed.to && parsed.to.text) ? parsed.to.text : receiver;
  const mailDate = parsed.date ? new Date(parsed.date) : new Date();

  // Extrahiere Event-ID aus dem Betreff, falls vorhanden
  let eventId = null;
  const eventIdMatch = subject.match(/event[\s-]*id[\s:-]*(\d+)/i);
  if (eventIdMatch) {
    eventId = parseInt(eventIdMatch[1], 10);
    console.log(`Event-ID ${eventId} extrahiert aus Betreff.`);
  } else {
    console.log('Keine Event-ID im Betreff gefunden.');
  }

  console.log(`--- Speichere Mail UID ${uid} in DB:`, {
    subject: subject.substring(0, 50),
    sender,
    receiver,
    receiverUnparsed,
    date: mailDate,
    attachmentPaths,
    eventId,
  });

  await dbPool.execute(
    `INSERT INTO calentian_kunden_emails
       (subject, body, htmlBody, timestamp, sender, receiver, receiver_unparsed, message_ingoing, calentian_event_entries_id, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      subject,
      textBody,
      htmlBody,
      mailDate.toISOString().slice(0, 19).replace('T', ' '),
      sender,
      receiver,
      receiverUnparsed,
      1,  // Da es sich um eingehende Nachrichten handelt
      eventId, // falls vorhanden, oder NULL
      attachmentPaths && attachmentPaths.length > 0 ? JSON.stringify(attachmentPaths) : null,
    ]
  );  
}


/**
 * Speichert alle Anhänge in den Ordner attachmentsDir.
 * Falls der Dateiname schon existiert, wird eine Zahl hinzugefügt.
 * Gibt ein Array mit den relativen URL-Pfaden (z.B. "/attachments/filename") zurück.
 */
async function saveAttachments(attachments, uid) {
  const savedPaths = [];
  for (const attachment of attachments) {
    let originalName = attachment.filename || `attachment_${uid}`;
    let filePath = path.join(attachmentsDir, originalName);

    // Falls die Datei existiert, füge einen Zähler hinzu (ähnlich Windows Explorer)
    let counter = 1;
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    while (true) {
      try {
        await fs.access(filePath);
        // Datei existiert, versuche einen neuen Namen
        filePath = path.join(attachmentsDir, `${baseName}(${counter})${ext}`);
        counter++;
      } catch (err) {
        // Datei existiert nicht, breche die Schleife ab
        break;
      }
    }

    // Schreibe den Anhang (attachment.content ist ein Buffer)
    await fs.writeFile(filePath, attachment.content);
    // Erzeuge einen URL-Pfad. Hier nehmen wir an, dass der Ordner /opt/imap-server/attachments
    // im Webserver als "/attachments" verfügbar ist.
    const urlPath = `/attachments/${path.basename(filePath)}`;
    console.log(`Attachment "${originalName}" gespeichert als "${urlPath}"`);
    savedPaths.push(urlPath);
  }
  return savedPaths;
}

// IMAP Fehler- und End-Events
imap.once('error', (err) => {
  console.error('IMAP Fehler:', err);
});

imap.once('end', () => {
  console.log('IMAP-Verbindung beendet.');
  if (dbPool) {
    dbPool.end().then(() => console.log('DB-Pool geschlossen.'));
  }
});
