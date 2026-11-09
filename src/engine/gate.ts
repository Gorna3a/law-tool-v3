/**
 * Gate: Online/Offline state machine for the gateway connection.
 *
 * States: ONLINE -> PAUSING -> PAUSED -> PROBING -> RESUMING -> ONLINE
 *
 * This is the core durable/self-healing component. It:
 * 1. Pauses on first transient failure (stops dispatching, aborts in-flight)
 * 2. Probes with exponential backoff until the gateway is up
 * 3. Runs a canary task before ramping concurrency
 * 4. Resumes automatically; concurrency ramps up +1 per success
 * 5. Never gives up (unless configured to)
 * 6. Persists state to IndexedDB for reload survival
 */

import { appendEvent } from '../storage/repositories';
import type { GatewayClient } from '../gateway/client';
import type { AppError } from '../storage/schema';

export type GateState =
  | 'ONLINE'
  | 'PAUSING'
  | 'PAUSED'
  | 'PROBING'
  | 'RESUMING';

export interface GateConfig {
  minBackoffMs?: number; // default 2000
  maxBackoffMs?: number; // default 60000
  jitterFactor?: number; // default 0.2
  maxConcurrency?: number; // default 2
  stopAfterMs?: number; // default undefined (never)
}

export type GateListener = (state: GateState, nextProbeMs?: number) => void;

export class Gate {
  private state: GateState = 'ONLINE';
  private backoffMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitterFactor: number;
  private readonly maxConcurrency: number;
  private currentConcurrency: number;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextProbeAt: number | null = null;
  private pausedAt: number | null = null;
  private readonly stopAfterMs: number | undefined;
  private listeners: Set<GateListener> = new Set();
  private abortController: AbortController | null = null;
  private onResumeCallback: (() => void) | null = null;

  constructor(
    private readonly client: GatewayClient,
    config: GateConfig = {}
  ) {
    this.minBackoffMs = config.minBackoffMs ?? 2_000;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
    this.jitterFactor = config.jitterFactor ?? 0.2;
    this.maxConcurrency = config.maxConcurrency ?? 2;
    this.currentConcurrency = this.maxConcurrency;
    this.backoffMs = this.minBackoffMs;
    this.stopAfterMs = config.stopAfterMs;

    // Listen for browser online events
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.onBrowserOnline());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.onBrowserOnline();
      });
    }
  }

  getState(): GateState {
    return this.state;
  }

  getConcurrency(): number {
    return this.currentConcurrency;
  }

  getNextProbeAt(): number | null {
    return this.nextProbeAt;
  }

  subscribe(listener: GateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const nextMs = this.nextProbeAt ? Math.max(0, this.nextProbeAt - Date.now()) : undefined;
    this.listeners.forEach((l) => l(this.state, nextMs));
  }

  setOnResume(callback: () => void): void {
    this.onResumeCallback = callback;
  }

  /**
   * Called when a transient error occurs.
   * Returns true if the gate just transitioned to PAUSING (caller should abort all in-flight).
   */
  handleTransientError(error: AppError): boolean {
    if (this.state === 'ONLINE' || this.state === 'RESUMING') {
      this.transitionTo('PAUSING', error);
      return true;
    }
    return false;
  }

  /** Called when a rate limit error occurs - also pauses and adjusts concurrency */
  handleRateLimit(error: AppError): void {
    if (this.state === 'ONLINE' || this.state === 'RESUMING') {
      this.currentConcurrency = Math.max(1, this.currentConcurrency - 1);
      const waitMs = error.retryAfterMs ?? 20_000;
      this.transitionTo('PAUSING', error, waitMs);
    }
  }

  /** Called when a canary task succeeds - ramp up concurrency */
  handleSuccess(): void {
    if (this.state === 'RESUMING') {
      this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 1);
      if (this.currentConcurrency >= this.maxConcurrency) {
        this.transitionTo('ONLINE');
      }
      this.notify();
    } else if (this.state === 'ONLINE') {
      // Slowly restore concurrency after rate limit reductions
      this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 1);
    }
  }

  /** Manually trigger a retry now (from "Retry now" button) */
  retryNow(): void {
    if (this.state === 'PAUSED' || this.state === 'PROBING') {
      this.clearProbeTimer();
      this.probe();
    }
  }

  /** Set gate to PROBING immediately (e.g. on app start when jobs were interrupted) */
  startProbing(): void {
    if (this.state !== 'ONLINE') return;
    this.transitionTo('PROBING');
  }

  private transitionTo(newState: GateState, _error?: AppError, customWaitMs?: number): void {
    const prev = this.state;
    this.state = newState;

    void appendEvent({
      id: crypto.randomUUID(),
      type: newState === 'PAUSING'
        ? 'gate_pausing'
        : newState === 'PAUSED'
        ? 'gate_paused'
        : newState === 'PROBING'
        ? 'gate_probing'
        : 'gate_resumed',
      message: `Gate: ${prev} -> ${newState}`,
      data: { prev, next: newState },
      timestamp: Date.now(),
    });

    if (newState === 'PAUSING') {
      // Abort all in-flight requests
      this.client.abortAll();
      this.abortController = this.client.createAbortGroup();
      this.pausedAt = Date.now();
      this.transitionTo('PAUSED');
    } else if (newState === 'PAUSED') {
      this.scheduleProbe(customWaitMs ?? this.backoffMs);
    } else if (newState === 'ONLINE') {
      this.backoffMs = this.minBackoffMs;
      this.pausedAt = null;
      this.clearProbeTimer();
      void appendEvent({
        id: crypto.randomUUID(),
        type: 'gate_resumed',
        message: 'Gateway connection restored. Resuming work.',
        timestamp: Date.now(),
      });
      if (this.onResumeCallback) this.onResumeCallback();
    }

    this.notify();
  }

  private scheduleProbe(delayMs: number): void {
    this.clearProbeTimer();

    // Check stop condition
    if (this.stopAfterMs && this.pausedAt) {
      if (Date.now() - this.pausedAt > this.stopAfterMs) {
        // Gave up
        this.state = 'PAUSED';
        this.notify();
        return;
      }
    }

    const jitter = delayMs * this.jitterFactor * (Math.random() * 2 - 1);
    const wait = Math.max(0, delayMs + jitter);
    this.nextProbeAt = Date.now() + wait;
    this.notify();

    this.probeTimer = setTimeout(() => {
      this.probe();
    }, wait);
  }

  private async probe(): Promise<void> {
    if (this.state !== 'PAUSED' && this.state !== 'PROBING') return;
    this.state = 'PROBING';
    this.nextProbeAt = null;
    this.notify();

    void appendEvent({
      id: crypto.randomUUID(),
      type: 'gate_probing',
      message: 'Probing gateway...',
      timestamp: Date.now(),
    });

    const { ok } = await this.client.healthCheck();

    if (!ok) {
      // Back off
      this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
      this.state = 'PAUSED';
      this.scheduleProbe(this.backoffMs);
      this.notify();
      return;
    }

    // Health ok - start canary
    this.state = 'RESUMING';
    this.currentConcurrency = 1; // canary: only 1 task at a time to start

    void appendEvent({
      id: crypto.randomUUID(),
      type: 'gate_canary_start',
      message: 'Gateway reachable. Running canary task with concurrency=1.',
      timestamp: Date.now(),
    });

    // The scheduler will pick up from here with concurrency=1
    // and call handleSuccess() / handleTransientError() as the canary runs.
    this.notify();
    if (this.onResumeCallback) this.onResumeCallback();
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private onBrowserOnline(): void {
    if (this.state === 'PAUSED') {
      // Immediately probe on browser online event
      this.clearProbeTimer();
      this.backoffMs = this.minBackoffMs; // reset backoff
      this.probe();
    }
  }

  /** Set custom wait time (e.g. from Retry-After header) */
  setNextProbeDelay(ms: number): void {
    if (this.state === 'PAUSED') {
      this.clearProbeTimer();
      this.scheduleProbe(ms);
    }
  }

  destroy(): void {
    this.clearProbeTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', () => this.onBrowserOnline());
    }
  }
}
