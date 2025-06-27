# Basis-Image: Node 18 (alpine ist klein und schnell)
FROM node:20-alpine

# Arbeitsverzeichnis im Container
WORKDIR /app

# Package-Dateien kopieren und Abhängigkeiten installieren
COPY package*.json ./ 
RUN npm install

# Restliche Dateien (imap-service.js, .env etc.) kopieren
COPY . .

# Standardbefehl zum Starten der App
CMD ["node", "imap-service.js"]
