import { randomSecret } from '../util/random.js';

/** Общий секрет для /api/internal/*. Тот же самый нужно завести на нодах. */
process.stdout.write(
  [
    '# Общий секрет для служебных эндпоинтов нод.',
    '# Секрет: не коммитить. Одно и то же значение нужно control plane и нодам.',
    '',
    `NODE_SHARED_SECRET=${randomSecret(32)}`,
    '',
  ].join('\n'),
);
