# Basis-Image verwenden (Node.js)
FROM node:20-alpine

# Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# Kopiere die package.json und package-lock.json, um die Abhängigkeiten zu installieren
COPY package*.json ./

# Installiere die Abhängigkeiten
RUN npm install

# Kopiere den gesamten Code ins Arbeitsverzeichnis
COPY . .

# Exponiere den Port, den die Anwendung verwendet
EXPOSE 5300

# Startbefehl für den Container
CMD ["node", "mail-service.js"]