FROM node:24-alpine
WORKDIR /app
COPY notes-service/package*.json ./
RUN npm install
COPY notes-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 6100
CMD ["npm", "start"]
