FROM node:24-alpine
WORKDIR /app
COPY forms-public-service/package*.json ./
RUN npm install
COPY forms-public-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 6201
CMD ["npm", "start"]
