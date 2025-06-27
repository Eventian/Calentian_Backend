# Node.js Image von Docker Hub verwenden
FROM node:20-alpine

# Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# Kopiere die package.json und package-lock.json, um die Abhängigkeiten zu installieren
COPY package*.json ./ 

# Installiere die Abhängigkeiten
RUN npm install

# Kopiere den restlichen Projektcode
COPY . .

# Starte die Anwendung
CMD ["node", "smtp-service.js"]
