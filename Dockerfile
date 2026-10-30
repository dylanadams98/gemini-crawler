FROM node:24-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV DB_PATH=/app/data/crawler.db
EXPOSE 3000
CMD ["node", "src/server.js"]
