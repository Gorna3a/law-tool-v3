/**
 * Core test: Outage mid-run, self-healing recovery, zero red errors.
 *
 * Verifies:
 * 1. Network failure mid-run causes calm pause (paused_offline).
 * 2. In-flight tasks revert to pending without penalty (attempts not increased).
 * 3. Probing backoff (2, 4, 8s...).
 * 4. Recovery: canary runs first (concurrency 1), ramps up, and job finishes.
 * 5. Variants: 503 storm, 429 with Retry-After.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Gate } from '../src/engine/gate';
import { Scheduler } from '../src/engine/scheduler';
import { GatewayClient } from '../src/gateway/client';
import { RoleThrottle } from '../src/gateway/throttle';
import {
  putJob,
  getJob,
  getTasksForJob,
  putTask,
  clearAllData,
  getAllJobs,
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

describe('Outage and Self-Healing Recovery', () => {
  let client: GatewayClient;
  let gate: Gate;
  let throttle: RoleThrottle;
  let scheduler: Scheduler;

  const testSettings: JobSettings = {
    gatewayUrl: 'http://localhost:20128',
    apiKey: 'test-key',
    modelA: 'law-extract-a',
    modelB: 'law-extract-b',
    modelJ: 'law-judge',
    maxTokens: 1024,
    requestTimeoutMs: 10_000,
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
      baseUrl: testSettings.gatewayUrl,
      apiKey: testSettings.apiKey,
      timeoutMs: testSettings.requestTimeoutMs,
    });

    gate = new Gate(client, {
      minBackoffMs: 2_000,
      maxBackoffMs: 60_000,
      jitterFactor: 0,
      maxConcurrency: 2,
    });

    throttle = new RoleThrottle();
    scheduler = new Scheduler(gate, client, throttle, () => testSettings);
  });

  afterEach(() => {
    scheduler.stop();
    gate.destroy();
    vi.useRealTimers();
  });

  it('pauses calmly on network failure, reverts in-flight tasks to pending, and resumes via canary upon recovery', async () => {
    const job: Job = {
      id: 'job-outage-1',
      fileName: 'gazette.pdf',
      sha256: 'hash1',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: testSettings,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stats: {
        totalPages: 1,
        pagesRendered: 1,
        pagesExtracted: 0,
        totalUnits: 0,
        unitsAgreed: 0,
        unitsAgreedAfterRerun: 0,
        unitsJudgeResolved: 0,
        unitsNeedsReview: 0,
        unitsHumanResolved: 0,
        unitsNeedsAttention: 0,
        tasksDone: 0,
        tasksTotal: 2,
      },
    };

    await putJob(job);

    // Mock client: Agent A completes successfully, then network fails on Agent B
    let callCount = 0;
    vi.spyOn(client, 'complete').mockImplementation(async (req) => {
      callCount++;
      if (callCount === 1) {
        return {
          data: {
            id: 'res-1',
            model: 'law-extract-a',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    paragraphs: [{ text: 'Art. 1er. — Premier article.', continuesPrevious: false }],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          },
          modelUsed: 'law-extract-a',
          gatewayHeaders: {},
          fromCache: false,
        };
      } else {
        // Network drops!
        throw new TypeError('Failed to fetch');
      }
    });

    vi.spyOn(client, 'healthCheck').mockImplementation(async () => {
      // Offline during outage
      return { ok: false, rttMs: 0 };
    });

    scheduler.start();
    scheduler.addJob(job.id);

    // Advance loop until paused and job status updated
    await advanceUntil(async () => {
      const saved = await getJob(job.id);
      return gate.getState() === 'PAUSED' && saved?.status === 'paused_offline';
    });

    // Verify: Gate is PAUSED
    expect(gate.getState()).toBe('PAUSED');

    // Verify: Job is paused_offline (NO error, NO failure)
    const savedJob = await getJob(job.id);
    expect(savedJob?.status).toBe('paused_offline');
    expect(savedJob?.pausedReason).toBe('network_down');

    // Verify: in-flight task B was reverted to pending without attempts incremented
    const allTasks = await getTasksForJob(job.id);
    const updatedTaskB = allTasks.find((t) => t.role === 'B');
    expect(updatedTaskB?.status).toBe('pending');
    expect(updatedTaskB?.attempts).toBe(0);

    // Verify backoff probe at 2s
    expect(client.healthCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_050);
    expect(client.healthCheck).toHaveBeenCalledTimes(1);

    // Now simulate gateway recovery!
    vi.spyOn(client, 'healthCheck').mockResolvedValue({ ok: true, rttMs: 12 });
    vi.spyOn(client, 'complete').mockResolvedValue({
      data: {
        id: 'res-2',
        model: 'law-extract-b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                paragraphs: [{ text: 'Art. 1er. — Premier article.', continuesPrevious: false }],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      },
      modelUsed: 'law-extract-b',
      gatewayHeaders: {},
      fromCache: false,
    });

    // Advance to next probe (at 4s)
    await vi.advanceTimersByTimeAsync(4_050);

    // Gate should enter RESUMING with canary concurrency=1
    expect(gate.getState()).toBe('RESUMING');
    expect(gate.getConcurrency()).toBe(1);

    // Re-activate job
    await putJob({ ...savedJob!, status: 'running' });
    scheduler.addJob(job.id);

    await advanceUntil(async () => {
      const finalTasks = await getTasksForJob(job.id);
      return finalTasks.length > 0 && finalTasks.every((t) => t.status === 'done');
    });

    // Task B completes
    const finalTasks = await getTasksForJob(job.id);
    expect(finalTasks.every((t) => t.status === 'done')).toBe(true);

    // Concurrency ramped up and gate transitioned to ONLINE
    expect(gate.getState()).toBe('ONLINE');
    expect(gate.getConcurrency()).toBe(2);
  });

  it('handles 503 storm with Retry-After and pauses calmly', async () => {
    const job: Job = {
      id: 'job-503',
      fileName: 'test.pdf',
      sha256: 'h503',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: testSettings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    const task: Task = {
      id: 't-503',
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
      const err = new Error('Service Unavailable');
      (err as any).status = 503;
      throw err;
    });

    scheduler.start();
    scheduler.addJob(job.id);
    await advanceUntil(async () => {
      const saved = await getJob(job.id);
      return gate.getState() === 'PAUSED' && saved?.status === 'paused_offline';
    });

    expect(gate.getState()).toBe('PAUSED');
    const savedJob = await getJob(job.id);
    expect(savedJob?.status).toBe('paused_offline');
    expect(savedJob?.pausedReason).toBe('upstream_error');
  });

  it('handles 429 rate limit with custom wait and lowers concurrency', async () => {
    const job: Job = {
      id: 'job-429',
      fileName: 'test.pdf',
      sha256: 'h429',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: testSettings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    const task: Task = {
      id: 't-429',
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
      const err = {
        class: 'RATE_LIMIT' as const,
        retryable: true,
        userMessage: 'Rate limit reached',
        retryAfterMs: 25_000,
        httpStatus: 429,
      };
      throw err;
    });

    scheduler.start();
    scheduler.addJob(job.id);
    await advanceUntil(async () => {
      const saved = await getJob(job.id);
      return gate.getState() === 'PAUSED' && saved?.status === 'paused_offline';
    });

    expect(gate.getState()).toBe('PAUSED');
    expect(gate.getConcurrency()).toBe(1); // Concurrency reduced by 1
    const savedJob = await getJob(job.id);
    expect(savedJob?.status).toBe('paused_offline');
    expect(savedJob?.pausedReason).toBe('rate_limit');
  });
});
