# Ручная проверка без реальных auth и subscriber

Сценарий на 10 минут: поднять сервис, получить тикет, проверить его подпись,
посмотреть на поведение кэша подписки при аварии биллинга.

Нужны только Node 22 и Docker для Postgres.

## 1. Подготовка

```bash
npm install
cp .env.example .env

npm run keygen        # -> TICKET_PRIVATE_KEY_CURRENT в .env
npm run gen:secret    # -> NODE_SHARED_SECRET в .env
npm run gen:salt      # -> SLUG_SALT в .env (генерируется один раз, не меняется)

docker compose up -d postgres
npm run migrate
```

В `.env` для локального прогона:

```
AUTH_JWKS_URL=                              # пусто — dev-режим без проверки подписи
SUBSCRIBER_BASE_URL=http://localhost:4010   # заглушка вместо subscriber.api
```

Два терминала:

```bash
npm run mock:subscriber   # терминал 1
npm run dev               # терминал 2
```

В логе старта должно быть предупреждение о том, что подпись токенов не
проверяется. Если его нет — вы не в dev-режиме.

## 2. Служебные эндпоинты

```bash
curl -s localhost:3000/health
curl -s localhost:3000/ready
curl -s localhost:3000/.well-known/jwks.json
```

`/ready` должен ответить `200 {"status":"ready"}`. Если `503 reason=database` —
не поднялся Postgres или не накатаны миграции.

## 3. Тикет

```bash
# account_id — UUID, как claim sub у auth-сервиса. Без --sub генерируется
# случайный (сам UUID печатается в stderr).
ACCOUNT=018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b
TOKEN=$(npm run --silent devtoken -- --sub $ACCOUNT --name "Иван Петров")

curl -s -X POST localhost:3000/api/tunnel/ticket \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"worlds":[{"worldId":"world-abc","port":30000}]}'
```

Ожидается `503 no_nodes_available`: ни одна нода ещё не отметилась. Это
правильный отказ — тикет без ноды бесполезен.

Прикидываемся нодой (секрет — из `.env`):

```bash
SECRET=$(grep '^NODE_SHARED_SECRET=' .env | cut -d= -f2-)

curl -s -X POST localhost:3000/api/internal/nodes/heartbeat \
  -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d '{"nodeId":"eu-1","hostname":"eu-1.play.ttg.club","region":"eu","tunnels":0,"streams":0}'
```

Повторяем запрос тикета — теперь он выдаётся. В ответе:

- `account.host` вида `ivan-petrov.play.ttg.club`;
- `hosts[1].host` для мира — `ivan-petrov-<6 символов>.play.ttg.club`,
  **через дефис**, не через точку;
- `expiresAt` через 15 минут.

Проверьте, что адрес закреплён: повторный запрос с тем же `worldId` возвращает
тот же хост, а с другим именем в токене — тот же слаг аккаунта.

## 4. Тикет глазами ноды

Разберите тикет и убедитесь, что нода сможет проверить его по JWKS:

```bash
TICKET=<значение поля ticket>
echo "$TICKET" | cut -d. -f1 | base64 -d           # {"alg":"EdDSA","kid":"…","typ":"JWT"}
echo "$TICKET" | cut -d. -f2 | base64 -d           # sub, slug, node, hosts, limits, tier
curl -s localhost:3000/.well-known/jwks.json       # kid должен совпасть
```

## 5. Ротация ключа

```bash
npm run keygen    # новый ключ
```

В `.env`: старое значение `TICKET_PRIVATE_KEY_CURRENT` перенести в
`TICKET_PRIVATE_KEY_PREVIOUS`, новое положить в `TICKET_PRIVATE_KEY_CURRENT`,
перезапустить `npm run dev`.

Проверка: `/.well-known/jwks.json` отдаёт **два** ключа, ранее выданный тикет
всё ещё проверяется старым `kid`, новые тикеты подписываются новым. Именно это
не даёт ротации оборвать живые туннели.

## 6. Кэш подписки

Три ситуации из задания.

**Свежий кэш.** Дважды подряд запросите `/api/tunnel/status` — в логе заглушки
появится один запрос, в ответе `subscription.source` будет `cache`.

**Сервис лёг, кэш протух.** Уроните заглушку и подождите
`SUBSCRIPTION_CACHE_TTL_SECONDS` (по умолчанию 180 с; для проверки удобно
поставить `SUBSCRIPTION_CACHE_TTL_SECONDS=30`):

```bash
curl -s -X POST localhost:4010/__mock/mode/down
```

Ответ продолжает приходить, `subscription.source` — `stale`, в логе сервиса
warning «использую протухший кэш подписки». Люди продолжают играть.

**Кэша нет вовсе.** Перезапустите сервис (кэш в памяти) при упавшей заглушке и
запросите статус для нового `--sub`: `503 subscription_unavailable` с внятным
сообщением. Вслепую туннель не выдаётся.

Вернуть заглушку: `curl -s -X POST localhost:4010/__mock/mode/ok`.
Проверить отказ по подписке: `curl -s -X POST localhost:4010/__mock/mode/inactive`
→ `403 subscription_inactive`.

## 7. Учёт трафика и квота

```bash
curl -s -X POST localhost:3000/api/internal/usage \
  -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -d "{\"nodeId\":\"eu-1\",\"items\":[{\"accountId\":\"$ACCOUNT\",\"period\":\"2026-08\",\"bytesIn\":\"1000000000\",\"bytesOut\":\"2000000000\"}]}"
```

Повторите тот же запрос дважды и посмотрите `/api/tunnel/status`: `quota.usedGb`
должен быть 3, а не 6 — счётчик накопительный, повтор не удваивает.

Квота тарифа — 10 ТБ в месяц, обычной игрой её не выбрать. Чтобы увидеть
поведение на краю, пришлите заведомо большой расход:

- больше 100 ГБ приростом за один батч — в логе появится запись
  «подозрительно резкий расход трафика» с `suspicious: true`;
- больше 8192 ГБ (80% квоты) и запросите тикет — в логе будет warning
  «расход приблизился к квоте»;
- больше 10240 ГБ — запрос тикета вернёт `403 quota_exceeded`.

Ничего из этого ничего не блокирует автоматически, кроме последнего пункта.

## 7a. Лимит запросов

Дёрните `POST /api/tunnel/ticket` подряд больше `TICKET_RATE_LIMIT_PER_ACCOUNT`
раз (по умолчанию 20 в минуту) — ответом будет `429 rate_limited` с заголовком
`Retry-After`. Для быстрой проверки удобно временно поставить в `.env`
`TICKET_RATE_LIMIT_PER_ACCOUNT=2`.

## 8. Что проверить напоследок

```bash
npm test
npm run typecheck
git status --short          # ничего лишнего
git check-ignore -v .env    # .env под игнором
```
