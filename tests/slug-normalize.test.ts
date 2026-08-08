import { describe, expect, it } from 'vitest';
import {
  SLUG_MAX_LENGTH,
  isValidSlugShape,
  normalizeSlugCandidate,
  withSuffix,
} from '../src/domain/slug/normalize.js';
import { isReservedSlug } from '../src/domain/slug/reserved.js';
import { createStopList } from '../src/domain/slug/stoplist.js';
import { transliterate } from '../src/domain/slug/translit.js';

describe('транслитерация', () => {
  it('переводит кириллицу в латиницу', () => {
    expect(transliterate('иван')).toBe('ivan');
    expect(transliterate('щука')).toBe('schuka');
    expect(transliterate('юля')).toBe('yulya');
    expect(transliterate('хорь')).toBe('hor');
    expect(transliterate('цезарь')).toBe('cezar');
  });

  it('не трогает латиницу и цифры', () => {
    expect(transliterate('ivan42')).toBe('ivan42');
  });
});

describe('нормализация кандидата в слаги', () => {
  it('делает из имени аккаунта адрес', () => {
    expect(normalizeSlugCandidate('Иван Петров')).toBe('ivan-petrov');
    expect(normalizeSlugCandidate('  Мастер   Подземелий  ')).toBe('master-podzemeliy');
    expect(normalizeSlugCandidate('DungeonMaster')).toBe('dungeonmaster');
  });

  it('схлопывает и обрезает дефисы', () => {
    expect(normalizeSlugCandidate('--ivan---petrov--')).toBe('ivan-petrov');
    expect(normalizeSlugCandidate('ivan!!!петров')).toBe('ivan-petrov');
  });

  it('снимает диакритику', () => {
    expect(normalizeSlugCandidate('Ñoño Über')).toBe('nono-uber');
    expect(normalizeSlugCandidate('Ёжик')).toBe('ezhik');
  });

  it('отдаёт пустую строку, если от имени ничего не осталось', () => {
    expect(normalizeSlugCandidate('🐉🎲')).toBe('');
    expect(normalizeSlugCandidate('---')).toBe('');
  });

  it('режет по длине и не оставляет дефис на конце', () => {
    const slug = normalizeSlugCandidate('Великий и Ужасный Мастер Подземелий и Драконов');
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(isValidSlugShape(slug)).toBe(true);
  });
});

describe('форма слага', () => {
  it('принимает нормальные адреса', () => {
    expect(isValidSlugShape('ivan')).toBe(true);
    expect(isValidSlugShape('ivan-a7k2m9')).toBe(true);
    expect(isValidSlugShape('a1b')).toBe(true);
  });

  it('отвергает короткие, краевые дефисы и мусор', () => {
    expect(isValidSlugShape('ab')).toBe(false);
    expect(isValidSlugShape('-ivan')).toBe(false);
    expect(isValidSlugShape('ivan-')).toBe(false);
    expect(isValidSlugShape('Ivan')).toBe(false);
    expect(isValidSlugShape('ivan_petrov')).toBe(false);
  });
});

describe('суффикс', () => {
  it('ужимает основу, чтобы влезть в лимит', () => {
    const slug = withSuffix('a'.repeat(40), 'a7k2m9', SLUG_MAX_LENGTH);
    expect(slug.length).toBe(SLUG_MAX_LENGTH);
    expect(slug.endsWith('-a7k2m9')).toBe(true);
    expect(isValidSlugShape(slug)).toBe(true);
  });

  it('не оставляет двойной дефис на стыке', () => {
    expect(withSuffix('ivan-', 'a7k2m9')).toBe('ivan-a7k2m9');
  });
});

describe('резервный список', () => {
  it('держит служебные имена', () => {
    for (const slug of ['www', 'api', 'admin', 'play', 'node', 'status', 'auth', 'jwks']) {
      expect(isReservedSlug(slug), slug).toBe(true);
    }
  });

  it('не мешает обычным именам', () => {
    expect(isReservedSlug('ivan')).toBe(false);
    expect(isReservedSlug('ivan-petrov')).toBe(false);
  });
});

describe('стоп-лист', () => {
  const list = createStopList(['badword', '=exact', '# комментарий', '']);

  it('ловит подстроку', () => {
    expect(list.contains('badword')).toBe(true);
    expect(list.contains('super-badword-42')).toBe(true);
  });

  it('ловит подстановку цифр вместо букв', () => {
    expect(list.contains('b4dw0rd')).toBe(true);
    expect(list.contains('bad-word')).toBe(true);
  });

  it('слова с `=` ловит только целиком', () => {
    expect(list.contains('exact')).toBe(true);
    expect(list.contains('exactly-not')).toBe(false);
  });

  it('пропускает нормальные адреса', () => {
    expect(list.contains('ivan-petrov')).toBe(false);
  });
});
