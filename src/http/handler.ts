import { timingSafeEqual, createHash } from 'node:crypto';
import { eventHandler, getRequestHeader, readRawBody, setResponseStatus, type EventHandler, type H3Event } from 'h3';
import { z } from 'zod';
import { SlugAllocationError } from '../domain/slug/service.js';
import type { Logger } from '../logger.js';
import type { AppServices } from '../services.js';
import { SubscriberRejectedError, SubscriptionUnavailableError } from '../upstream/subscriber.js';
import type { AuthenticatedUser } from '../upstream/auth.js';
import { ApiError } from './errors.js';

const MAX_BODY_BYTES = 1_000_000;

export function requestLogger(services: AppServices, event: H3Event): Logger {
  const requestId = event.context['requestId'];
  return typeof requestId === 'string' ? services.logger.child({ requestId }) : services.logger;
}

function toApiError(error: unknown, logger: Logger): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof z.ZodError) {
    return ApiError.invalidRequest('Тело запроса не прошло валидацию', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (error instanceof SubscriptionUnavailableError) {
    return ApiError.subscriptionUnavailable(
      'Не удалось проверить подписку: сервис подписок недоступен. Попробуйте позже.',
    );
  }

  if (error instanceof SubscriberRejectedError) {
    return ApiError.subscriptionUnavailable(
      'Сервис подписок отклонил наш запрос. Это на нашей стороне, мы разбираемся.',
    );
  }

  if (error instanceof SlugAllocationError) {
    logger.error('не удалось выдать слаг', { error });
    return ApiError.internal('Не удалось подобрать свободный адрес, попробуйте ещё раз');
  }

  logger.error('необработанная ошибка запроса', { error });
  return ApiError.internal();
}

/**
 * Оборачивает обработчик: ошибки превращаются в предсказуемый JSON
 * `{ error: { code, message } }`, а наружу не утекают подробности внутренних
 * сбоев.
 */
export function apiHandler(
  services: AppServices,
  fn: (event: H3Event) => Promise<unknown>,
): EventHandler {
  return eventHandler(async (event) => {
    try {
      return await fn(event);
    } catch (error) {
      const logger = requestLogger(services, event);
      const apiError = toApiError(error, logger);
      setResponseStatus(event, apiError.status);
      return apiError.toBody();
    }
  });
}

export function getBearerToken(event: H3Event): string {
  const header = getRequestHeader(event, 'authorization');
  if (!header) throw ApiError.unauthorized('Нет заголовка Authorization');

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw ApiError.unauthorized('Ожидается заголовок вида «Authorization: Bearer <токен>»');

  return (match[1] as string).trim();
}

export interface UserContext {
  readonly user: AuthenticatedUser;
  readonly accessToken: string;
}

export async function requireUser(services: AppServices, event: H3Event): Promise<UserContext> {
  const accessToken = getBearerToken(event);
  const user = await services.auth.verify(accessToken);
  event.context['accountId'] = user.accountId;
  return { user, accessToken };
}

/**
 * Авторизация нод — общий секрет из окружения, не пользовательский JWT.
 * Сравнение константное по времени, на входе хэши: длина строк не утекает.
 */
export function requireNodeSecret(services: AppServices, event: H3Event): void {
  const provided = getBearerToken(event);
  const expected = services.config.nodes.sharedSecret;

  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();

  if (!timingSafeEqual(a, b)) {
    throw ApiError.unauthorized('Неверный секрет ноды');
  }
}

export async function readJsonBody<T>(event: H3Event, schema: z.ZodType<T>): Promise<T> {
  const declaredLength = getRequestHeader(event, 'content-length');
  if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Тело запроса слишком большое');
  }

  const raw = await readRawBody(event, 'utf8');
  if (raw !== undefined && Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    throw new ApiError(413, 'payload_too_large', 'Тело запроса слишком большое');
  }

  if (raw === undefined || raw.trim() === '') return schema.parse({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ApiError.invalidRequest('Тело запроса не является корректным JSON');
  }

  return schema.parse(parsed);
}
