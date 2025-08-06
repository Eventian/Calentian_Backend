FROM node:24-alpine
WORKDIR /app
COPY data-storage/package*.json ./
RUN npm install
COPY data-storage/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 4200
CMD ["npm", "start"]
