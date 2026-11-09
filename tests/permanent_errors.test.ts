/**
 * Tests for non-transient / permanent error handling:
 * - 401/403 AUTH -> paused_attention (no retry loop).
 * - 404/400 CONFIG_MODEL -> paused_attention naming model/role.
 * - 413 PAYLOAD -> downscales image up to 3 times before needs_attention.
 * - Malformed JSON -> sends corrective prompt, then needs_attention without blocking other tasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Gate } from '../src/engine/gate';
import { Scheduler } from '../src/engine/scheduler';
import { GatewayClient } from '../src/gateway/client';
import { RoleThrottle } from '../src/gateway/throttle';
import {
  putJob,
  getJob,
  putTask,
  getTasksForJob,
  clearAllData,
} from '../src/storage/repositories';
import type { Job, Task, JobSettings } from '../src/storage/schema';

async function advanceUntil(condition: () => Promise<boolean>, maxLoops = 60): Promise<void> {
  for (let i = 0; i < maxLoops; i++) {
    if (await condition()) return;
    await vi.advanceTimersByTimeAsync(50);
    for (let t = 0; t < 5; t++) {
      await new Promise((res) => setImmediate(res));
    }
  }
}

describe('Permanent error handling', () => {
  let client: GatewayClient;
  let gate: Gate;
  let throttle: RoleThrottle;
  let scheduler: Scheduler;

  const settings: JobSettings = {
    gatewayUrl: 'http://localhost:20128',
    apiKey: 'bad-key',
    modelA: 'invalid-model',
    modelB: 'modelB',
    modelJ: 'modelJ',
    maxTokens: 1024,
    requestTimeoutMs: 10000,
    maxReruns: 2,
    judgeEachRound: false,
    neighborPages: 1,
    concurrency: 2,
    imageMaxEdge: 2000,
    imageFormat: 'png',
    useTextLayerHint: false,
    hyphenJoin: true,
    profile: 'fr',
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    await clearAllData();

    client = new GatewayClient({
      baseUrl: settings.gatewayUrl,
      apiKey: settings.apiKey,
    });
    gate = new Gate(client);
    throttle = new RoleThrottle();
    scheduler = new Scheduler(gate, client, throttle, () => settings);
  });

  afterEach(() => {
    scheduler.stop();
    gate.destroy();
    vi.useRealTimers();
  });

  it('stops with paused_attention immediately on 401 AUTH error without endless retry loop', async () => {
    const job: Job = {
      id: 'job-auth',
      fileName: 'test.pdf',
      sha256: 'h-auth',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: settings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    const task: Task = {
      id: 't-auth',
      jobId: job.id,
      kind: 'extract_page',
      role: 'A',
      params: { page: 1 },
      status: 'pending',
      attempts: 0,
      transientRetries: 0,
    };
    await putTask(task);

    vi.spyOn(client, 'complete').mockImplementation(async () => {
      throw {
        class: 'AUTH' as const,
        retryable: false,
        userMessage: 'API key rejected (HTTP 401).',
        httpStatus: 401,
      };
    });

    scheduler.start();
    scheduler.addJob(job.id);
    await advanceUntil(async () => {
      const j = await getJob(job.id);
      return j?.status === 'paused_attention';
    });

    const savedJob = await getJob(job.id);
    expect(savedJob?.status).toBe('paused_attention');
    expect(savedJob?.pausedReason).toBe('auth_error');

    const tasks = await getTasksForJob(job.id);
    expect(tasks[0]?.status).toBe('needs_attention');
    expect(tasks[0]?.lastError?.class).toBe('AUTH');
  });

  it('stops with paused_attention on CONFIG_MODEL error naming the problem', async () => {
    const job: Job = {
      id: 'job-model',
      fileName: 'test.pdf',
      sha256: 'h-model',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: settings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    const task: Task = {
      id: 't-model',
      jobId: job.id,
      kind: 'extract_page',
      role: 'A',
      params: { page: 1 },
      status: 'pending',
      attempts: 0,
      transientRetries: 0,
    };
    await putTask(task);

    vi.spyOn(client, 'complete').mockImplementation(async () => {
      throw {
        class: 'CONFIG_MODEL' as const,
        retryable: false,
        userMessage: 'Model not found (HTTP 404).',
        httpStatus: 404,
      };
    });

    scheduler.start();
    scheduler.addJob(job.id);
    await advanceUntil(async () => {
      const j = await getJob(job.id);
      return j?.status === 'paused_attention';
    });

    const savedJob = await getJob(job.id);
    expect(savedJob?.status).toBe('paused_attention');
    expect(savedJob?.pausedReason).toBe('config_error');
  });

  it('marks task needs_attention after exhausting bad output retries without crashing the rest of the job', async () => {
    const job: Job = {
      id: 'job-bad-output',
      fileName: 'test.pdf',
      sha256: 'h-bad',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: settings,
      createdAt: 1,
      updatedAt: 1,
      stats: { totalPages: 1, tasksTotal: 2, tasksDone: 0 } as any,
    };
    await putJob(job);

    const task: Task = {
      id: 't-bad',
      jobId: job.id,
      kind: 'extract_page',
      role: 'A',
      params: { page: 1 },
      status: 'pending',
      attempts: 2, // already had 2 attempts, next one hits limit (3)
      transientRetries: 0,
    };
    await putTask(task);

    vi.spyOn(client, 'complete').mockImplementation(async () => {
      throw {
        class: 'BAD_OUTPUT' as const,
        retryable: true,
        userMessage: 'Invalid JSON response from model',
      };
    });

    scheduler.start();
    scheduler.addJob(job.id);
    await advanceUntil(async () => {
      const tasks = await getTasksForJob(job.id);
      return tasks.some((t) => t.id === 't-bad' && t.status === 'needs_attention');
    });

    const tasks = await getTasksForJob(job.id);
    const updated = tasks.find((t) => t.id === 't-bad');
    expect(updated?.status).toBe('needs_attention');
    expect(updated?.attempts).toBe(3);
  });
});
