# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Миграции и стоп-лист нужны в рантайме: миграции накатываются при старте
# контейнера (см. CMD внизу), стоп-лист читается при старте приложения.
COPY migrations ./migrations
COPY data ./data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Миграции накатываются ПЕРЕД стартом приложения, в том же контейнере.
#
# Раньше здесь стоял только `node dist/index.js`, а накат числился «отдельным
# шагом деплоя» — шагом, которого в пайплайне не было НИКОГДА. Dokploy
# разворачивает образ, а GitHub Actions до базы не достаёт, так что вешать
# накат было решительно некуда. Кончилось это простоем: миграция
# `0002_ticket_grants` не применилась, туннель отвалился у всех подписчиков.
#
# Одновременный запуск на нескольких инстансах безопасен: раннер берёт
# advisory-lock, каждая миграция идёт в своей транзакции.
#
# Миграция не применилась — приложение НЕ стартует, и это правильно: выкат
# честно падает, Dokploy оставляет работать прежний контейнер. Обслуживать
# трафик на схеме, которую не удалось привести в порядок, хуже.
#
# `exec` обязателен: без него PID 1 остаётся за `sh`, `SIGTERM` не доходит до
# Node, и плавное завершение с дожатием запросов не срабатывает.
CMD ["sh", "-c", "node dist/cli/migrate.js up && exec node dist/index.js"]
