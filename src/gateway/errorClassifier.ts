import type { AppError } from '../storage/schema';

/**
 * Classify any error or HTTP response into an AppError.
 * This is the single authoritative function for error handling.
 */
export function classify(input: unknown, httpStatus?: number, responseBody?: string): AppError {
  // Network-level failures (fetch rejects)
  if (input instanceof TypeError || input instanceof DOMException) {
    const msg = (input as Error).message.toLowerCase();
    if (
      msg.includes('failed to fetch') ||
      msg.includes('networkerror') ||
      msg.includes('load failed') ||
      msg.includes('connection refused') ||
      msg.includes('aborted') ||
      (input instanceof DOMException && input.name === 'AbortError')
    ) {
      return {
        class: 'TRANSIENT_NETWORK',
        retryable: true,
        userMessage: 'Connection to gateway lost. Progress is saved; waiting to reconnect.',
        raw: (input as Error).message,
      };
    }
  }

  // navigator.onLine === false is a hint
  if (!navigator.onLine) {
    return {
      class: 'TRANSIENT_NETWORK',
      retryable: true,
      userMessage: 'Your device appears offline. Progress is saved; will resume when reconnected.',
    };
  }

  const status =
    httpStatus ??
    (typeof input === 'object' && input !== null && 'status' in input
      ? Number((input as { status: unknown }).status)
      : typeof input === 'object' && input !== null && 'statusCode' in input
      ? Number((input as { statusCode: unknown }).statusCode)
      : 0);
  const rawBody =
    responseBody ??
    (typeof input === 'object' && input !== null && 'body' in input
      ? String((input as { body: unknown }).body)
      : typeof input === 'object' && input !== null && 'responseBody' in input
      ? String((input as { responseBody: unknown }).responseBody)
      : '');
  const body = rawBody.toLowerCase();

  // Auth errors
  if (status === 401 || status === 403) {
    const detail = extractErrorMessage(rawBody, `API key rejected or forbidden (HTTP ${status}). Please check your API key in Settings.`);
    return {
      class: 'AUTH',
      retryable: false,
      userMessage: detail,
      httpStatus: status,
      raw: rawBody,
    };
  }

  // Config/model errors
  if (
    status === 404 ||
    (status === 400 &&
      (body.includes('invalid model') ||
        body.includes('model not found') ||
        body.includes('does not exist')))
  ) {
    const detail = extractErrorMessage(rawBody, `Model not found (HTTP ${status}). Please check the model ID in Settings.`);
    return {
      class: 'CONFIG_MODEL',
      retryable: false,
      userMessage: detail,
      httpStatus: status,
      raw: rawBody,
    };
  }

  // Payload too large
  if (status === 413 || (status === 400 && (body.includes('image') || body.includes('payload') || body.includes('size')))) {
    return {
      class: 'PAYLOAD',
      retryable: true, // will downscale
      userMessage: 'Payload too large (HTTP ' + status + '). Automatically reducing image size.',
      httpStatus: status,
    };
  }

  // General 400 Bad Request (e.g. text-only model rejected image or invalid parameters)
  if (status === 400) {
    const detail = extractErrorMessage(rawBody, 'Bad request (HTTP 400). This model might not support vision/image input.');
    return {
      class: 'CONFIG_MODEL',
      retryable: false,
      userMessage: detail,
      httpStatus: status,
      raw: rawBody,
    };
  }

  // Rate limit
  if (status === 429) {
    const retryAfterMs = extractRetryAfterMs(responseBody);
    return {
      class: 'RATE_LIMIT',
      retryable: true,
      userMessage: 'Rate limit reached. Waiting before retrying.',
      retryAfterMs: retryAfterMs ?? 20_000,
      httpStatus: status,
    };
  }

  // Transient upstream errors
  if ([408, 425, 500, 502, 503, 504, 529].includes(status)) {
    const retryAfterMs = extractRetryAfterMs(responseBody);
    return {
      class: 'TRANSIENT_UPSTREAM',
      retryable: true,
      userMessage: `Gateway reachable but models not responding (HTTP ${status}). Waiting to retry.`,
      retryAfterMs,
      httpStatus: status,
    };
  }

  // Bad output (200 but malformed JSON or wrong shape)
  if (status === 200 && body) {
    return {
      class: 'BAD_OUTPUT',
      retryable: true,
      userMessage: 'Model returned an unexpected response format. Retrying with corrective prompt.',
      httpStatus: status,
    };
  }

  // Unexpected
  return {
    class: 'BUG',
    retryable: false,
    userMessage: `Unexpected error (HTTP ${status || 'unknown'}). Please check the event log.`,
    httpStatus: status,
    raw: String(input),
  };
}

export function classifyOutputError(
  kind: 'truncated' | 'empty' | 'bad_json' | 'bad_shape'
): AppError {
  if (kind === 'truncated') {
    return {
      class: 'TRUNCATED',
      retryable: true,
      userMessage: 'Model output was cut off. Retrying with more tokens.',
    };
  }
  if (kind === 'empty') {
    return {
      class: 'EMPTY',
      retryable: true,
      userMessage: 'Model returned empty content. Retrying.',
    };
  }
  return {
    class: 'BAD_OUTPUT',
    retryable: true,
    userMessage: 'Model returned an unexpected response format. Retrying with corrective prompt.',
  };
}

function extractRetryAfterMs(body?: string): number | undefined {
  if (!body) return undefined;
  // Try to parse "retry_after": <seconds> or Retry-After header value embedded in body
  const match = body.match(/"retry_after"\s*:\s*(\d+)/i) ?? body.match(/retry.after.*?(\d+)/i);
  if (match?.[1]) {
    return parseInt(match[1], 10) * 1000;
  }
  return undefined;
}

/** Extract Retry-After header value in ms */
export function parseRetryAfterHeader(headers: Headers): number | undefined {
  const val = headers.get('retry-after');
  if (!val) return undefined;
  const seconds = parseInt(val, 10);
  if (!isNaN(seconds)) return seconds * 1000;
  const date = new Date(val).getTime();
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function isCorsError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const msg = (error as Error).message.toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('cors') ||
    msg.includes('blocked') ||
    msg.includes('cross-origin')
  );
}

function extractErrorMessage(rawBody: string, defaultMsg: string): string {
  if (!rawBody) return defaultMsg;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed?.error?.message) return String(parsed.error.message);
    if (parsed?.error) return typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
    if (parsed?.message) return String(parsed.message);
    if (parsed?.detail) return String(parsed.detail);
  } catch {}
  return rawBody.length < 150 ? rawBody : defaultMsg;
}
