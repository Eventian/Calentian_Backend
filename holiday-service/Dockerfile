FROM node:24-alpine
WORKDIR /app
COPY holiday-service/package*.json ./
RUN npm install
COPY holiday-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 6600
CMD ["npm", "start"]
