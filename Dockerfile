FROM node:20-alpine

WORKDIR /app

COPY server/package.json ./server/package.json
RUN cd server && npm install --production

COPY server ./server
COPY public ./public

EXPOSE 8080

CMD ["node", "server/server.js"]
