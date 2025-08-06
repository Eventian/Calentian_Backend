FROM node:24-alpine
WORKDIR /app
COPY forms-service/package*.json ./
RUN npm install
COPY forms-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 6200
CMD ["npm", "start"]
