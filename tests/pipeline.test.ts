/**
 * Pipeline tests:
 * 1. Happy path: 2 pages, A = B -> Judge is NEVER called.
 * 2. Mismatch path:
 *    - B wrong once -> only that unit re-extracted -> agreed_after_rerun
 *    - B wrong always -> judge reading final, needsReview
 *    - judge_each_round true vs false changes judge call count
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitIntoUnits, alignAndCompareUnits, unitsAreEqual } from '../src/pipeline/parse';
import { frProfile } from '../src/pipeline/profiles';
import { plan } from '../src/engine/planner';
import type { Job, PageResult, JobSettings } from '../src/storage/schema';

describe('Pipeline Happy Path (A = B)', () => {
  it('agrees on all units and never calls the judge', async () => {
    const page1Paragraphs = [
      { text: 'Chapitre 1' },
      { text: 'Dispositions générales' },
      { text: 'Art. 1er. — Le présent texte définit les règles.' },
    ];
    const page2Paragraphs = [
      { text: 'Art. 2. — Tout contrevenant est puni selon la loi.' },
      { text: 'Fait à Alger, le 15 janvier 2024.' },
    ];

    const results: PageResult[] = [
      {
        taskId: 't1',
        jobId: 'job-happy',
        page: 1,
        role: 'A',
        paragraphs: page1Paragraphs,
        extractedAt: Date.now(),
      },
      {
        taskId: 't2',
        jobId: 'job-happy',
        page: 1,
        role: 'B',
        paragraphs: page1Paragraphs, // Exact agreement
        extractedAt: Date.now(),
      },
      {
        taskId: 't3',
        jobId: 'job-happy',
        page: 2,
        role: 'A',
        paragraphs: page2Paragraphs,
        extractedAt: Date.now(),
      },
      {
        taskId: 't4',
        jobId: 'job-happy',
        page: 2,
        role: 'B',
        paragraphs: page2Paragraphs, // Exact agreement
        extractedAt: Date.now(),
      },
    ];

    const { units, resolutions } = await alignAndCompareUnits(
      'job-happy',
      results,
      frProfile
    );

    expect(units.length).toBeGreaterThan(0);
    // Every unit must be 'agreed'
    for (const res of resolutions) {
      expect(res.status).toBe('agreed');
      expect(res.textJ).toBeUndefined(); // Judge never called
    }

    const job: Job = {
      id: 'job-happy',
      fileName: 'test.pdf',
      sha256: 'sha',
      pageCount: 2,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: {
        gatewayUrl: 'http://localhost:20128',
        apiKey: 'key',
        modelA: 'modelA',
        modelB: 'modelB',
        modelJ: 'modelJ',
        maxTokens: 4096,
        requestTimeoutMs: 10000,
        maxReruns: 2,
        judgeEachRound: false,
        neighborPages: 1,
        concurrency: 2,
        imageMaxEdge: 2000,
        imageFormat: 'png',
        useTextLayerHint: true,
        hyphenJoin: true,
        profile: 'fr',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stats: {
        totalPages: 2,
        pagesRendered: 2,
        pagesExtracted: 2,
        totalUnits: units.length,
        unitsAgreed: units.length,
        unitsAgreedAfterRerun: 0,
        unitsJudgeResolved: 0,
        unitsNeedsReview: 0,
        unitsHumanResolved: 0,
        unitsNeedsAttention: 0,
        tasksDone: 4,
        tasksTotal: 4,
      },
    };

    const planResult = await plan({
      job,
      settings: job.settingsSnapshot,
      results,
      units,
      resolutions,
      existingTasks: [],
    });

    // Zero judge tasks or re-extraction tasks should be planned
    const judgeTasks = planResult.newTasks.filter((t) => t.kind === 'judge_unit');
    const unitTasks = planResult.newTasks.filter((t) => t.kind === 'extract_unit');
    expect(judgeTasks.length).toBe(0);
    expect(unitTasks.length).toBe(0);
  });
});

describe('Pipeline Mismatch Path', () => {
  it('re-extracts ONLY the mismatching unit', async () => {
    const page1A = [
      { text: 'Art. 1er. — Texte exact conforme.' },
      { text: 'Art. 2. — La sanction est de 500 DA.' },
    ];
    const page1B = [
      { text: 'Art. 1er. — Texte exact conforme.' }, // Agrees with A
      { text: 'Art. 2. — La sanction est de 600 DA.' }, // Mismatch!
    ];

    const results: PageResult[] = [
      { taskId: 't1', jobId: 'job-mismatch', page: 1, role: 'A', paragraphs: page1A, extractedAt: 1 },
      { taskId: 't2', jobId: 'job-mismatch', page: 1, role: 'B', paragraphs: page1B, extractedAt: 1 },
    ];

    const { units, resolutions } = await alignAndCompareUnits('job-mismatch', results, frProfile);

    const art1Res = resolutions.find((r) => r.unitKey === 'art:1');
    const art2Res = resolutions.find((r) => r.unitKey === 'art:2');

    expect(art1Res?.status).toBe('agreed');
    expect(art2Res?.status).toBe('needs_review');

    const job: Job = {
      id: 'job-mismatch',
      fileName: 'test.pdf',
      sha256: 'sha',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: {
        gatewayUrl: 'http://localhost:20128',
        apiKey: 'key',
        modelA: 'modelA',
        modelB: 'modelB',
        modelJ: 'modelJ',
        maxTokens: 4096,
        requestTimeoutMs: 10000,
        maxReruns: 2,
        judgeEachRound: false,
        neighborPages: 1,
        concurrency: 2,
        imageMaxEdge: 2000,
        imageFormat: 'png',
        useTextLayerHint: true,
        hyphenJoin: true,
        profile: 'fr',
      },
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };

    const planned = await plan({
      job,
      settings: job.settingsSnapshot,
      results,
      units,
      resolutions,
      existingTasks: [],
    });

    // Only unit 2 tasks should be created, never unit 1!
    const unitTasks = planned.newTasks.filter((t) => t.kind === 'extract_unit');
    expect(unitTasks.length).toBe(2); // Agent A and B for unit 2
    expect(unitTasks.every((t) => t.params.unitKey === 'art:2')).toBe(true);
    expect(unitTasks.some((t) => t.params.unitKey === 'art:1')).toBe(false);
  });

  it('judgeEachRound true plans judge immediately on round 0, false plans on round 1 (last)', async () => {
    const job: Job = {
      id: 'job-rounds',
      fileName: 'test.pdf',
      sha256: 'sha',
      pageCount: 1,
      profile: 'fr',
      status: 'running',
      settingsSnapshot: {} as any,
      createdAt: 1,
      updatedAt: 1,
      stats: {} as any,
    };

    const unit = {
      id: 'u1',
      jobId: 'job-rounds',
      type: 'article' as const,
      key: 'art:1',
      pages: [1],
      paragraphs: [{ text: 'Art. 1. — Test' }],
    };

    const resolution = {
      id: 'u1',
      jobId: 'job-rounds',
      unitId: 'u1',
      unitKey: 'art:1',
      status: 'needs_review' as const,
      textA: ['Art. 1. — A'],
      textB: ['Art. 1. — B'],
      reruns: 0,
    };

    // When judgeEachRound is FALSE, round 0 has NO judge
    const planNoJudge = await plan({
      job,
      settings: { maxReruns: 2, judgeEachRound: false } as any,
      results: [{ page: 1, role: 'A' }, { page: 1, role: 'B' }] as any,
      units: [unit],
      resolutions: [resolution],
      existingTasks: [],
    });
    expect(planNoJudge.newTasks.some((t) => t.kind === 'judge_unit')).toBe(false);

    // When judgeEachRound is TRUE, round 0 HAS judge
    const planWithJudge = await plan({
      job,
      settings: { maxReruns: 2, judgeEachRound: true } as any,
      results: [{ page: 1, role: 'A' }, { page: 1, role: 'B' }] as any,
      units: [unit],
      resolutions: [resolution],
      existingTasks: [],
    });
    expect(planWithJudge.newTasks.some((t) => t.kind === 'judge_unit')).toBe(true);

    // When round is 1 (last round: 2-1), judge is planned even if judgeEachRound is FALSE
    const planLastRound = await plan({
      job,
      settings: { maxReruns: 2, judgeEachRound: false } as any,
      results: [{ page: 1, role: 'A' }, { page: 1, role: 'B' }] as any,
      units: [unit],
      resolutions: [{ ...resolution, reruns: 1 }],
      existingTasks: [],
    });
    expect(planLastRound.newTasks.some((t) => t.kind === 'judge_unit')).toBe(true);
  });
});
