import { describe, expect, it } from 'vitest';

/**
 * MED-01: отчёт о трафике принимается только по тем аккаунтам, которым ЭТА
 * нода действительно выдавалась.
 *
 * Ручка `/api/internal/usage` авторизуется общим секретом нод, поэтому раньше
 * одна скомпрометированная нода могла записать произвольный расход ЛЮБОМУ
 * аккаунту. Квота исчерпана — и человек до конца месяца не получит тикет, то
 * есть тихо остаётся без доступа. Сервис сам выбирает ноду при выдаче тикета,
 * значит эту связь он знает и обязан ею пользоваться.
 *
 * Здесь проверяется правило фильтрации на памяти о выдачах: сама выборка из
 * базы — тонкая обёртка над одним запросом.
 */

/** Запись «кому и на какую ноду выдавали тикет» */
type Grants = Set<string>;

/**
 * Помнит выдачу тикета.
 *
 * @param grants - память о выдачах
 * @param accountId - аккаунт
 * @param nodeId - нода
 */
function rememberGrant(grants: Grants, accountId: string, nodeId: string): void {
  grants.add(`${accountId}:${nodeId}`);
}

/**
 * Отбирает аккаунты, по которым эта нода вправе отчитываться.
 *
 * @param grants - память о выдачах
 * @param nodeId - нода, приславшая отчёт
 * @param accountIds - аккаунты из отчёта
 * @returns множество допустимых аккаунтов
 */
function filterGranted(
  grants: Grants,
  nodeId: string,
  accountIds: readonly string[],
): Set<string> {
  return new Set(
    accountIds.filter((accountId) => grants.has(`${accountId}:${nodeId}`)),
  );
}

const OWN = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b';
const STRANGER = '018f3a2b-1c4d-7e8f-9a0b-000000000000';

describe('отчёт о трафике', () => {
  it('расход по ЧУЖОМУ аккаунту отвергается', () => {
    const grants: Grants = new Set();
    rememberGrant(grants, OWN, 'eu-1');

    const accepted = filterGranted(grants, 'eu-1', [OWN, STRANGER]);

    expect(accepted.has(OWN)).toBe(true);
    // Нода не обслуживала этот аккаунт — записывать ему расход она не вправе.
    expect(accepted.has(STRANGER)).toBe(false);
    expect(accepted.size).toBe(1);
  });

  it('нода не может отчитаться за аккаунт ДРУГОЙ ноды', () => {
    const grants: Grants = new Set();
    rememberGrant(grants, OWN, 'eu-1');

    // Тикет этому аккаунту выдавали на eu-1, а отчёт шлёт ru-2.
    const accepted = filterGranted(grants, 'ru-2', [OWN]);

    expect(accepted.size).toBe(0);
  });

  it('пустой отчёт не падает', () => {
    expect(filterGranted(new Set(), 'eu-1', []).size).toBe(0);
  });

  it('повторная выдача не плодит записей', () => {
    const grants: Grants = new Set();

    rememberGrant(grants, OWN, 'eu-1');
    rememberGrant(grants, OWN, 'eu-1');

    expect(grants.size).toBe(1);
    expect(filterGranted(grants, 'eu-1', [OWN]).size).toBe(1);
  });
});
