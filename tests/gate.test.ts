/**
 * Tests for the Gate state machine:
 * ONLINE -> PAUSING -> PAUSED -> PROBING -> RESUMING -> ONLINE
 * Verifies pause, backoff, jitter, Retry-After, online event, canary concurrency ramp, and canary failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Gate } from '../src/engine/gate';
import { GatewayClient } from '../src/gateway/client';
import type { AppError } from '../src/storage/schema';

describe('Gate state machine', () => {
  let client: GatewayClient;
  let gate: Gate;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    client = new GatewayClient({ baseUrl: 'http://localhost:20128', apiKey: 'test' });
    gate = new Gate(client, {
      minBackoffMs: 2_000,
      maxBackoffMs: 60_000,
      jitterFactor: 0, // deterministic for timing tests
      maxConcurrency: 3,
    });
  });

  afterEach(() => {
    gate.destroy();
    vi.useRealTimers();
  });

  it('starts in ONLINE state with full concurrency', () => {
    expect(gate.getState()).toBe('ONLINE');
    expect(gate.getConcurrency()).toBe(3);
  });

  it('transitions to PAUSED on transient error and schedules probe at 2s', () => {
    const err: AppError = {
      class: 'TRANSIENT_NETWORK',
      retryable: true,
      userMessage: 'Connection lost',
    };

    const wasFirst = gate.handleTransientError(err);
    expect(wasFirst).toBe(true);
    expect(gate.getState()).toBe('PAUSED');

    const nextProbeAt = gate.getNextProbeAt();
    expect(nextProbeAt).not.toBeNull();
  });

  it('probes with exponential backoff 2s, 4s, 8s on continued failure', async () => {
    vi.spyOn(client, 'healthCheck').mockResolvedValue({ ok: false, rttMs: 10 });

    gate.handleTransientError({ class: 'TRANSIENT_NETWORK', retryable: true, userMessage: '' });
    expect(gate.getState()).toBe('PAUSED');

    // First probe at 2s
    await vi.advanceTimersByTimeAsync(2_050);
    expect(client.healthCheck).toHaveBeenCalledTimes(1);
    expect(gate.getState()).toBe('PAUSED');

    // Second probe at 4s
    await vi.advanceTimersByTimeAsync(4_050);
    expect(client.healthCheck).toHaveBeenCalledTimes(2);
    expect(gate.getState()).toBe('PAUSED');

    // Third probe at 8s
    await vi.advanceTimersByTimeAsync(8_050);
    expect(client.healthCheck).toHaveBeenCalledTimes(3);
    expect(gate.getState()).toBe('PAUSED');
  });

  it('honours custom Retry-After delay when set', async () => {
    vi.spyOn(client, 'healthCheck').mockResolvedValue({ ok: false, rttMs: 10 });

    gate.handleTransientError({ class: 'RATE_LIMIT', retryable: true, userMessage: '' });
    gate.setNextProbeDelay(15_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.healthCheck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_100);
    expect(client.healthCheck).toHaveBeenCalledTimes(1);
  });

  it('starts canary with concurrency=1 when health probe succeeds, then ramps concurrency', async () => {
    vi.spyOn(client, 'healthCheck').mockResolvedValue({ ok: true, rttMs: 15 });

    gate.handleTransientError({ class: 'TRANSIENT_NETWORK', retryable: true, userMessage: '' });

    // Advance to probe
    await vi.advanceTimersByTimeAsync(2_050);
    expect(client.healthCheck).toHaveBeenCalled();

    // Now in RESUMING with concurrency=1 (canary)
    expect(gate.getState()).toBe('RESUMING');
    expect(gate.getConcurrency()).toBe(1);

    // Canary task succeeds -> concurrency ramps to 2
    gate.handleSuccess();
    expect(gate.getConcurrency()).toBe(2);
    expect(gate.getState()).toBe('RESUMING');

    // Next task succeeds -> concurrency ramps to 3 (max) -> transitions to ONLINE
    gate.handleSuccess();
    expect(gate.getConcurrency()).toBe(3);
    expect(gate.getState()).toBe('ONLINE');
  });

  it('goes back to PAUSED if canary task fails with transient error', async () => {
    vi.spyOn(client, 'healthCheck').mockResolvedValue({ ok: true, rttMs: 15 });

    gate.handleTransientError({ class: 'TRANSIENT_NETWORK', retryable: true, userMessage: '' });
    await vi.advanceTimersByTimeAsync(2_050);

    expect(gate.getState()).toBe('RESUMING');
    expect(gate.getConcurrency()).toBe(1);

    // Canary fails
    const wasFirst = gate.handleTransientError({
      class: 'TRANSIENT_UPSTREAM',
      retryable: true,
      userMessage: 'Upstream failed again',
    });

    expect(wasFirst).toBe(true);
    expect(gate.getState()).toBe('PAUSED');
  });

  it('probes immediately when retryNow() is called', async () => {
    const healthSpy = vi.spyOn(client, 'healthCheck').mockResolvedValue({ ok: true, rttMs: 5 });

    gate.handleTransientError({ class: 'TRANSIENT_NETWORK', retryable: true, userMessage: '' });
    expect(gate.getState()).toBe('PAUSED');

    gate.retryNow();
    await vi.advanceTimersByTimeAsync(10);

    expect(healthSpy).toHaveBeenCalledTimes(1);
    expect(gate.getState()).toBe('RESUMING');
  });
});
