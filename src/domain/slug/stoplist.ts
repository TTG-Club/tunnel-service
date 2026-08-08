import { existsSync, readFileSync } from 'node:fs';
import type { Logger } from '../../logger.js';
import { fromPackageRoot } from '../../util/paths.js';

export interface StopList {
  /** Слаг содержит запрещённый корень. */
  contains(slug: string): boolean;
  readonly size: number;
}

/** Похожие на буквы цифры: `xy0y` не должен проскакивать мимо `xyoy`. */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

function fold(slug: string): string {
  let result = '';
  for (const char of slug.toLowerCase()) {
    if (char === '-' || char === '_' || char === '.') continue;
    result += LEET[char] ?? char;
  }
  return result;
}

export function createStopList(lines: readonly string[]): StopList {
  const substrings: string[] = [];
  const exact: Set<string> = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // `=слово` — совпадение только целиком, чтобы не ловить ложные срабатывания
    // на безобидных именах. Без `=` — совпадение по подстроке.
    if (line.startsWith('=')) {
      const word = fold(line.slice(1));
      if (word) exact.add(word);
    } else {
      const word = fold(line);
      if (word) substrings.push(word);
    }
  }

  return {
    size: substrings.length + exact.size,
    contains(slug: string): boolean {
      const folded = fold(slug);
      if (exact.has(folded)) return true;
      return substrings.some((word) => folded.includes(word));
    },
  };
}

export const EMPTY_STOP_LIST: StopList = createStopList([]);

/**
 * Читает стоп-лист с диска один раз при старте. Отсутствие файла — не повод
 * не подняться: пишем warning и работаем с пустым списком.
 */
export function loadStopList(path: string, logger: Logger): StopList {
  const absolute = fromPackageRoot(path);

  if (!existsSync(absolute)) {
    logger.warn('стоп-лист не найден, проверка слагов по мату отключена', { path: absolute });
    return EMPTY_STOP_LIST;
  }

  const list = createStopList(readFileSync(absolute, 'utf8').split(/\r?\n/));
  logger.info('стоп-лист загружен', { path: absolute, entries: list.size });
  return list;
}
