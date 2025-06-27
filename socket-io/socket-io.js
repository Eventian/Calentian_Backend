import { Server } from 'socket.io';
import http from 'http';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// Umgebungsvariablen laden
dotenv.config();

// 1) DB-Pool optional initialisieren (falls du was damit tun willst)
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
  console.log('Mit der DB verbunden (Pool).');
}

// 2) HTTP-Server erstellen
const httpServer = http.createServer();

// 3) Socket.IO-Server auf dem HTTP-Server einrichten
const io = new Server(httpServer, {
  cors: {
    origin: 'https://dashboard.calentian.de', // Dein Frontend
    methods: ['GET', 'POST'],
  },
});

// 4) Verbindung/Events
io.on('connection', (socket) => {
  console.log('Client verbunden, Socket-ID:', socket.id);

  // a) Browser-Clients (oder andere Clients) können einem Raum beitreten
  socket.on('joinRoom', ({ room }) => {
    socket.join(room);
    console.log(`Socket ${socket.id} beigetreten Raum ${room}`);
  });

  // b) Hier das Wichtige:
  //    Der Zuordnungs-Service sendet 'mailStatusUpdated' an uns,
  //    wir leiten es an alle Clients weiter
  socket.on('mailStatusUpdated', (data) => {
    console.log('[Socket.IO] mailStatusUpdated empfangen:', data);
    // data könnte sein: { emailId, newStatus, sender, eventId, ... }

    // Das an alle Browser-Clients weiterleiten (Broadcast)
    io.emit('mailStatusUpdated', data);

    // Oder nur an einen bestimmten Raum:
    // io.to('bestimmterRaum').emit('mailStatusUpdated', data);
  });
});

// 5) Server starten. Traefik übernimmt SSL, wir lauschen intern auf Port 5201
const PORT = process.env.PORT || 5201;
httpServer.listen(PORT, async () => {
  // Falls du DB brauchst: await initDB();
  console.log(`WebSocket-Server läuft auf wss://socket.calentian.de:${PORT}`);
});
