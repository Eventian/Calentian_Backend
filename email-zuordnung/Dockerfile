# Basis-Image verwenden
FROM node:20-alpine

# Arbeitsverzeichnis im Container erstellen
WORKDIR /app

# Kopiere die package.json und package-lock.json, um die Abhängigkeiten zu installieren
COPY package*.json ./

# Installiere die Abhängigkeiten
RUN npm install

# Kopiere den Rest des Codes
COPY . .

# Port freigeben (aber wir machen keine Portweiterleitung, Traefik übernimmt das)
EXPOSE 5200

# Startbefehl für den Container
CMD ["npm", "start"]
