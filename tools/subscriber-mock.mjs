#!/usr/bin/env node
// Заглушка subscriber.api для локальной проверки без настоящего сервиса подписок.
// Не часть сервиса и не попадает в образ: только для ручных проверок.
//
//   npm run mock:subscriber                 -> http://localhost:4010
//   GET  /api/subscriptions/status          -> текущий ответ
//   POST /__mock/mode/{ok|inactive|down|slow}  -> как отвечать дальше
//
// Сценарий кэша подписки: mode=ok, дёрнуть тикет, затем mode=down — первые
// SUBSCRIPTION_CACHE_TTL_SECONDS сервис отвечает из свежего кэша, потом
// начинает отдавать протухший с warning, а после SUBSCRIPTION_STALE_MAX_SECONDS
// откажет.

import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 4010);
let mode = 'ok';

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  if (request.method === 'POST' && url.pathname.startsWith('/__mock/mode/')) {
    mode = url.pathname.split('/').pop();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mode }));
    console.log(`[mock] режим: ${mode}`);
    return;
  }

  if (url.pathname !== '/api/subscriptions/status') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  console.log(`[mock] ${request.method} ${url.pathname} (режим ${mode})`);

  if (mode === 'down') {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'service unavailable' }));
    return;
  }

  const reply = () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        active: mode !== 'inactive',
        registered: true,
        expiresAt: mode === 'inactive' ? null : '2027-01-01T00:00:00.000Z',
        // tier сознательно не отдаём: воспроизводим текущее поведение
        // subscriber.api, где поля ещё нет.
      }),
    );
  };

  if (mode === 'slow') setTimeout(reply, 10_000);
  else reply();
});

server.listen(port, () => {
  console.log(`[mock] subscriber.api слушает http://localhost:${port} (режим ${mode})`);
});
