#!/usr/bin/env node
// Проверка развёрнутого control plane снаружи: служебные ручки, боевая цепочка
// «токен -> подписка -> тикет» и отказ подделанным токенам.
//
// Не часть сервиса и не попадает в образ: инструмент для проверки после
// деплоя. Ничего не меняет, кроме одного случая — см. предупреждение ниже.
//
//   node tools/smoke.mjs https://tunnel.api.ttg.club
//   node tools/smoke.mjs https://tunnel.api.ttg.club --login "TTG Test" --password '...'
//
// Без логина и пароля проверяются только неавторизованные ручки. С ними —
// весь путь запроса тикета и девять подделок токена, каждая из которых обязана
// получить 401.
//
// ВНИМАНИЕ: с флагом --ticket скрипт запрашивает настоящий тикет. При успехе
// аккаунту НАВСЕГДА выдаётся слаг. Для боевого аккаунта это безобидно, но
// помнить стоит. Без флага запрос тикета не делается.

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    login: { type: 'string' },
    password: { type: 'string' },
    auth: { type: 'string', default: 'https://auth.api.ttg.club' },
    ticket: { type: 'boolean', default: false },
  },
});

const BASE = (positionals[0] ?? '').replace(/\/+$/, '');
if (!BASE) {
  process.stderr.write(
    'Укажите адрес сервиса:\n' +
      '  node tools/smoke.mjs https://tunnel.api.ttg.club [--login L --password P] [--ticket]\n',
  );
  process.exit(2);
}

const TIMEOUT_MS = 15_000;
let failures = 0;

function check(ok, label, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? '  OK ' : 'ПРОБЛ'}  ${label}${detail ? ' — ' + detail : ''}`);
}

async function call(path, token, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: response.status, body };
}

// --- Служебные ручки: доступны без токена -----------------------------------

console.log(`\n=== СЛУЖЕБНЫЕ РУЧКИ (${BASE}) ===`);

const health = await call('/health');
check(health.status === 200, `GET /health  HTTP ${health.status}`, `версия ${health.body?.version ?? '?'}`);

const ready = await call('/ready');
check(ready.status === 200, `GET /ready  HTTP ${ready.status}`, JSON.stringify(ready.body));
if (ready.status !== 200 && ready.body?.reason === 'database') {
  console.log('        -> база недоступна; миграции: node /app/dist/cli/migrate.js up');
}

// Режим проверки токена виден снаружи и должен совпадать с ожидаемым: `jwks`
// вместо `shared-secret` означает лишний AUTH_JWKS_URL в окружении.
const mode = ready.body?.authMode;
check(mode === 'shared-secret', `режим проверки токена: ${mode ?? '?'}`);

const jwks = await call('/.well-known/jwks.json');
const keyCount = Array.isArray(jwks.body?.keys) ? jwks.body.keys.length : 0;
check(jwks.status === 200 && keyCount > 0, `GET /.well-known/jwks.json  HTTP ${jwks.status}`, `ключей: ${keyCount}`);

// Неизвестный маршрут должен отдавать НАШ JSON. Текстовый «404 page not found»
// означает, что до сервиса не дошло и отвечает reverse proxy.
const unknown = await call('/несуществующий-маршрут');
check(
  unknown.body?.error?.code === 'not_found',
  'неизвестный маршрут обслуживает сам сервис',
  typeof unknown.body === 'string' ? 'отвечает прокси, а не сервис' : '',
);

if (!values.login || !values.password) {
  console.log('\n(без --login и --password проверены только неавторизованные ручки)');
  process.exit(failures ? 1 : 0);
}

// --- Настоящий токен --------------------------------------------------------

console.log('\n=== НАСТОЯЩИЙ ТОКЕН ===');

const auth = await fetch(`${values.auth}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: values.login, password: values.password }),
  signal: AbortSignal.timeout(TIMEOUT_MS),
});
check(auth.ok, `POST ${values.auth}/api/auth/login  HTTP ${auth.status}`);
if (!auth.ok) process.exit(1);

const token = (await auth.json()).accessToken;
const [rawHeader, rawPayload, rawSignature] = token.split('.');
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const header = decode(rawHeader);
const payload = decode(rawPayload);

// Сервис принимает только HS256. Смена алгоритма у auth-сервиса — это отказ
// всем запросам разом, поэтому проверяем явно.
check(header.alg === 'HS256', `алгоритм токена: ${header.alg}`);

// --- Токен и подписка: без побочных эффектов --------------------------------

console.log('\n=== ТОКЕН И ПОДПИСКА ===');

const status = await call('/api/tunnel/status', token);
console.log(`GET /api/tunnel/status  HTTP ${status.status}`);

if (status.status === 200) {
  const subscription = status.body.subscription ?? {};
  check(true, 'токен принят control plane');
  check(true, `подписка: active=${subscription.active} type=${subscription.type} source=${subscription.source}`);
  check(true, `слаг: ${status.body.slug ?? '(ещё не выдан)'}  тариф: ${status.body.tier}`);
  if (!subscription.active) {
    console.log('        -> подписка неактивна: тикет выдан не будет, и это правильно');
  }
} else {
  const code = status.body?.error?.code;
  check(false, `code=${code}`, status.body?.error?.message ?? '');
  const HINTS = {
    unauthorized: 'AUTH_JWT_SECRET не совпадает с JWT_SECRET auth-сервиса',
    subscription_unavailable: 'неверный INTERNAL_SERVICE_SECRET или сломан SUBSCRIBER_STATUS_PATH',
    internal_error: 'смотрите логи по x-request-id; частая причина — не применены миграции',
  };
  if (HINTS[code]) console.log(`        -> ${HINTS[code]}`);
}

// --- Подделки токена --------------------------------------------------------
//
// Все строятся из настоящего токена, поэтому секрет подписи для проверки не
// нужен. Каждая обязана получить 401.

console.log('\n=== ПОДДЕЛКИ ТОКЕНА (все должны получить 401) ===');

const encode = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');

const FORGERIES = [
  ['alg: none, подпись выброшена', `${encode({ alg: 'none', typ: 'JWT' })}.${rawPayload}.`],
  ['alg подменён на HS512', `${encode({ alg: 'HS512', typ: 'JWT' })}.${rawPayload}.${rawSignature}`],
  ['alg подменён на RS256', `${encode({ alg: 'RS256', typ: 'JWT' })}.${rawPayload}.${rawSignature}`],
  ['подменён sub', `${rawHeader}.${encode({ ...payload, sub: '00000000-0000-4000-8000-000000000000' })}.${rawSignature}`],
  ['логин вместо UUID в sub', `${rawHeader}.${encode({ ...payload, sub: 'magistrus' })}.${rawSignature}`],
  ['убран claim username', `${rawHeader}.${encode({ ...payload, username: undefined })}.${rawSignature}`],
  ['истёкший срок действия', `${rawHeader}.${encode({ ...payload, exp: 1_000_000_000 })}.${rawSignature}`],
  ['не JWT', 'garbage-not-a-jwt'],
  ['пустой токен', ''],
];

for (const [name, forged] of FORGERIES) {
  const response = await call('/api/tunnel/status', forged);
  check(response.status === 401, name.padEnd(30), `HTTP ${response.status}`);
}

const noHeader = await call('/api/tunnel/status');
check(noHeader.status === 401, 'без заголовка Authorization'.padEnd(30), `HTTP ${noHeader.status}`);

// --- Тикет: только по явному флагу, заводит слаг навсегда --------------------

if (values.ticket) {
  console.log('\n=== ВЫДАЧА ТИКЕТА ===');

  const ticket = await call('/api/tunnel/ticket', token, {
    method: 'POST',
    body: JSON.stringify({ worlds: [] }),
  });
  const code = ticket.body?.error?.code;
  console.log(`POST /api/tunnel/ticket  HTTP ${ticket.status}${code ? ' ' + code : ''}`);

  if (ticket.status === 200) {
    check(true, `тикет выдан: ${ticket.body.account?.host}, нода ${ticket.body.node?.id}, TTL ${ticket.body.ttlSeconds}с`);
  } else if (code === 'no_nodes_available') {
    // Единственный «отказ», который означает успех: всё до выбора ноды прошло.
    check(true, 'цепочка работает целиком', 'не хватает только живой ноды');
  } else if (code === 'subscription_inactive') {
    check(true, 'токен и подписка проверены', 'у аккаунта нет активной подписки — отказ корректен');
  } else {
    check(false, `code=${code}`, ticket.body?.error?.message ?? '');
  }
} else {
  console.log('\n(запрос тикета пропущен: он заводит слаг навсегда, добавьте --ticket)');
}

console.log(`\n${failures ? `ПРОБЛЕМ: ${failures}` : 'ВСЁ ЗЕЛЁНОЕ'}`);
process.exit(failures ? 1 : 0);
