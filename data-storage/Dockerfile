# Verwende Node.js-Image von Docker Hub
FROM node:20-alpine

# Arbeitsverzeichnis im Container
WORKDIR /app

# Kopiere die package.json und package-lock.json, um Abhängigkeiten zu installieren
COPY package*.json ./

# Installiere die Abhängigkeiten
RUN npm install

# Restliche Dateien kopieren
COPY . .

# Exponiere Port 4200 (wird von Traefik gehandhabt, daher nicht direkt offen)
EXPOSE 4200

# Starte die Anwendung
CMD ["node", "data-storage-service.js"]
