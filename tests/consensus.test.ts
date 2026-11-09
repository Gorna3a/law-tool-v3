import { describe, it, expect } from 'vitest';
import { alignAndCompareUnits } from '../src/pipeline/parse';
import { frProfile } from '../src/pipeline/profiles';
import { plan } from '../src/engine/planner';
import { exportTxt } from '../src/export/txtExporter';
import type { Job, PageResult, JobSettings, Unit, Resolution } from '../src/storage/schema';

describe('3-Model Consensus Architecture', () => {
  const defaultSettings: JobSettings = {
    gatewayUrl: '/gemini',
    apiKey: 'test-key',
    modelA: 'gemini-2.5-flash',
    modelB: 'gemini-2.0-flash',
    modelC: 'gemini-1.5-flash',
    modelJ: 'gemini-2.5-flash',
    maxTokens: 4096,
    requestTimeoutMs: 30000,
    maxReruns: 2,
    judgeEachRound: true,
    neighborPages: 1,
    concurrency: 1,
    imageMaxEdge: 2000,
    imageFormat: 'png',
    useTextLayerHint: true,
    hyphenJoin: true,
    profile: 'fr',
  };

  it('planner generates tasks for Extractor A, B, and C when modelC is active', async () => {
    const job: Job = {
      id: 'job-consensus-plan',
      fileName: 'gazette.pdf',
      sha256: 'mock-sha-1',
      pageCount: 3,
      profile: 'fr',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settingsSnapshot: defaultSettings,
      stats: {
        totalPages: 3,
        pagesRendered: 3,
        pagesExtracted: 0,
        totalUnits: 0,
        unitsAgreed: 0,
        unitsAgreedAfterRerun: 0,
        unitsJudgeResolved: 0,
        unitsNeedsReview: 0,
        unitsHumanResolved: 0,
        unitsNeedsAttention: 0,
        tasksDone: 0,
        tasksTotal: 0,
      },
    };

    const planRes = await plan({
      job,
      settings: defaultSettings,
      results: [],
      units: [],
      resolutions: [],
      existingTasks: [],
    });
    const tasks = planRes.newTasks;
    expect(tasks.length).toBe(9); // 3 pages * 3 extractors = 9 tasks

    const rolesPage1 = tasks.filter((t) => t.params.page === 1).map((t) => t.role);
    expect(rolesPage1).toEqual(['A', 'B', 'C']);

    const rolesPage2 = tasks.filter((t) => t.params.page === 2).map((t) => t.role);
    expect(rolesPage2).toEqual(['A', 'B', 'C']);

    const rolesPage3 = tasks.filter((t) => t.params.page === 3).map((t) => t.role);
    expect(rolesPage3).toEqual(['A', 'B', 'C']);
  });

  it('resolves 3/3 unanimous consensus when all 3 extractors match', async () => {
    const text = [
      { text: 'Art. 1er. — Le présent décret fixe les conditions d\'application.' },
      { text: 'Il prend effet immédiatement.' },
    ];

    const results: PageResult[] = [
      { taskId: 'tA1', jobId: 'job-c1', page: 1, role: 'A', paragraphs: text, extractedAt: 1 },
      { taskId: 'tB1', jobId: 'job-c1', page: 1, role: 'B', paragraphs: text, extractedAt: 2 },
      { taskId: 'tC1', jobId: 'job-c1', page: 1, role: 'C', paragraphs: text, extractedAt: 3 },
    ];

    const res = await alignAndCompareUnits('job-c1', results, frProfile, true);
    expect(res.units.length).toBe(1);
    expect(res.resolutions.length).toBe(1);

    const r = res.resolutions[0]!;
    expect(r.status).toBe('agreed');
    expect(r.consensusRatio).toBe('3/3');
    expect(r.matchedRoles).toEqual(['A', 'B', 'C']);
    expect(r.finalText).toEqual(text.map((t) => t.text));
  });

  it('resolves 2/3 majority consensus when Extractor A and B match, but C has errors', async () => {
    const textCorrect = [
      { text: 'Art. 2. — Est puni d\'une peine d\'emprisonnement quiconque viole les dispositions.' },
    ];
    const textWrongC = [
      { text: 'Art. 2. — Est puni d\'une peine d\'emprisonnement quiconque viole les regles.' },
    ];

    const results: PageResult[] = [
      { taskId: 'tA2', jobId: 'job-c2', page: 1, role: 'A', paragraphs: textCorrect, extractedAt: 1 },
      { taskId: 'tB2', jobId: 'job-c2', page: 1, role: 'B', paragraphs: textCorrect, extractedAt: 2 },
      { taskId: 'tC2', jobId: 'job-c2', page: 1, role: 'C', paragraphs: textWrongC, extractedAt: 3 },
    ];

    const res = await alignAndCompareUnits('job-c2', results, frProfile, true);
    expect(res.resolutions.length).toBe(1);

    const r = res.resolutions[0]!;
    expect(r.status).toBe('agreed');
    expect(r.consensusRatio).toBe('2/3');
    expect(r.matchedRoles).toEqual(['A', 'B']);
    expect(r.finalText).toEqual(textCorrect.map((t) => t.text));
  });

  it('resolves 2/3 majority consensus when Extractor B and C match, but A differs', async () => {
    const textWrongA = [
      { text: 'Art. 3. — Les tribunaux compétents ordonnent la confiscation.' },
    ];
    const textWinningBC = [
      { text: 'Art. 3. — Les juridictions compétentes ordonnent la confiscation.' },
    ];

    const results: PageResult[] = [
      { taskId: 'tA3', jobId: 'job-c3', page: 1, role: 'A', paragraphs: textWrongA, extractedAt: 1 },
      { taskId: 'tB3', jobId: 'job-c3', page: 1, role: 'B', paragraphs: textWinningBC, extractedAt: 2 },
      { taskId: 'tC3', jobId: 'job-c3', page: 1, role: 'C', paragraphs: textWinningBC, extractedAt: 3 },
    ];

    const res = await alignAndCompareUnits('job-c3', results, frProfile, true);
    expect(res.resolutions.length).toBe(1);

    const r = res.resolutions[0]!;
    expect(r.status).toBe('agreed');
    expect(r.consensusRatio).toBe('2/3');
    expect(r.matchedRoles).toEqual(['B', 'C']);
    expect(r.finalText).toEqual(textWinningBC.map((t) => t.text));
  });

  it('flags needs_review when all 3 extractors disagree (0/3 consensus)', async () => {
    const textA = [{ text: 'Art. 4. — Version alpha des mesures prévues.' }];
    const textB = [{ text: 'Art. 4. — Version beta des mesures prises.' }];
    const textC = [{ text: 'Art. 4. — Version gamma des décisions actées.' }];

    const results: PageResult[] = [
      { taskId: 'tA4', jobId: 'job-c4', page: 1, role: 'A', paragraphs: textA, extractedAt: 1 },
      { taskId: 'tB4', jobId: 'job-c4', page: 1, role: 'B', paragraphs: textB, extractedAt: 2 },
      { taskId: 'tC4', jobId: 'job-c4', page: 1, role: 'C', paragraphs: textC, extractedAt: 3 },
    ];

    const res = await alignAndCompareUnits('job-c4', results, frProfile, true);
    expect(res.resolutions.length).toBe(1);

    const r = res.resolutions[0]!;
    expect(r.status).toBe('needs_review');
    expect(r.consensusRatio).toBe('none');
  });

  it('exports text strictly ordered from Page 1 to Page N', async () => {
    const job: Job = {
      id: 'job-export-test',
      fileName: 'journal.pdf',
      sha256: 'mock-sha-2',
      pageCount: 3,
      profile: 'fr',
      status: 'done',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settingsSnapshot: defaultSettings,
      stats: {
        totalPages: 3,
        pagesRendered: 3,
        pagesExtracted: 3,
        totalUnits: 3,
        unitsAgreed: 3,
        unitsAgreedAfterRerun: 0,
        unitsJudgeResolved: 0,
        unitsNeedsReview: 0,
        unitsHumanResolved: 0,
        unitsNeedsAttention: 0,
        tasksDone: 9,
        tasksTotal: 9,
      },
    };

    // Provide page results out of order: Page 3, then Page 1, then Page 2
    const pageResults: PageResult[] = [
      {
        taskId: 'consensus:3',
        jobId: job.id,
        page: 3,
        role: 'A',
        paragraphs: [{ text: 'Contenu de la page trois.' }],
        extractedAt: 3,
        consensusRatio: '3/3',
      },
      {
        taskId: 'consensus:1',
        jobId: job.id,
        page: 1,
        role: 'A',
        paragraphs: [{ text: 'Contenu de la page un.' }],
        extractedAt: 1,
        consensusRatio: '3/3',
      },
      {
        taskId: 'consensus:2',
        jobId: job.id,
        page: 2,
        role: 'A',
        paragraphs: [{ text: 'Contenu de la page deux.' }],
        extractedAt: 2,
        consensusRatio: '2/3',
      },
    ];

    const exported = await exportTxt(job, [], [], { includeHeader: false }, pageResults);

    // Verify Page 1 appears before Page 2, and Page 2 appears before Page 3
    const posP1 = exported.indexOf('--- Page 1 ---');
    const posP2 = exported.indexOf('--- Page 2 ---');
    const posP3 = exported.indexOf('--- Page 3 ---');

    expect(posP1).toBeGreaterThanOrEqual(0);
    expect(posP2).toBeGreaterThan(posP1);
    expect(posP3).toBeGreaterThan(posP2);
  });
});
