/**
 * Tests for app reload mid-run and while paused:
 * - Tasks found 'running' on start are reset to 'pending' (interrupted).
 * - Jobs are resumed automatically if autoResume is true.
 * - Jobs stay paused/pending if autoResume is false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  putJob,
  getJob,
  putTask,
  getTasksForJob,
  clearAllData,
  resetInterruptedTasks,
} from '../src/storage/repositories';
import { Scheduler } from '../src/engine/scheduler';
import { Gate } from '../src/engine/gate';
import { GatewayClient } from '../src/gateway/client';
import { RoleThrottle } from '../src/gateway/throttle';
import type { Job, Task, JobSettings } from '../src/storage/schema';

describe('Reload handling', () => {
  const settings: JobSettings = {
    gatewayUrl: 'http://localhost:20128',
    apiKey: 'test-key',
    modelA: 'modelA',
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
    await clearAllData();
  });

  it('resets interrupted running tasks to pending on startup', async () => {
    const job: Job = {
      id: 'job-reload-1',
      fileName: 'gazette.pdf',
      sha256: 'h1',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: settings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    // Simulate task left in 'running' state due to sudden tab close
    const task: Task = {
      id: 'task-interrupted',
      jobId: job.id,
      kind: 'extract_page',
      role: 'A',
      params: { page: 1 },
      status: 'running',
      startedAt: Date.now() - 5000,
      attempts: 0,
      transientRetries: 0,
    };
    await putTask(task);

    // Run resetInterruptedTasks
    await resetInterruptedTasks(job.id);

    const tasks = await getTasksForJob(job.id);
    const updated = tasks.find((t) => t.id === 'task-interrupted');
    expect(updated?.status).toBe('pending');
    expect(updated?.startedAt).toBeUndefined();
  });

  it('resumes jobs automatically when autoResume is true', async () => {
    const job: Job = {
      id: 'job-reload-auto',
      fileName: 'gazette.pdf',
      sha256: 'h2',
      pageCount: 1,
      profile: 'fr',
      status: 'paused_offline',
      settingsSnapshot: settings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    const client = new GatewayClient({ baseUrl: 'http://localhost:20128', apiKey: 'k' });
    const gate = new Gate(client);
    const throttle = new RoleThrottle();
    const scheduler = new Scheduler(gate, client, throttle, () => settings);

    await scheduler.resumeJobs(true);

    const reloaded = await getJob(job.id);
    expect(reloaded?.status).toBe('running');

    scheduler.stop();
    gate.destroy();
  });

  it('leaves jobs as paused_offline when autoResume is false', async () => {
    const job: Job = {
      id: 'job-reload-manual',
      fileName: 'gazette.pdf',
      sha256: 'h3',
      pageCount: 1,
      profile: 'fr',
      status: 'paused_offline',
      settingsSnapshot: settings,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };
    await putJob(job);

    const client = new GatewayClient({ baseUrl: 'http://localhost:20128', apiKey: 'k' });
    const gate = new Gate(client);
    const throttle = new RoleThrottle();
    const scheduler = new Scheduler(gate, client, throttle, () => settings);

    await scheduler.resumeJobs(false);

    const reloaded = await getJob(job.id);
    expect(reloaded?.status).toBe('paused_offline');

    scheduler.stop();
    gate.destroy();
  });
});
