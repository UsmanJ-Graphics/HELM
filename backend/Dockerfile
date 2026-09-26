FROM node:22-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/src ./src
COPY server/fleet.json /server/fleet.json
EXPOSE 3001
CMD ["npm", "run", "start"]
