# tunnel-service

Control plane сервиса туннелей TTG. Решает, кому можно поднять туннель, под
каким публичным адресом и с какими лимитами. **Игровой трафик через сервис не
идёт** — он только выдаёт пропуска (тикеты) и ведёт учёт.

```
Приложение мастера ──запрос тикета──> tunnel-service (этот репозиторий)
                                              │
                                              ├── подписка: subscriber.api.ttg.club
                                              └── проверка JWT: JWKS auth.api.ttg.club

Приложение мастера ──туннель с тикетом──> нода на VDS (отдельный проект)
Игроки ──────────────HTTP/WS────────────> нода
```

## Что делает сервис

- закрепляет за аккаунтом постоянный слаг (`ivan`) и слаги миров
  (`ivan-a7k2m9`), из которых собираются публичные хосты
  `ivan-a7k2m9.play.ttg.club`;
- проверяет JWT пользователя и активность подписки;
- выдаёт короткоживущий тикет (JWT, 15 минут), который нода проверяет локально
  по JWKS, не обращаясь к control plane;
- принимает heartbeat и метрики трафика от нод, считает расход квоты.

Чего сервис **не** делает: не проксирует трафик, не терминирует TLS, не трогает
DNS и сертификаты, не хранит пользователей и не считает деньги.

## Стек

TypeScript (strict, ESM), Node 22, [h3](https://h3.dev) 1.x, PostgreSQL через
`pg`, валидация — Zod, подпись — `jose`, тесты — Vitest. Миграции — обычные
SQL-файлы, применяются отдельной командой.

## Быстрый старт

```bash
npm install
cp .env.example .env

# 1. Ключ подписи тикетов -> вставить в .env как TICKET_PRIVATE_KEY_CURRENT
npm run keygen

# 2. Секрет для нод -> вставить в .env как NODE_SHARED_SECRET
npm run gen:secret

# 3. Локальный Postgres
docker compose up -d postgres

# 4. Миграции (отдельной командой, при старте приложения не применяются)
npm run migrate

# 5. Сервис
npm run dev
```

Проверка:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/.well-known/jwks.json
```

### Как проверить работу без реальных auth и subscriber

Оба внешних сервиса нужны только для двух вещей: подпись токена пользователя и
статус подписки. Обходятся так.

**auth.** Оставьте `AUTH_JWKS_URL` пустым — это dev-режим: токен декодируется
без проверки подписи (на каждый запрос пишется warning). Подойдёт любой JWT с
числовым `sub`, подпись может быть мусорной:

```bash
npm run devtoken -- --sub 12345 --name "Иван Петров"
```

**subscriber.** Поднимите заглушку и укажите её в `.env`:

```bash
npm run mock:subscriber          # http://localhost:4010
# в .env: SUBSCRIBER_BASE_URL=http://localhost:4010
```

Заглушка отвечает `{ "active": true, "registered": true, "expiresAt": ... }` —
без поля `tier`, как настоящий сервис сегодня, — и умеет ломаться по команде
(`POST /__mock/mode/down`), чтобы проверить поведение кэша подписки.

Полный сценарий по шагам: [docs/manual-check.md](docs/manual-check.md).

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | запуск с автоперезагрузкой (tsx) |
| `npm run build` | сборка в `dist/` |
| `npm start` | запуск собранного (`node dist/index.js`) |
| `npm run migrate` | применить неприменённые миграции |
| `npm run migrate:status` | показать, что применено, а что нет |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run keygen` | сгенерировать ключ подписи тикетов (в stdout, не в файл) |
| `npm run gen:secret` | сгенерировать `NODE_SHARED_SECRET` |
| `npm run devtoken` | собрать тестовый пользовательский JWT для dev-режима |
| `npm run mock:subscriber` | заглушка `subscriber.api` на порту 4010 |

В образе Docker те же миграции применяются командой
`node dist/cli/migrate.js up` — отдельным шагом деплоя, не при старте
приложения.

## Переменные окружения

Все конфигурируется только через окружение, валидируется при старте, при
отсутствии обязательной переменной процесс падает с внятным сообщением.
Полный список с комментариями — в [.env.example](.env.example). Кратко:

| Переменная | Обяз. | По умолчанию | Назначение |
|---|---|---|---|
| `NODE_ENV` | нет | `development` | `production` включает строгие проверки старта |
| `HTTP_HOST` / `HTTP_PORT` | нет | `0.0.0.0` / `3000` | слушатель |
| `LOG_LEVEL` | нет | `info` | `debug`/`info`/`warn`/`error` |
| `SHUTDOWN_TIMEOUT_MS` | нет | `15000` | сколько ждать текущие запросы при остановке |
| `DATABASE_URL` | **да** | — | подключение к Postgres |
| `DATABASE_POOL_MAX` | нет | `10` | размер пула |
| `DATABASE_SSL` | нет | `false` | TLS к базе |
| `PUBLIC_DOMAIN` | **да** | — | суффикс публичных хостов, `play.ttg.club` |
| `TICKET_ALG` | нет | `EdDSA` | `EdDSA` или `ES256` |
| `TICKET_TTL_SECONDS` | нет | `900` | срок жизни тикета |
| `TICKET_ISSUER` / `TICKET_AUDIENCE` | нет | `tunnel.ttg.club` / `ttg-tunnel-node` | claim'ы тикета |
| `TICKET_PRIVATE_KEY_CURRENT` | **да** | — | активный ключ подписи, base64(PKCS#8 PEM) |
| `TICKET_PRIVATE_KEY_PREVIOUS` | нет | — | предыдущий ключ на время ротации |
| `AUTH_JWKS_URL` | нет\* | — | пусто = dev-режим без проверки подписи; **обязательна при `NODE_ENV=production`** |
| `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE` | нет | — | ожидаемые iss/aud токена пользователя |
| `AUTH_JWKS_CACHE_SECONDS` | нет | `3600` | кэш JWKS auth-сервиса |
| `AUTH_NAME_CLAIMS` | нет | `name,username,preferred_username,nickname,login` | откуда брать имя для слага |
| `SUBSCRIBER_BASE_URL` | **да** | — | база API подписок |
| `SUBSCRIBER_STATUS_PATH` | нет | `/api/subscriptions/status` | путь статуса |
| `SUBSCRIBER_TIMEOUT_MS` | нет | `3000` | таймаут запроса |
| `SUBSCRIPTION_CACHE_TTL_SECONDS` | нет | `180` | сколько ответ считается свежим |
| `SUBSCRIPTION_STALE_MAX_SECONDS` | нет | `86400` | предел отдачи протухшего кэша при аварии |
| `SUBSCRIPTION_DEFAULT_TIER` | нет | `pro` | тариф, пока `subscriber.api` не отдаёт `tier` |
| `NODE_SHARED_SECRET` | **да** | — | общий секрет для `/api/internal/*`, ≥32 символов |
| `NODE_HEARTBEAT_TIMEOUT_SECONDS` | нет | `90` | после какого молчания нода считается мёртвой |
| `SLUG_STOPLIST_PATH` | нет | `data/stoplist.txt` | файл стоп-листа по мату |

\* формально необязательная, но при `NODE_ENV=production` её отсутствие —
ошибка старта.

## Миграции

SQL-файлы в `migrations/`, имя `NNNN_описание.sql`, применяются по возрастанию
номера. Применённые записываются в таблицу `schema_migrations`. Раннер берёт
advisory-lock, поэтому одновременный запуск на нескольких инстансах безопасен;
каждый файл выполняется в своей транзакции.

```bash
npm run migrate           # применить всё неприменённое
npm run migrate:status    # что применено
```

Правило: **миграции никогда не применяются при старте приложения** — только
отдельной командой в пайплайне деплоя.

## API

Полное описание с примерами запросов — [docs/api.md](docs/api.md).

### Для приложения мастера (`Authorization: Bearer <access token>`)

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/tunnel/ticket` | выдать тикет, ноду и список хостов |
| `GET` | `/api/tunnel/status` | слаг, тариф, расход квоты, срок подписки |

### Для нод (`Authorization: Bearer <NODE_SHARED_SECRET>`)

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/internal/nodes/heartbeat` | нода жива, число туннелей и потоков |
| `POST` | `/api/internal/usage` | батч метрик трафика, идемпотентно |

### Служебные (без авторизации)

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | жив ли процесс |
| `GET` | `/ready` | доступна ли база (и не идёт ли остановка) |
| `GET` | `/.well-known/jwks.json` | публичные ключи для проверки тикетов нодами |

## Ротация ключа подписи

Тикеты живут 15 минут, поэтому ротация делается в два шага и не рвёт живые
туннели.

1. `npm run keygen` — новый ключ.
2. В Dokploy: старое значение `TICKET_PRIVATE_KEY_CURRENT` переносится в
   `TICKET_PRIVATE_KEY_PREVIOUS`, новое кладётся в `TICKET_PRIVATE_KEY_CURRENT`.
   Рестарт. Подпись идёт новым ключом, JWKS отдаёт **оба**, ноды продолжают
   проверять ранее выданные тикеты.
3. Через сутки (заведомо больше TTL тикета и кэша JWKS на нодах)
   `TICKET_PRIVATE_KEY_PREVIOUS` очищается.

`kid` не задаётся руками — он вычисляется как RFC 7638 thumbprint публичного
ключа, поэтому одинаков у всех инстансов и не может разъехаться.

## Безопасность

- Приватные ключи и секреты — только из окружения. В коде, в базе и в
  репозитории их нет.
- Логи структурированные (JSON), проходят через редактор секретов: значения по
  «опасным» ключам (`authorization`, `token`, `secret`, `key`, `password`,
  `cookie`, `ticket`) и любые строки, похожие на JWT, заменяются на `[redacted]`.
  На это есть тест.
- `/api/internal/*` живёт на отдельном префиксе с отдельной авторизацией по
  общему секрету, сравнение — константное по времени.
- Слаг уникален за счёт `primary key` в базе, а не за счёт проверки в коде.

## Лицензия

Приватный проект TTG.
