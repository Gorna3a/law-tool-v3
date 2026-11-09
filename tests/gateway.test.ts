/**
 * Tests for gateway client, error classification, Retry-After headers, and CORS detection.
 */

import { describe, it, expect } from 'vitest';
import {
  classify,
  classifyOutputError,
  parseRetryAfterHeader,
  isCorsError,
} from '../src/gateway/errorClassifier';

describe('Error classification', () => {
  it('classifies network fetch failure as TRANSIENT_NETWORK', () => {
    const err = new TypeError('Failed to fetch');
    const classified = classify(err);
    expect(classified.class).toBe('TRANSIENT_NETWORK');
    expect(classified.retryable).toBe(true);
  });

  it('classifies AbortError as TRANSIENT_NETWORK', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    const classified = classify(err);
    expect(classified.class).toBe('TRANSIENT_NETWORK');
    expect(classified.retryable).toBe(true);
  });

  it('classifies 500, 502, 503, 504, 529 as TRANSIENT_UPSTREAM', () => {
    for (const status of [500, 502, 503, 504, 529, 408, 425]) {
      const classified = classify(null, status, 'Gateway error');
      expect(classified.class).toBe('TRANSIENT_UPSTREAM');
      expect(classified.retryable).toBe(true);
    }
  });

  it('classifies 429 as RATE_LIMIT and extracts retry_after', () => {
    const body = JSON.stringify({ error: 'Rate limit exceeded', retry_after: 30 });
    const classified = classify(null, 429, body);
    expect(classified.class).toBe('RATE_LIMIT');
    expect(classified.retryable).toBe(true);
    expect(classified.retryAfterMs).toBe(30_000);
  });

  it('classifies 401 and 403 as non-retryable AUTH', () => {
    const c401 = classify(null, 401, 'Unauthorized');
    expect(c401.class).toBe('AUTH');
    expect(c401.retryable).toBe(false);

    const c403 = classify(null, 403, 'Forbidden');
    expect(c403.class).toBe('AUTH');
    expect(c403.retryable).toBe(false);
  });

  it('classifies 404 or invalid model as CONFIG_MODEL', () => {
    const c404 = classify(null, 404, 'Not found');
    expect(c404.class).toBe('CONFIG_MODEL');
    expect(c404.retryable).toBe(false);

    const c400 = classify(null, 400, 'Invalid model: law-extract-unknown does not exist');
    expect(c400.class).toBe('CONFIG_MODEL');
    expect(c400.retryable).toBe(false);
  });

  it('classifies 413 or image payload error as PAYLOAD (retryable with downscale)', () => {
    const c413 = classify(null, 413, 'Payload Too Large');
    expect(c413.class).toBe('PAYLOAD');
    expect(c413.retryable).toBe(true);

    const c400 = classify(null, 400, 'Image payload size exceeds 20MB limit');
    expect(c400.class).toBe('PAYLOAD');
    expect(c400.retryable).toBe(true);
  });

  it('classifies output truncation, emptiness, and bad JSON', () => {
    expect(classifyOutputError('truncated').class).toBe('TRUNCATED');
    expect(classifyOutputError('empty').class).toBe('EMPTY');
    expect(classifyOutputError('bad_json').class).toBe('BAD_OUTPUT');
  });
});

describe('Retry-After header parsing', () => {
  it('parses seconds value in header', () => {
    const headers = new Headers({ 'retry-after': '45' });
    expect(parseRetryAfterHeader(headers)).toBe(45_000);
  });

  it('returns undefined when header is absent', () => {
    const headers = new Headers();
    expect(parseRetryAfterHeader(headers)).toBeUndefined();
  });
});

describe('CORS error detection', () => {
  it('detects Failed to fetch as possible CORS error', () => {
    expect(isCorsError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not flag non-TypeError as CORS', () => {
    expect(isCorsError(new Error('SyntaxError'))).toBe(false);
  });
});
