FROM node:24-alpine
WORKDIR /app
COPY calentian-ai-service/package*.json ./
RUN npm install
COPY calentian-ai-service/. ./
COPY vault-init.js ./vault-init.js
EXPOSE 7400
CMD ["npm", "start"]
