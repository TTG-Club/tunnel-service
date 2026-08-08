import { describe, expect, it } from 'vitest';
import type { InsertOutcome, SlugRepository, SlugRow } from '../src/domain/slug/repository.js';
import { SlugAllocationError, buildAccountCandidate, createSlugService } from '../src/domain/slug/service.js';
import { createStopList } from '../src/domain/slug/stoplist.js';
import { capturingLogger } from './helpers.js';

const stopList = createStopList(['huy', 'fuck']);

// account_id — UUID из claim sub токена auth-сервиса.
const ACCOUNT_A = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b';
const ACCOUNT_B = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6c';
const ACCOUNT_C = 'c0ffee00-dead-4bee-8fad-0123456789ab';
const ACCOUNT_D = 'deadbeef-0000-4000-8000-000000000001';

const SALT = 'salt-for-tests-0123456789abcdef';

interface FakeRepository extends SlugRepository {
  readonly rows: SlugRow[];
  /** Сколько раз следующая вставка должна «проиграть гонку». */
  failNextWith(reason: 'slug_taken' | 'owner_has_slug', times: number): void;
  /** Выполняется перед каждой вставкой — сюда вешаем параллельный запрос. */
  hookBeforeInsert(fn: () => void): void;
  /** Кто-то другой уже занял этот адрес. */
  occupy(slug: string, accountId: string): void;
}

/**
 * Репозиторий в памяти, повторяющий ограничения базы: primary key на slug и
 * частичные уникальные индексы «один слаг аккаунта» и «один слаг мира».
 */
function createFakeRepository(): FakeRepository {
  const rows: SlugRow[] = [];
  let forced: { reason: 'slug_taken' | 'owner_has_slug'; times: number } | null = null;
  let beforeInsert: (() => void) | null = null;

  const insert = (row: SlugRow): InsertOutcome => {
    beforeInsert?.();

    if (forced && forced.times > 0) {
      forced.times -= 1;
      return { ok: false, reason: forced.reason };
    }
    if (rows.some((existing) => existing.slug === row.slug)) {
      return { ok: false, reason: 'slug_taken' };
    }
    if (
      row.kind === 'account' &&
      rows.some((existing) => existing.kind === 'account' && existing.accountId === row.accountId)
    ) {
      return { ok: false, reason: 'owner_has_slug' };
    }
    if (
      row.kind === 'world' &&
      rows.some(
        (existing) =>
          existing.kind === 'world' &&
          existing.accountId === row.accountId &&
          existing.worldId === row.worldId,
      )
    ) {
      return { ok: false, reason: 'owner_has_slug' };
    }
    rows.push(row);
    return { ok: true, row };
  };

  return {
    rows,
    failNextWith(reason, times) {
      forced = { reason, times };
    },
    hookBeforeInsert(fn) {
      beforeInsert = fn;
    },
    occupy(slug, accountId) {
      rows.push({
        slug,
        accountId,
        kind: 'account',
        parentSlug: null,
        worldId: null,
        createdAt: new Date(),
      });
    },
    async findAccountSlug(accountId) {
      return rows.find((row) => row.kind === 'account' && row.accountId === accountId) ?? null;
    },
    async findWorldSlug(accountId, worldId) {
      return (
        rows.find(
          (row) => row.kind === 'world' && row.accountId === accountId && row.worldId === worldId,
        ) ?? null
      );
    },
    async listWorldSlugs(accountId) {
      return rows.filter((row) => row.kind === 'world' && row.accountId === accountId);
    },
    async insertAccountSlug(slug, accountId) {
      return insert({ slug, accountId, kind: 'account', parentSlug: null, worldId: null, createdAt: new Date() });
    },
    async insertWorldSlug({ slug, accountId, parentSlug, worldId }) {
      return insert({ slug, accountId, kind: 'world', parentSlug, worldId, createdAt: new Date() });
    },
  };
}

function makeService(repository: SlugRepository, salt = SALT) {
  return createSlugService({ repository, stopList, logger: capturingLogger(), salt });
}

describe('выбор основы для слага', () => {
  it('берёт имя аккаунта как есть', () => {
    expect(buildAccountCandidate('Иван Петров', ACCOUNT_A, stopList, SALT)).toEqual({
      base: 'ivan-petrov',
      forceSuffix: false,
      reason: 'name',
    });
  });

  it('требует суффикс для резервных имён', () => {
    const candidate = buildAccountCandidate('admin', ACCOUNT_A, stopList, SALT);
    expect(candidate).toEqual({ base: 'admin', forceSuffix: true, reason: 'reserved' });
  });

  it('требует суффикс для слишком коротких', () => {
    expect(buildAccountCandidate('Ян', ACCOUNT_A, stopList, SALT)).toEqual({
      base: 'yan',
      forceSuffix: false,
      reason: 'name',
    });
    expect(buildAccountCandidate('О', ACCOUNT_A, stopList, SALT)).toEqual({
      base: 'o',
      forceSuffix: true,
      reason: 'too-short',
    });
  });

  it('мат выбрасывает целиком, а не прикрывает суффиксом', () => {
    const candidate = buildAccountCandidate('Huy', ACCOUNT_D, stopList, SALT);

    expect(candidate.reason).toBe('blocked');
    expect(candidate.forceSuffix).toBe(true);
    expect(candidate.base).not.toContain('huy');
    expect(candidate.base).toMatch(/^u[a-z0-9]{5}$/);
  });

  it('пустое имя заменяет на короткий токен от account_id', () => {
    const candidate = buildAccountCandidate('🐉', ACCOUNT_D, stopList, SALT);

    expect(candidate.reason).toBe('empty');
    expect(candidate.forceSuffix).toBe(true);
    // UUID целиком в адрес не лезет и светить его незачем.
    expect(candidate.base).toMatch(/^u[a-z0-9]{5}$/);
    expect(candidate.base).not.toContain(ACCOUNT_D.slice(0, 8));

    expect(buildAccountCandidate(null, ACCOUNT_D, stopList, SALT).reason).toBe('empty');
  });

  it('запасная основа стабильна при той же соли и меняется при другой', () => {
    const first = buildAccountCandidate(null, ACCOUNT_D, stopList, SALT).base;
    const same = buildAccountCandidate(null, ACCOUNT_D, stopList, SALT).base;
    const other = buildAccountCandidate(null, ACCOUNT_D, stopList, 'совсем-другая-соль-0123456').base;

    expect(same).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe('выдача слага аккаунта', () => {
  it('выдаёт слаг из имени', async () => {
    const repository = createFakeRepository();
    const row = await makeService(repository).ensureAccountSlug(ACCOUNT_A, 'Иван Петров');
    expect(row.slug).toBe('ivan-petrov');
  });

  it('второй раз возвращает уже выданный, а не заводит новый', async () => {
    const repository = createFakeRepository();
    const service = makeService(repository);

    const first = await service.ensureAccountSlug(ACCOUNT_A, 'Иван Петров');
    const second = await service.ensureAccountSlug(ACCOUNT_A, 'Другое Имя');

    expect(second.slug).toBe(first.slug);
    expect(repository.rows).toHaveLength(1);
  });

  it('при занятом адресе добавляет суффикс', async () => {
    const repository = createFakeRepository();
    repository.occupy('ivan', ACCOUNT_C);

    const row = await makeService(repository).ensureAccountSlug(ACCOUNT_A, 'Иван');

    expect(row.slug).not.toBe('ivan');
    expect(row.slug).toMatch(/^ivan-[a-z0-9]{6}$/);
    expect(row.accountId).toBe(ACCOUNT_A);
  });

  it('переживает серию конфликтов подряд', async () => {
    const repository = createFakeRepository();
    repository.failNextWith('slug_taken', 5);

    const row = await makeService(repository).ensureAccountSlug(ACCOUNT_A, 'Иван');

    expect(row.slug).toMatch(/^ivan(-[a-z0-9]{6})?$/);
  });

  it('сдаётся с внятной ошибкой, если свободного адреса нет', async () => {
    const repository = createFakeRepository();
    repository.failNextWith('slug_taken', 100);

    await expect(makeService(repository).ensureAccountSlug(ACCOUNT_A, 'Иван')).rejects.toBeInstanceOf(
      SlugAllocationError,
    );
  });

  it('гонку двух параллельных запросов разрешает в пользу победителя', async () => {
    const repository = createFakeRepository();
    const service = makeService(repository);

    // Пока мы шли от «слага нет» к вставке, параллельный запрос успел завести
    // аккаунту слаг. База отдаёт нарушение уникального индекса, а не даёт
    // второй адрес.
    let raced = false;
    repository.hookBeforeInsert(() => {
      if (raced) return;
      raced = true;
      repository.occupy('ivan-drugoy', ACCOUNT_A);
    });

    const row = await service.ensureAccountSlug(ACCOUNT_A, 'Иван');

    expect(row.slug).toBe('ivan-drugoy');
    expect(repository.rows.filter((r) => r.kind === 'account' && r.accountId === ACCOUNT_A)).toHaveLength(1);
  });

  it('слаг всегда влезает в 30 символов', async () => {
    const repository = createFakeRepository();
    const row = await makeService(repository).ensureAccountSlug(
      ACCOUNT_A,
      'Великий и Ужасный Мастер Подземелий и Драконов',
    );
    expect(row.slug.length).toBeLessThanOrEqual(30);
  });
});

describe('выдача слага мира', () => {
  it('клеит к слагу аккаунта стабильный id мира через дефис', async () => {
    const repository = createFakeRepository();
    const service = makeService(repository);

    const row = await service.ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');

    expect(row.slug).toMatch(/^ivan-[a-z0-9]{6}$/);
    // Дефис, а не точка: wildcard-сертификат покрывает только один уровень.
    expect(row.slug.split('.').length).toBe(1);
  });

  it('один и тот же мир всегда получает тот же адрес', async () => {
    const first = await makeService(createFakeRepository()).ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');
    const second = await makeService(createFakeRepository()).ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');
    expect(second.slug).toBe(first.slug);
  });

  it('суффикс зависит от соли: по своему миру чужой не вычислить', async () => {
    const withSalt = await makeService(createFakeRepository()).ensureWorldSlug(
      ACCOUNT_A,
      'ivan',
      'world-abc',
    );
    const withOtherSalt = await makeService(
      createFakeRepository(),
      'другая-соль-0123456789abcdef',
    ).ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');

    expect(withOtherSalt.slug).not.toBe(withSalt.slug);
  });

  it('уже выданный слаг берётся из базы и от соли не зависит', async () => {
    const repository = createFakeRepository();
    const issued = await makeService(repository).ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');

    // Соль сменили (потеряли и сгенерировали новую) — существующий адрес
    // остаётся прежним, потому что читается из базы.
    const afterSaltChange = await makeService(
      repository,
      'новая-соль-после-потери-старой',
    ).ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');

    expect(afterSaltChange.slug).toBe(issued.slug);
    expect(repository.rows.filter((row) => row.kind === 'world')).toHaveLength(1);
  });

  it('название мира на адрес не влияет — только его id', async () => {
    const repository = createFakeRepository();
    const service = makeService(repository);

    const before = await service.ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');
    // Мир переименовали — id не изменился, значит и ссылка не должна.
    const after = await service.ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-abc');

    expect(after.slug).toBe(before.slug);
    expect(repository.rows.filter((row) => row.kind === 'world')).toHaveLength(1);
  });

  it('разные миры одного аккаунта получают разные адреса', async () => {
    const service = makeService(createFakeRepository());
    const first = await service.ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-1');
    const second = await service.ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-2');
    expect(second.slug).not.toBe(first.slug);
  });

  it('при занятом адресе берёт случайный суффикс вместо стабильного', async () => {
    const repository = createFakeRepository();
    const service = makeService(repository);

    const stable = (await makeService(createFakeRepository()).ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-1'))
      .slug;
    // Тот же адрес уже занят чужим миром.
    repository.rows.push({
      slug: stable,
      accountId: ACCOUNT_B,
      kind: 'world',
      parentSlug: 'ivan',
      worldId: 'other',
      createdAt: new Date(),
    });

    const row = await service.ensureWorldSlug(ACCOUNT_A, 'ivan', 'world-1');

    expect(row.slug).not.toBe(stable);
    expect(row.slug).toMatch(/^ivan-[a-z0-9]{6}$/);
  });

  it('слаг мира влезает в предел метки DNS', async () => {
    const parent = 'a'.repeat(30);
    const row = await makeService(createFakeRepository()).ensureWorldSlug(ACCOUNT_A, parent, 'world-abc');
    expect(row.slug.length).toBeLessThanOrEqual(63);
  });
});
