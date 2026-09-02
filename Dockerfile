FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./

RUN npm ci
COPY . .

RUN npm run build

FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

ENV STORAGE_DIR=/data/images
VOLUME /data/images
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --start-interval=1s \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
