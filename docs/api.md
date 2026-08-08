# API tunnel-service

Все ответы — JSON. Ошибки всегда одной формы:

```json
{ "error": { "code": "quota_exceeded", "message": "…", "details": { } } }
```

`code` предназначен для кода приложения, `message` — для показа человеку,
`details` необязателен. Каждый ответ содержит заголовок `x-request-id`; если
клиент прислал свой, он используется.

Коды ошибок:

| code | HTTP | Когда |
|---|---|---|
| `invalid_request` | 400 | тело не прошло валидацию |
| `unauthorized` | 401 | нет токена, токен неверный или истёк |
| `not_found` | 404 | неизвестный маршрут |
| `payload_too_large` | 413 | тело больше 1 МБ |
| `subscription_inactive` | 403 | подписки нет или она неактивна |
| `worlds_limit_exceeded` | 403 | миров в запросе больше, чем позволяет тариф |
| `quota_exceeded` | 403 | квота трафика за месяц исчерпана |
| `auth_unavailable` | 503 | не смогли забрать JWKS auth-сервиса |
| `subscription_unavailable` | 503 | сервис подписок недоступен и кэша нет |
| `no_nodes_available` | 503 | нет ни одной живой ноды |
| `internal_error` | 500 | всё остальное |

---

## Для приложения мастера

Авторизация: `Authorization: Bearer <access token пользователя>`.

### POST /api/tunnel/ticket

Выдаёт тикет, ноду и раскладку публичных хостов.

Запрос:

```json
{ "worlds": [{ "worldId": "abc123", "port": 30000 }] }
```

`worlds` можно не передавать — тогда будет выдан только слаг аккаунта.
Повторы одного `worldId` схлопываются. Ограничение сверху — 64 записи, но
фактический предел задаёт тариф (`max_worlds`).

Ответ `200`:

```json
{
  "ticket": "eyJhbGciOiJFZERTQSIsImtpZCI6IjF2MGRmWEFN…",
  "issuedAt": "2026-08-08T20:08:24.000Z",
  "expiresAt": "2026-08-08T20:23:24.000Z",
  "ttlSeconds": 900,
  "node": { "id": "eu-1", "hostname": "eu-1.play.ttg.club", "region": "eu" },
  "account": { "slug": "ivan", "host": "ivan.play.ttg.club" },
  "hosts": [
    { "kind": "account", "slug": "ivan", "host": "ivan.play.ttg.club" },
    {
      "kind": "world",
      "slug": "ivan-a7k2m9",
      "host": "ivan-a7k2m9.play.ttg.club",
      "worldId": "abc123",
      "port": 30000
    }
  ],
  "tier": "pro",
  "limits": { "maxStreams": 200, "maxWorlds": 5, "quotaGb": 50, "quotaLeftGb": 38 },
  "subscription": {
    "active": true,
    "registered": true,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "source": "cache"
  }
}
```

`subscription.source` — откуда взят статус подписки: `fresh` (сходили в
subscriber.api), `cache` (свежий кэш), `stale` (протухший кэш, сервис подписок
недоступен). Поле диагностическое, на решение клиента влиять не должно.

Порядок проверок (важен: слаг и тикет не появляются раньше, чем подтверждена
подписка):

1. токен пользователя;
2. активная подписка — иначе `subscription_inactive`;
3. тариф и число миров — иначе `worlds_limit_exceeded`;
4. остаток квоты — иначе `quota_exceeded`;
5. живая нода — иначе `no_nodes_available`;
6. слаги аккаунта и миров;
7. подпись тикета.

### GET /api/tunnel/status

Для интерфейса приложения. Побочных эффектов нет: слаг здесь не выдаётся, до
первого тикета `slug` равен `null`.

```json
{
  "accountId": "12345",
  "slug": "ivan",
  "host": "ivan.play.ttg.club",
  "tier": "pro",
  "limits": { "maxStreams": 200, "maxWorlds": 5, "quotaGb": 50, "quotaLeftGb": 38 },
  "quota": {
    "period": "2026-08",
    "bytesIn": "1000000000",
    "bytesOut": "2000000000",
    "usedGb": 3,
    "quotaGb": 50,
    "leftGb": 47
  },
  "worlds": [{ "worldId": "abc123", "slug": "ivan-a7k2m9", "host": "ivan-a7k2m9.play.ttg.club" }],
  "subscription": { "active": true, "registered": true, "expiresAt": null, "source": "cache" }
}
```

Байты — строки: значения не влезают в JS-число гарантированно только так.

---

## Для нод

Авторизация: `Authorization: Bearer <NODE_SHARED_SECRET>`. Пользовательский JWT
здесь не принимается.

### POST /api/internal/nodes/heartbeat

```json
{
  "nodeId": "eu-1",
  "hostname": "eu-1.play.ttg.club",
  "region": "eu",
  "status": "active",
  "tunnels": 3,
  "streams": 12
}
```

`status`: `active` | `draining` | `down`, по умолчанию `active`. Неизвестная
нода заводится этим же запросом. Нода без heartbeat дольше
`NODE_HEARTBEAT_TIMEOUT_SECONDS` перестаёт получать новые туннели.

Ответ: `{ "ok": true, "node": {…}, "heartbeatTimeoutSeconds": 90 }`.

### POST /api/internal/usage

```json
{
  "nodeId": "eu-1",
  "items": [
    { "accountId": "12345", "period": "2026-08", "bytesIn": "1000000000", "bytesOut": "2000000000" }
  ]
}
```

**Контракт счётчиков — накопительный, а не дельта.** `bytesIn`/`bytesOut` —
сколько всего трафика эта нода пропустила для этого аккаунта с начала периода.
Поэтому повтор батча ничего не удваивает: идемпотентность по
`(node_id, account_id, period)`.

Из этого следует требование к ноде: счётчики надо переживать перезапуском.
Если после рестарта нода начнёт считать с нуля, control plane не уменьшит уже
учтённый расход (значения только растут) — вклад этой ноды за период просто
замрёт до следующего месяца. В ответе такие случаи видны как `regressions`, в
логах — warning.

Числа принимаются и строкой, и числом; строка предпочтительна. До 5000 записей
в батче, тело до 1 МБ.

Ответ: `{ "ok": true, "applied": 2, "accounts": 2, "regressions": 0 }`.

---

## Служебные

Без авторизации.

### GET /health

`{ "status": "ok", "version": "0.1.0", "uptimeSeconds": 42 }` — только
живость процесса, в базу не ходит.

### GET /ready

`200 { "status": "ready", "authMode": "jwks" }` либо `503` с
`{ "status": "unavailable", "reason": "database" }` / `{ "status": "shutting-down" }`.

### GET /.well-known/jwks.json

Публичные ключи **этого** сервиса — по ним ноды проверяют тикеты локально.
Отдаются оба активных ключа (текущий и предыдущий), `Cache-Control: public,
max-age=300`.

```json
{
  "keys": [
    {
      "crv": "Ed25519",
      "x": "DksMhOCTMHK8tXs5c4AON33cp9lOf-jHHIsKmolaui4",
      "kty": "OKP",
      "kid": "1v0dfXAM0VEfgSY5YGkc8K1uIB2F96AtUIJAUDValXc",
      "alg": "EdDSA",
      "use": "sig"
    }
  ]
}
```

---

## Формат тикета

JWT, `EdDSA` (Ed25519) по умолчанию, TTL 15 минут. Заголовок содержит `kid` —
RFC 7638 thumbprint публичного ключа.

```json
{
  "sub": "12345",
  "slug": "ivan",
  "node": "eu-1",
  "hosts": ["ivan", "ivan-a7k2m9"],
  "limits": { "max_streams": 200, "max_worlds": 5, "quota_left_gb": 38 },
  "tier": "pro",
  "iss": "tunnel.ttg.club",
  "aud": "ttg-tunnel-node",
  "jti": "3e97e63f-01e5-43ed-b540-836a27befe67",
  "iat": 1786219704,
  "exp": 1786220604
}
```

`hosts` — метки без домена: что мастеру разрешено регистрировать на ноде.
Полный адрес нода собирает сама, приклеивая свой публичный домен.

Что должна проверять нода: подпись по JWKS (с кэшем и учётом `kid`), `exp`,
`iss`, `aud`, а также что регистрируемый хост входит в `hosts` и что `node`
совпадает с её собственным id.
