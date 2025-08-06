FROM node:24-alpine
WORKDIR /app
COPY smtp-service/package*.json ./
RUN npm install
COPY smtp-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 5000
CMD ["npm", "start"]
