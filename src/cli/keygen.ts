import { generateKeyPairSync } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { TicketAlg } from '../config.js';
import { loadTicketKey } from '../domain/ticket/keys.js';

/**
 * Генерация ключа подписи тикетов.
 *
 * Печатает в stdout и ничего не пишет на диск: файл ключа рядом с репозиторием
 * рано или поздно окажется в коммите. Значение кладётся в .env локально и в
 * переменные окружения Dokploy в бою.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { alg: { type: 'string', default: 'EdDSA' } },
  });

  const alg = values.alg as TicketAlg;
  if (alg !== 'EdDSA' && alg !== 'ES256') {
    process.stderr.write('Поддерживаются только --alg EdDSA и --alg ES256\n');
    process.exit(1);
  }

  const { privateKey } =
    alg === 'EdDSA'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const base64 = Buffer.from(pem, 'utf8').toString('base64');
  const key = await loadTicketKey(base64, alg, 'сгенерированный ключ');

  process.stdout.write(
    [
      `# Новый ключ подписи тикетов (${alg}), kid=${key.kid}`,
      '# Секрет: не коммитить, не пересылать в мессенджерах, не писать в логи.',
      '#',
      '# Первый запуск:  положите значение в TICKET_PRIVATE_KEY_CURRENT',
      '# Ротация:        текущее значение TICKET_PRIVATE_KEY_CURRENT перенесите',
      '#                 в TICKET_PRIVATE_KEY_PREVIOUS, сюда — новое; через сутки',
      '#                 очистите TICKET_PRIVATE_KEY_PREVIOUS.',
      '',
      `TICKET_ALG=${alg}`,
      `TICKET_PRIVATE_KEY_CURRENT=${base64}`,
      '',
    ].join('\n'),
  );
}

await main();
