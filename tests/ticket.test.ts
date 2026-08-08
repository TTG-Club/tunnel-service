import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueTicket, verifyTicket } from '../src/domain/ticket/issue.js';
import { TicketKeyError, createTicketKeyring } from '../src/domain/ticket/keys.js';
import { generateKeyMaterial, makeConfig } from './helpers.js';

// account_id — UUID из claim sub токена auth-сервиса.
const ACCOUNT_ID = '018f3a2b-1c4d-7e8f-9a0b-1c2d3e4f5a6b';

const TICKET_OPTIONS = {
  issuer: 'tunnel.ttg.club',
  audience: 'ttg-tunnel-node',
  ttlSeconds: 900,
};

const INPUT = {
  accountId: ACCOUNT_ID,
  slug: 'ivan',
  nodeId: 'eu-1',
  hosts: ['ivan', 'ivan-a7k2m9'],
  limits: { max_streams: 200, max_worlds: 5, quota_left_gb: 38 },
  tier: 'pro',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('сборка тикета', () => {
  it('кладёт в тикет всё, что нужно ноде', async () => {
    const keyring = await createTicketKeyring(makeConfig());
    const issued = await issueTicket(keyring, TICKET_OPTIONS, INPUT);
    const payload = await verifyTicket(keyring, TICKET_OPTIONS, issued.token);

    expect(payload.sub).toBe(ACCOUNT_ID);
    expect(payload.slug).toBe('ivan');
    expect(payload.node).toBe('eu-1');
    expect(payload.hosts).toEqual(['ivan', 'ivan-a7k2m9']);
    expect(payload.limits).toEqual({ max_streams: 200, max_worlds: 5, quota_left_gb: 38 });
    expect(payload.tier).toBe('pro');
    expect(payload.iss).toBe(TICKET_OPTIONS.issuer);
    expect(payload.aud).toBe(TICKET_OPTIONS.audience);
    expect(payload.exp - payload.iat).toBe(900);
  });

  it('работает и на ES256', async () => {
    const config = makeConfig({
      TICKET_ALG: 'ES256',
      TICKET_PRIVATE_KEY_CURRENT: generateKeyMaterial('ES256'),
    });
    const keyring = await createTicketKeyring(config);
    const issued = await issueTicket(keyring, TICKET_OPTIONS, INPUT);

    expect(keyring.alg).toBe('ES256');
    await expect(verifyTicket(keyring, TICKET_OPTIONS, issued.token)).resolves.toMatchObject({
      slug: 'ivan',
    });
  });

  it('падает при старте, если ключ не того типа, что алгоритм', async () => {
    const config = makeConfig({
      TICKET_ALG: 'ES256',
      TICKET_PRIVATE_KEY_CURRENT: generateKeyMaterial('EdDSA'),
    });
    await expect(createTicketKeyring(config)).rejects.toBeInstanceOf(TicketKeyError);
  });
});

describe('JWKS', () => {
  it('отдаёт только публичную часть ключа', async () => {
    const keyring = await createTicketKeyring(makeConfig());
    const jwks = keyring.jwks();

    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0] as Record<string, unknown>;
    expect(key['kty']).toBe('OKP');
    expect(key['crv']).toBe('Ed25519');
    expect(key['use']).toBe('sig');
    expect(key['alg']).toBe('EdDSA');
    expect(key['kid']).toBe(keyring.signing.kid);
    // Приватная часть в JWKS не должна попасть ни при каких условиях.
    expect(key['d']).toBeUndefined();
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });

  it('kid считается из самого ключа и не зависит от инстанса', async () => {
    const material = generateKeyMaterial();
    const first = await createTicketKeyring(makeConfig({ TICKET_PRIVATE_KEY_CURRENT: material }));
    const second = await createTicketKeyring(makeConfig({ TICKET_PRIVATE_KEY_CURRENT: material }));

    expect(second.signing.kid).toBe(first.signing.kid);
  });
});

describe('ротация ключей', () => {
  it('после ротации старые тикеты продолжают работать', async () => {
    const oldMaterial = generateKeyMaterial();
    const newMaterial = generateKeyMaterial();

    const before = await createTicketKeyring(makeConfig({ TICKET_PRIVATE_KEY_CURRENT: oldMaterial }));
    const oldTicket = await issueTicket(before, TICKET_OPTIONS, INPUT);

    // Шаг ротации: новый ключ подписывает, старый остаётся для проверки.
    const after = await createTicketKeyring(
      makeConfig({
        TICKET_PRIVATE_KEY_CURRENT: newMaterial,
        TICKET_PRIVATE_KEY_PREVIOUS: oldMaterial,
      }),
    );

    expect(after.signing.kid).not.toBe(before.signing.kid);
    expect(after.jwks().keys.map((key) => key.kid)).toEqual([after.signing.kid, before.signing.kid]);

    // Живой туннель с уже выданным тикетом не должен оборваться.
    await expect(verifyTicket(after, TICKET_OPTIONS, oldTicket.token)).resolves.toMatchObject({
      slug: 'ivan',
    });

    const newTicket = await issueTicket(after, TICKET_OPTIONS, INPUT);
    await expect(verifyTicket(after, TICKET_OPTIONS, newTicket.token)).resolves.toMatchObject({
      slug: 'ivan',
    });
  });

  it('после снятия предыдущего ключа старые тикеты отвергаются', async () => {
    const oldMaterial = generateKeyMaterial();
    const newMaterial = generateKeyMaterial();

    const before = await createTicketKeyring(makeConfig({ TICKET_PRIVATE_KEY_CURRENT: oldMaterial }));
    const oldTicket = await issueTicket(before, TICKET_OPTIONS, INPUT);

    const finished = await createTicketKeyring(makeConfig({ TICKET_PRIVATE_KEY_CURRENT: newMaterial }));

    await expect(verifyTicket(finished, TICKET_OPTIONS, oldTicket.token)).rejects.toThrow();
  });

  it('не даёт объявить ротацию, подсунув тот же ключ дважды', async () => {
    const material = generateKeyMaterial();
    expect(() =>
      makeConfig({ TICKET_PRIVATE_KEY_CURRENT: material, TICKET_PRIVATE_KEY_PREVIOUS: material }),
    ).toThrow(/ротация не начата/);
  });
});

describe('проверка тикета', () => {
  it('отвергает подпись чужим ключом', async () => {
    const mine = await createTicketKeyring(makeConfig());
    const alien = await createTicketKeyring(makeConfig({ TICKET_PRIVATE_KEY_CURRENT: generateKeyMaterial() }));
    const forged = await issueTicket(alien, TICKET_OPTIONS, INPUT);

    await expect(verifyTicket(mine, TICKET_OPTIONS, forged.token)).rejects.toThrow();
  });

  it('отвергает просроченный тикет', async () => {
    vi.useFakeTimers();
    const keyring = await createTicketKeyring(makeConfig());
    const issued = await issueTicket(keyring, { ...TICKET_OPTIONS, ttlSeconds: 900 }, INPUT);

    vi.setSystemTime(new Date(Date.now() + 901_000));

    await expect(verifyTicket(keyring, TICKET_OPTIONS, issued.token)).rejects.toThrow();
  });

  it('отвергает тикет, выписанный для другой аудитории', async () => {
    const keyring = await createTicketKeyring(makeConfig());
    const issued = await issueTicket(keyring, { ...TICKET_OPTIONS, audience: 'someone-else' }, INPUT);

    await expect(verifyTicket(keyring, TICKET_OPTIONS, issued.token)).rejects.toThrow();
  });
});
