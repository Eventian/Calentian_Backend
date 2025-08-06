FROM node:24-alpine
WORKDIR /app
COPY database-angebotsgenerator/package*.json ./
RUN npm install
COPY database-angebotsgenerator/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 4150
CMD ["npm", "start"]
