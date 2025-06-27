# Verwende Node.js-Image von Docker Hub
FROM node:18

# Arbeitsverzeichnis im Container
WORKDIR /app

# Kopiere die package.json und package-lock.json, um Abhängigkeiten zu installieren
COPY package*.json ./

# Installiere die Abhängigkeiten
RUN npm install

# Restliche Dateien kopieren
COPY . .

# Exponiere Port 3000 (wird von Traefik gehandhabt, daher nicht direkt offen)
EXPOSE 3000

# Starte die Anwendung
CMD ["npm", "start"]
