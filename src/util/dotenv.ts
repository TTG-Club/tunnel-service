import { existsSync, readFileSync } from 'node:fs';

const LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * Минимальный загрузчик `.env` для локальной разработки.
 *
 * В production не делает ничего: там переменные приходят из окружения
 * (Dokploy), и подхватывать файл с диска — лишний способ выстрелить в ногу.
 * Уже заданные переменные окружения никогда не перетираются.
 */
export function loadDotEnv(file = '.env'): void {
  if (process.env['NODE_ENV'] === 'production') return;
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = LINE_RE.exec(line);
    if (!match) continue;

    const key = match[1] as string;
    let value = (match[2] as string).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (quoted && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Комментарий в конце незакавыченного значения.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}
