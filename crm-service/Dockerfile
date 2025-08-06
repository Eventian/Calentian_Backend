FROM node:24-alpine
WORKDIR /app
COPY crm-service/package*.json ./
RUN npm install
COPY crm-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 6203
CMD ["npm", "start"]
