FROM node:24-alpine
WORKDIR /app
COPY mail-service/package*.json ./
RUN npm install
COPY mail-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 5300
CMD ["npm", "start"]
