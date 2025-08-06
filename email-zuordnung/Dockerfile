FROM node:24-alpine
WORKDIR /app
COPY email-zuordnung/package*.json ./
RUN npm install
COPY email-zuordnung/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 5200
CMD ["npm", "start"]
