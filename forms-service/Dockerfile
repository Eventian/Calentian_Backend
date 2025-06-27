# Basis-Image
FROM node:20-alpine

# Arbeitsverzeichnis im Container
WORKDIR /app

# Kopieren der Package.json und package-lock.json (falls vorhanden)
COPY package*.json ./

# Installieren der Abhängigkeiten
RUN npm install

# Kopieren des gesamten Codes in das Arbeitsverzeichnis
COPY . .

# Exponiere den Port 6200
EXPOSE 6200

# Befehl zum Starten des Services
CMD ["npm", "start"]
