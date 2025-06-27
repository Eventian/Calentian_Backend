/***********************************************************************
 * E-Mail-Zuordnungs-Service MIT Socket.io-Anbindung (angepasst)
 *
 * 1. Alle Einträge mit status=0 holen
 * 2. Receiver gegen calentian_entries.calentian_mail matchen
 *    → Treffer: setze calentian_entries_id
 *    → kein Treffer: weitermachen
 * 3. Wenn eine calentian_event_entries_id existiert:
 *    a) Lade location_id aus calentian_event_entries
 *    b) Wenn location_id === calentian_entries_id:
 *       i) Wenn schon calentian_kundendaten_id → status=1
 *      ii) Sonst → Adress-Lookup: → status=1 oder 2
 * 4. Wenn keine calentian_event_entries_id:
 *    a) Wenn schon calentian_kundendaten_id → status=3
 *    b) Sonst → Adress-Lookup: → status=3 oder 4
 * 5. Status speichern & Socket-Event absetzen
 * 6. Endlosschleife alle 30 Sekunden
 ***********************************************************************/

import mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';
import { io as ClientIO } from 'socket.io-client';
dotenv.config();

// 1) DB-Pool
let dbPool;
async function initDB() {
  dbPool = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
  });
  console.log('DB-Pool angelegt.');
}

// 2) Socket.io
const socket = ClientIO(process.env.SOCKET_IO_URL || 'http://localhost:5201');
socket.on('connect',       () => console.log('Socket verbunden:', socket.id));
socket.on('connect_error', err => console.error('Socket-Error:', err));

// Hilfs: Status updaten & emitten
async function updateEmailStatus(id, status, extra = {}) {
  await dbPool.query(
    `UPDATE calentian_kunden_emails SET status = ? WHERE id = ?`,
    [status, id]
  );
  socket.emit('mailStatusUpdated', { emailId: id, newStatus: status, ...extra });
}

// Hilfs: Kundendaten-ID finden
async function findKundendatenIdByEmail(address) {
  const [rows] = await dbPool.query(
    `SELECT calentian_kundendaten_id
       FROM calentian_kunden_emails_addresses
      WHERE email = ?
      LIMIT 1`, [address]
  );
  return rows.length ? rows[0].calentian_kundendaten_id : null;
}

// 3) Hauptfunktion
async function runAssignment() {
  console.log('=== Zuordnungs-Lauf:', new Date().toLocaleTimeString());

  // 3.1 Alle Mails mit status=0
  const [mails] = await dbPool.query(`
    SELECT * 
      FROM calentian_kunden_emails
     WHERE status = 0
  `);

  for (const mail of mails) {
    const { 
      id: emailId, receiver, sender, message_ingoing,
      calentian_event_entries_id: eventEntryId,
      calentian_entries_id:      entryIdOld,
      calentian_kundendaten_id:  kundeIdOld
    } = mail;

    let entryId = entryIdOld;
    let kundeId = kundeIdOld;

    console.log(`Verarbeite Mail-ID ${emailId} → receiver=${receiver}`);

    // 3.2 Receiver-Match gegen entries
    {
      const [rows] = await dbPool.query(
        `SELECT id FROM calentian_entries WHERE calentian_mail = ? LIMIT 1`,
        [receiver]
      );
      if (rows.length) {
        entryId = rows[0].id;
        console.log(` → matched entry ${entryId}`);
        await dbPool.query(
          `UPDATE calentian_kunden_emails 
              SET calentian_entries_id = ? 
            WHERE id = ?`,
          [entryId, emailId]
        );
      } else {
        console.log(' → kein Entry-Match');
      }
    }

    // 3.3 Event-Eintrag prüfen
    if (eventEntryId) {
      const [[ev]] = await dbPool.query(
        `SELECT location_id 
           FROM calentian_event_entries 
          WHERE id = ? 
          LIMIT 1`, [eventEntryId]
      );
      if (ev && ev.location_id === entryId) {
        console.log(` → eventEntry ${eventEntryId} passt zu entry ${entryId}`);
        // 3.3.i: schon Kunde?
        if (kundeId) {
          console.log('   → custos vorhanden → status=1');
          await updateEmailStatus(emailId, 1, { entryId, kundeId });
          continue;
        }
        // 3.3.ii: Adress-Lookup
        const lookup = message_ingoing === 1 ? sender : receiver;
        kundeId = await findKundendatenIdByEmail(lookup);
        if (kundeId) {
          console.log(`   → Kunde ${kundeId} gefunden → status=1`);
          await dbPool.query(
            `UPDATE calentian_kunden_emails 
                SET calentian_kundendaten_id = ? 
              WHERE id = ?`,
            [kundeId, emailId]
          );
          await updateEmailStatus(emailId, 1, { entryId, kundeId });
        } else {
          console.log('   → kein Kunde → status=2');
          await updateEmailStatus(emailId, 2, { entryId });
        }
        continue;
      } else {
        console.log(` → eventEntry ${eventEntryId} passt NICHT → weiter`);
      }
    }

    // 3.4 Kein Event-Eintrag oder kein Match
    if (kundeId) {
      console.log(' → schon Kunde → status=3');
      await updateEmailStatus(emailId, 3, { entryId, kundeId });
      continue;
    }
    // 3.4.ii Adress-Lookup
    {
      const lookup = message_ingoing === 1 ? sender : receiver;
      kundeId = await findKundendatenIdByEmail(lookup);
      if (kundeId) {
        console.log(` → Kunde ${kundeId} gefunden → status=3`);
        await dbPool.query(
          `UPDATE calentian_kunden_emails 
              SET calentian_kundendaten_id = ? 
            WHERE id = ?`,
          [kundeId, emailId]
        );
        await updateEmailStatus(emailId, 3, { entryId, kundeId });
      } else {
        console.log(' → kein Kunde → status=4');
        await updateEmailStatus(emailId, 4, { entryId });
      }
    }
  }
}

// 4) Intervall starten
setInterval(runAssignment, 30_000);

// 5) Init
(async () => {
  try {
    await initDB();
    await runAssignment();
  } catch (err) {
    console.error('Startup-Error:', err);
    process.exit(1);
  }
})();
