/**
 * Коды ошибок API. Приложение мастера различает отказы по `code`,
 * пользователю показывается `message`.
 */
export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'auth_unavailable'
  | 'subscription_inactive'
  | 'subscription_unavailable'
  | 'quota_exceeded'
  | 'worlds_limit_exceeded'
  | 'no_nodes_available'
  | 'slug_allocation_failed'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }

  static invalidRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, 'invalid_request', message, details);
  }

  static unauthorized(message = 'Требуется валидный токен доступа'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message: string): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Не найдено'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(
      429,
      'rate_limited',
      `Слишком много запросов тикета. Попробуйте через ${retryAfterSeconds} с.`,
      { retryAfterSeconds },
    );
  }

  /** Не смогли проверить токен: JWKS auth-сервиса недоступен. Это не вина клиента. */
  static authUnavailable(message: string): ApiError {
    return new ApiError(503, 'auth_unavailable', message);
  }

  static subscriptionInactive(details?: Record<string, unknown>): ApiError {
    return new ApiError(
      403,
      'subscription_inactive',
      'Подписка неактивна: туннель доступен только с активной подпиской',
      details,
    );
  }

  static subscriptionUnavailable(message: string): ApiError {
    return new ApiError(503, 'subscription_unavailable', message);
  }

  static quotaExceeded(details?: Record<string, unknown>): ApiError {
    return new ApiError(403, 'quota_exceeded', 'Квота трафика на текущий период исчерпана', details);
  }

  static worldsLimitExceeded(requested: number, allowed: number): ApiError {
    return new ApiError(
      403,
      'worlds_limit_exceeded',
      `Запрошено миров: ${requested}, тариф допускает ${allowed}`,
      { requested, allowed },
    );
  }

  static noNodesAvailable(): ApiError {
    return new ApiError(
      503,
      'no_nodes_available',
      'Нет доступных нод: попробуйте позже, мы уже знаем о проблеме',
    );
  }

  static internal(message = 'Внутренняя ошибка сервиса'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }
}
