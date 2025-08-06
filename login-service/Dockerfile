# Verwende Node.js-Image von Docker Hub
FROM node:24-alpine 

# Arbeitsverzeichnis im Container
WORKDIR /app

# Kopiere die package.json und package-lock.json, um Abhängigkeiten zu installieren
COPY login-service/package*.json ./

# Installiere die Abhängigkeiten
RUN npm install

# Restliche Dateien kopieren
COPY login-service/. ./
COPY vault-init.js ./vault-init.js

# Exponiere Port 3000 (wird von Traefik gehandhabt, daher nicht direkt offen)
EXPOSE 3000

# Starte die Anwendung
CMD ["npm", "start"]
