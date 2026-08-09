#!/usr/bin/env node
// Заглушка subscriber.api для локальной проверки без настоящего сервиса подписок.
// Не часть сервиса и не попадает в образ: только для ручных проверок.
//
//   npm run mock:subscriber                                    -> http://localhost:4010
//   GET  /api/internal/subscriptions/{username}/status         -> текущий ответ
//   POST /__mock/mode/{ok|inactive|down|slow}                  -> как отвечать дальше
//
// Повторяет боевую ручку: ключ — username в path, авторизация заголовком
// X-Service-Token, ответ — те же пять полей. Неизвестный пользователь получает
// 200 с active:false; 404 отдаётся только на посторонний путь — ровно как у
// настоящего сервиса, где 404 означает «запрос не туда», а не «нет подписки».
//
// Сценарий кэша подписки: mode=ok, дёрнуть тикет, затем mode=down — первые
// SUBSCRIPTION_CACHE_TTL_SECONDS сервис отвечает из свежего кэша, потом
// начинает отдавать протухший с warning, а после SUBSCRIPTION_STALE_MAX_SECONDS
// откажет.

import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 4010);
const expectedToken = process.env.INTERNAL_SERVICE_SECRET ?? '';
let mode = 'ok';

const STATUS_RE = /^\/api\/internal\/subscriptions\/([^/]+)\/status$/;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  const json = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  if (request.method === 'POST' && url.pathname.startsWith('/__mock/mode/')) {
    mode = url.pathname.split('/').pop();
    console.log(`[mock] режим: ${mode}`);
    json(200, { mode });
    return;
  }

  const match = STATUS_RE.exec(url.pathname);
  if (!match) {
    json(404, { error: 'not found' });
    return;
  }

  // Так же, как InternalServiceTokenFilter: без совпадения секрета — 401,
  // до контроллера запрос не доходит.
  const provided = request.headers['x-service-token'];
  if (expectedToken !== '' && provided !== expectedToken) {
    console.log('[mock] неверный X-Service-Token -> 401');
    json(401, { error: 'unauthorized' });
    return;
  }

  // Именно то, ради чего username кодируется: сюда должно приезжать исходное имя.
  const username = decodeURIComponent(match[1]);
  console.log(`[mock] ${request.method} ${url.pathname} username=${username} (режим ${mode})`);

  if (mode === 'down') {
    json(503, { error: 'service unavailable' });
    return;
  }

  const active = mode !== 'inactive';
  const reply = () =>
    json(200, {
      active,
      registered: true,
      expiresAt: active ? '2027-01-01T00:00:00.000Z' : null,
      startsAt: active ? '2026-01-01T00:00:00.000Z' : null,
      type: active ? 'GIFT' : null,
    });

  if (mode === 'slow') setTimeout(reply, 10_000);
  else reply();
});

server.listen(port, () => {
  console.log(`[mock] subscriber.api слушает http://localhost:${port} (режим ${mode})`);
  if (expectedToken === '') {
    console.log('[mock] INTERNAL_SERVICE_SECRET не задан — X-Service-Token не проверяется');
  }
});
