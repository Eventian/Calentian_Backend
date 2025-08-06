FROM node:24-alpine
WORKDIR /app
COPY database-service/package*.json ./
RUN npm install
COPY database-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 4100
CMD ["npm", "start"]
