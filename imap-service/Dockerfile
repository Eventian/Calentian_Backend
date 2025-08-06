FROM node:24-alpine
WORKDIR /app
COPY imap-service/package*.json ./
RUN npm install
COPY imap-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 5200
CMD ["npm", "start"]
