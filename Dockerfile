# Locale Engine web app. Build: docker build -t locale-engine .   Run: docker run -p 8080:8080 -v locale-data:/data --env-file .env locale-engine
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY config ./config
COPY prompts ./prompts
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production LOCALE_DATA_DIR=/data LOCALE_WEB_HOST=0.0.0.0 LOCALE_WEB_PORT=8080 LOCALE_WEB_SECURE=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/web/public ./src/web/public
COPY --from=build /app/config ./config
COPY --from=build /app/prompts ./prompts
COPY package.json ./
# the database and every job's files live in /data: mount a persistent volume there
RUN mkdir -p /data
EXPOSE 8080
# runs as root on purpose: a mounted disk (Render, Fly) is owned by root and the app must be able to write the database there
CMD ["node", "dist/web/server.js"]
