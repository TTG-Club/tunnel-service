import { transliterate } from './translit.js';

/** Границы слага аккаунта. */
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 30;

/** Предел метки DNS: слаг мира = слаг аккаунта + дефис + короткий id. */
export const SLUG_MAX_LENGTH_TOTAL = 63;

/** Совпадает с ограничением slugs_format_check в базе. */
export const SLUG_SHAPE_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Имя аккаунта -> кандидат в слаги.
 *
 * NFKD + удаление диакритики, транслитерация кириллицы, нижний регистр,
 * всё кроме [a-z0-9] в дефис, дефисы схлопываются и обрезаются по краям.
 * Может вернуть пустую строку — например, для имени из одних эмодзи.
 */
export function normalizeSlugCandidate(input: string, maxLength = SLUG_MAX_LENGTH): string {
  // Транслитерация идёт до NFKD: иначе `й` распалось бы на `и` + бревис,
  // диакритика бы отвалилась, и получился бы `i` вместо `y`.
  const folded = transliterate(input.toLowerCase())
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');

  let slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length > maxLength) {
    slug = slug.slice(0, maxLength).replace(/-+$/, '');
  }

  return slug;
}

/** Форма слага корректна и длина в допустимых границах. */
export function isValidSlugShape(
  slug: string,
  minLength = SLUG_MIN_LENGTH,
  maxLength = SLUG_MAX_LENGTH_TOTAL,
): boolean {
  return slug.length >= minLength && slug.length <= maxLength && SLUG_SHAPE_RE.test(slug);
}

/**
 * Приклеивает суффикс, ужимая основу так, чтобы результат влез в maxLength.
 * `ivan` + `a7k2m9` -> `ivan-a7k2m9`.
 */
export function withSuffix(base: string, suffix: string, maxLength = SLUG_MAX_LENGTH): string {
  const room = maxLength - suffix.length - 1;
  const trimmed = base.slice(0, Math.max(1, room)).replace(/-+$/, '');
  return `${trimmed}-${suffix}`;
}
