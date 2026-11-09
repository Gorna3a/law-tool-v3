/**
 * Scheduler: executes tasks respecting the gate state and concurrency limits.
 * Never stores authoritative state in memory - always reads from and writes to IndexedDB.
 */

import type { Task, Job, JobSettings, PageResult, AppError, Role } from '../storage/schema';
import {
  getJob,
  getTasksForJob,
  putJob,
  putTask,
  putTaskAndResult,
  appendEvent,
  getPageImage,
  getUnitsForJob,
  getResultsForJob,
  getResolutionsForJob,
  putUnits,
  putResolution,
  resetInterruptedTasks,
} from '../storage/repositories';
import type { Gate } from './gate';
import type { GatewayClient, ChatMessage } from '../gateway/client';
import { classify, classifyOutputError } from '../gateway/errorClassifier';
import type { RoleThrottle } from '../gateway/throttle';
import {
  buildPagePrompt,
  buildUnitReExtractionPrompt,
  buildJudgePrompt,
  SYSTEM_EXTRACTOR,
  SYSTEM_JUDGE,
  buildCorrectivePrompt,
} from '../pipeline/prompts';
import {
  parseJsonOutput,
  validatePageOutput,
  validateJudgeOutput,
  splitIntoUnits,
  alignAndCompareUnits,
  unitsAreEqual,
  wordDiff,
  checkArticleNumbering,
  normaliseForCompare,
  canonicalNormaliseForCompare,
} from '../pipeline/parse';
import { getProfile } from '../pipeline/profiles';
import { blobToDataUrl, renderPage, getTextLayer, isSubstantiveTextLayer, cropPageColumns } from '../pdf/renderer';
import { plan } from './planner';
import { hashString } from '../utils/hash';

const MAX_PAYLOAD_DOWNSCALES = 3;
const MAX_BAD_OUTPUT_RETRIES = 3;
const MAX_EMPTY_RETRIES = 2;
const MAX_TRUNCATED_RETRIES = 1;

export class Scheduler {
  private activeJobIds = new Set<string>();
  private runningCount = 0;
  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly gate: Gate,
    private readonly client: GatewayClient,
    private readonly throttle: RoleThrottle,
    private readonly getSettings: () => JobSettings
  ) {
    this.gate.setOnResume(() => this.kickLoop());
  }

  private getEffectiveClientOverrides(settings: JobSettings) {
    const active = this.getSettings();
    const baseUrl = (settings.gatewayUrl && settings.gatewayUrl !== 'http://localhost:20128')
      ? settings.gatewayUrl
      : (active.gatewayUrl || settings.gatewayUrl);
    const apiKey = settings.apiKey || active.apiKey;
    const timeoutMs = settings.requestTimeoutMs || active.requestTimeoutMs;
    return { baseUrl, apiKey, timeoutMs };
  }

  private getEffectiveClientOverridesForRole(role: Role, settings: JobSettings) {
    const agentConfig =
      role === 'A' ? settings.agentA : role === 'B' ? settings.agentB : role === 'C' ? settings.agentC : undefined;
    if (agentConfig && agentConfig.gatewayUrl) {
      return {
        baseUrl: agentConfig.gatewayUrl,
        apiKey: agentConfig.apiKey || settings.apiKey,
        timeoutMs: settings.requestTimeoutMs,
      };
    }
    return this.getEffectiveClientOverrides(settings);
  }

  private getEffectiveModelForRole(role: Role, settings: JobSettings): string {
    const agentConfig =
      role === 'A' ? settings.agentA : role === 'B' ? settings.agentB : role === 'C' ? settings.agentC : undefined;
    if (agentConfig && agentConfig.model) {
      return agentConfig.model;
    }
    if (role === 'A') return settings.modelA;
    if (role === 'B') return settings.modelB;
    if (role === 'C') return settings.modelC || settings.modelA;
    return settings.modelJ || settings.modelA;
  }

  private async updateJobStats(jobId: string): Promise<void> {
    try {
      const job = await getJob(jobId);
      if (!job) return;
      const [allTasks, resolutions, units] = await Promise.all([
        getTasksForJob(jobId),
        getResolutionsForJob(jobId),
        getUnitsForJob(jobId),
      ]);
      const stats = computeStats(allTasks, resolutions, job);
      stats.totalUnits = Math.max(units.length, resolutions.length);
      const updatedJob: Job = {
        ...job,
        stats,
        updatedAt: Date.now(),
      };
      await putJob(updatedJob);
    } catch (err) {
      console.warn('[Scheduler] Failed to update job stats:', err);
    }
  }

  /** Add a job to process. Idempotent. */
  addJob(jobId: string): void {
    this.activeJobIds.add(jobId);
    this.kickLoop();
  }

  removeJob(jobId: string): void {
    this.activeJobIds.delete(jobId);
  }

  start(): void {
    this.running = true;
    this.kickLoop();
  }

  stop(): void {
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
  }

  private kickLoop(): void {
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = setTimeout(() => this.loop(), 50);
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    if (this.gate.getState() !== 'ONLINE' && this.gate.getState() !== 'RESUMING') return;

    const concurrency = this.gate.getConcurrency();

    for (const jobId of this.activeJobIds) {
      if (this.runningCount >= concurrency) break;

      const job = await getJob(jobId);
      if (!job || job.status === 'cancelled' || job.status === 'done') {
        this.activeJobIds.delete(jobId);
        continue;
      }

      if (job.status === 'paused_offline' || job.status === 'paused_attention') continue;

      // Ensure units are split as results arrive
      const rawResults = await getResultsForJob(jobId);
      const aDone = rawResults.filter((r) => r.role === 'A');
      const bDone = rawResults.filter((r) => r.role === 'B');
      if (aDone.length >= job.pageCount && bDone.length >= job.pageCount) {
        await maybeSplitUnits(job, rawResults, this.getSettings());
      }

      // Run the planner
      const results = await getResultsForJob(jobId);
      const units = await getUnitsForJob(jobId);
      const resolutions = await getResolutionsForJob(jobId);
      const settings = this.getSettings();
      const existingTasks = await getTasksForJob(jobId);

      const { newTasks, updatedResolutions } = await plan({
        job,
        settings,
        results,
        units,
        resolutions,
        existingTasks,
      });

      // Save new tasks and resolutions
      for (const task of newTasks) {
        await putTask(task);
      }
      for (const res of updatedResolutions) {
        await putResolution(res);
      }

      // Pick pending tasks to execute
      const allTasks = await getTasksForJob(jobId);

      // ── Sequential Page-by-Page Execution ──────────────────────────────────────
      // Find the lowest page number that is not completely extracted (all roles done).
      const extractRoles: Role[] = settings.modelC ? ['A', 'B', 'C'] : ['A', 'B'];
      let activeWorkingPage: number | null = null;
      for (let p = 1; p <= job.pageCount; p++) {
        const pageDone = extractRoles.every((r) =>
          allTasks.some(
            (t) => t.kind === 'extract_page' && t.role === r && t.params.page === p && t.status === 'done'
          )
        );
        if (!pageDone) {
          activeWorkingPage = p;
          break;
        }
      }

      const pendingTasks = allTasks
        .filter((t) => t.status === 'pending')
        .sort((a, b) => {
          if (a.kind === 'extract_page' && b.kind === 'extract_page') {
            const pageDiff = (a.params.page ?? 0) - (b.params.page ?? 0);
            if (pageDiff !== 0) return pageDiff;
          }
          return taskPriority(a) - taskPriority(b);
        });

      if (pendingTasks.length === 0) {
        // Check if job is complete
        const hasRunning = allTasks.some((t) => t.status === 'running' || t.status === 'pending');
        if (!hasRunning) {
          await this.finaliseJob(job, allTasks);
        }
        continue;
      }

      // Filter tasks to ensure we finish page by page strictly:
      let tasksToRun: Task[];
      if (activeWorkingPage !== null) {
        // Enforce working strictly on activeWorkingPage.
        // Wait if a task is already running on activeWorkingPage to avoid parallel requests causing 429 errors.
        const hasRunningOnPage = allTasks.some(
          (t) => t.kind === 'extract_page' && t.params.page === activeWorkingPage && t.status === 'running'
        );
        if (hasRunningOnPage) {
          continue;
        }
        tasksToRun = pendingTasks
          .filter((t) => t.kind === 'extract_page' && t.params.page === activeWorkingPage)
          .slice(0, 1);
      } else {
        // All pages extracted! Now process unit / judge tasks respecting concurrency
        tasksToRun = pendingTasks.slice(0, Math.max(1, concurrency - this.runningCount));
      }

      for (const task of tasksToRun) {
        if (this.runningCount >= concurrency) break;
        this.runningCount++;
        void this.runTask(task, job).finally(() => {
          this.runningCount--;
          this.kickLoop();
        });
      }
    }
  }

  private async runTask(task: Task, job: Job): Promise<void> {
    const settings = this.getSettings();

    // Mark as running (write-ahead)
    const runningTask: Task = { ...task, status: 'running', startedAt: Date.now() };
    await putTask(runningTask);

    await appendEvent({
      id: crypto.randomUUID(),
      jobId: job.id,
      taskId: task.id,
      type: 'task_started',
      message: `Task ${task.kind}/${task.role} page=${task.params.page ?? ''} unit=${task.params.unitKey ?? ''} started`,
      timestamp: Date.now(),
    });

    try {
      await this.throttle.acquire(task.role);
      await this.executeTask(task, job, settings);
    } catch (err) {
      await this.handleTaskError(task, job, err, settings);
    }
  }

  private async executeTask(task: Task, job: Job, settings: JobSettings): Promise<void> {
    if (task.kind === 'extract_page') {
      await this.runPageExtraction(task, job, settings);
    } else if (task.kind === 'extract_unit') {
      await this.runUnitExtraction(task, job, settings);
    } else if (task.kind === 'judge_unit') {
      await this.runJudge(task, job, settings);
    }

    // Mark gate success for canary ramping
    this.gate.handleSuccess();
  }

  private async runPageExtraction(task: Task, job: Job, settings: JobSettings): Promise<void> {
    const page = task.params.page!;
    let imageScale = task.params.imageScale ?? 1;
    let maxEdge = Math.round(settings.imageMaxEdge * imageScale);

    const imageBlob = await renderPage(job.id, page, {
      maxEdge,
      format: settings.imageFormat,
    });

    let textHint: string | undefined;
    if (settings.useTextLayerHint) {
      const text = await getTextLayer(page);
      if (isSubstantiveTextLayer(text)) {
        textHint = text;
      }
    }

    const imageDataUrl = await blobToDataUrl(imageBlob);
    const profile = getProfile(job.profile) ?? getProfile('fr')!;

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_EXTRACTOR },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: buildPagePrompt(textHint) },
        ],
      },
    ];

    let result: import('../gateway/client').GatewayResult | null = null;
    let attempts = 0;
    let currentMaxTokens = settings.maxTokens;
    let columnSplitOutput: import('../pipeline/parse').PageOutput | null = null;
    const clientOverrides = this.getEffectiveClientOverridesForRole(task.role, settings);
    const modelToUse = this.getEffectiveModelForRole(task.role, settings);

    while (true) {
      try {
        result = await this.client.complete(
          { model: modelToUse, messages, max_tokens: currentMaxTokens },
          undefined,
          task.role,
          clientOverrides
        );
        break;
      } catch (err) {
        const appErr = err as AppError;

        if (appErr.class === 'PAYLOAD' && attempts < MAX_PAYLOAD_DOWNSCALES) {
          imageScale *= 0.75;
          maxEdge = Math.round(settings.imageMaxEdge * imageScale);
          const rescaled = await renderPage(job.id, page, { maxEdge, format: 'jpeg', useCache: false });
          const newUrl = await blobToDataUrl(rescaled);
          (messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>)[0]!.image_url!.url = newUrl;
          attempts++;
          await appendEvent({
            id: crypto.randomUUID(),
            jobId: job.id,
            taskId: task.id,
            type: 'downscale',
            message: `Downscaling image to ${Math.round(imageScale * 100)}% (attempt ${attempts})`,
            timestamp: Date.now(),
          });
          continue;
        }

        if (appErr.class === 'TRUNCATED') {
          if (attempts === 0) {
            // First retry with doubled max_tokens
            currentMaxTokens = Math.min(32768, currentMaxTokens * 2);
            attempts++;
            await appendEvent({
              id: crypto.randomUUID(),
              jobId: job.id,
              taskId: task.id,
              type: 'task_retry',
              message: `Output truncated. Retrying with doubled tokens (${currentMaxTokens})`,
              timestamp: Date.now(),
            });
            continue;
          } else if (attempts === 1) {
            // Column crop fallback: split left and right columns
            attempts++;
            await appendEvent({
              id: crypto.randomUUID(),
              jobId: job.id,
              taskId: task.id,
              type: 'task_retry',
              message: `Output still truncated. Splitting page into left and right column crops`,
              timestamp: Date.now(),
            });

            try {
              const { left, right } = await cropPageColumns(imageBlob);
              const leftUrl = await blobToDataUrl(left);
              const rightUrl = await blobToDataUrl(right);

              const leftRes = await this.client.complete(
                {
                  model: modelToUse,
                  messages: [
                    { role: 'system', content: SYSTEM_EXTRACTOR },
                    {
                      role: 'user',
                      content: [
                        { type: 'image_url', image_url: { url: leftUrl } },
                        { type: 'text', text: buildPagePrompt() },
                      ],
                    },
                  ],
                  max_tokens: currentMaxTokens,
                },
                undefined,
                task.role,
                clientOverrides
              );

              const rightRes = await this.client.complete(
                {
                  model: modelToUse,
                  messages: [
                    { role: 'system', content: SYSTEM_EXTRACTOR },
                    {
                      role: 'user',
                      content: [
                        { type: 'image_url', image_url: { url: rightUrl } },
                        { type: 'text', text: buildPagePrompt() },
                      ],
                    },
                  ],
                  max_tokens: currentMaxTokens,
                },
                undefined,
                task.role,
                clientOverrides
              );

              const leftParsed = validatePageOutput(parseJsonOutput(leftRes.data.choices[0]!.message.content));
              const rightParsed = validatePageOutput(parseJsonOutput(rightRes.data.choices[0]!.message.content));

              columnSplitOutput = {
                paragraphs: [...leftParsed.paragraphs, ...rightParsed.paragraphs],
              };
              result = rightRes;
              break;
            } catch (cropErr) {
              throw cropErr;
            }
          }
        }

        if ((appErr.class === 'BAD_OUTPUT' || appErr.class === 'EMPTY') && attempts < MAX_BAD_OUTPUT_RETRIES) {
          // Add corrective message
          if (messages.length < 3) {
            messages.push({ role: 'assistant', content: 'Invalid JSON' });
            const lastUser = messages[1]!;
            const userText = typeof lastUser.content === 'string' ? lastUser.content : '';
            messages.push({ role: 'user', content: buildCorrectivePrompt(userText) });
          }
          attempts++;
          continue;
        }

        throw err;
      }
    }

    const pageOutput = columnSplitOutput ?? validatePageOutput(parseJsonOutput(result!.data.choices[0]!.message.content));

    const pageResult: PageResult = {
      taskId: task.id,
      jobId: job.id,
      page,
      role: task.role,
      paragraphs: pageOutput.paragraphs,
      modelUsed: result!.modelUsed,
      gatewayHeaders: result!.gatewayHeaders,
      extractedAt: Date.now(),
    };

    // Mark task done + save result atomically
    const doneTask: Task = {
      ...task,
      status: 'done',
      finishedAt: Date.now(),
      modelUsed: result!.modelUsed,
      gatewayHeaders: result!.gatewayHeaders,
    };

    await putTaskAndResult(doneTask, pageResult);
    this.gate.handleSuccess();

    await appendEvent({
      id: crypto.randomUUID(),
      jobId: job.id,
      taskId: task.id,
      type: 'task_done',
      message: `Page ${page} extracted by agent ${task.role} (model: ${result!.modelUsed})`,
      timestamp: Date.now(),
    });

    // Check if all extractors for this page are done to evaluate consensus
    const extractRoles: Role[] = settings.modelC ? ['A', 'B', 'C'] : ['A', 'B'];
    const allResults = await getResultsForJob(job.id);
    const pResults = allResults.filter((r) => r.page === page);

    const resA = pResults.find((r) => r.role === 'A');
    const resB = pResults.find((r) => r.role === 'B');
    const resC = extractRoles.includes('C') ? pResults.find((r) => r.role === 'C') : undefined;

    const allPageExtractorsDone = Boolean(resA && resB && (!extractRoles.includes('C') || resC));

    if (allPageExtractorsDone && resA && resB) {
      await this.evaluatePageConsensus(job, page, resA, resB, resC, settings);
    } else {
      await this.updateJobStats(job.id);
    }
  }

  private async evaluatePageConsensus(
    job: Job,
    page: number,
    resA: PageResult,
    resB: PageResult,
    resC: PageResult | undefined,
    settings: JobSettings
  ): Promise<void> {
    const normA = canonicalNormaliseForCompare(resA.paragraphs);
    const normB = canonicalNormaliseForCompare(resB.paragraphs);

    let consensusParagraphs: import('../storage/schema').Paragraph[] | null = null;
    let consensusRatio: '3/3' | '2/3' | 'none' = 'none';
    let matchedRoles: string[] = [];

    if (resC) {
      const normC = canonicalNormaliseForCompare(resC.paragraphs);
      const matchAB = normA === normB;
      const matchAC = normA === normC;
      const matchBC = normB === normC;

      if (matchAB && matchBC) {
        consensusParagraphs = resA.paragraphs;
        consensusRatio = '3/3';
        matchedRoles = ['A', 'B', 'C'];
      } else if (matchAB) {
        consensusParagraphs = resA.paragraphs;
        consensusRatio = '2/3';
        matchedRoles = ['A', 'B'];
      } else if (matchAC) {
        consensusParagraphs = resA.paragraphs;
        consensusRatio = '2/3';
        matchedRoles = ['A', 'C'];
      } else if (matchBC) {
        consensusParagraphs = resB.paragraphs;
        consensusRatio = '2/3';
        matchedRoles = ['B', 'C'];
      }
    } else {
      if (normA === normB) {
        consensusParagraphs = resA.paragraphs;
        consensusRatio = '2/3';
        matchedRoles = ['A', 'B'];
      }
    }

    if (consensusParagraphs) {
      const consensusResult: PageResult = {
        taskId: `consensus:${job.id}:${page}`,
        jobId: job.id,
        page,
        role: 'A',
        paragraphs: consensusParagraphs,
        modelUsed: `Consensus ${consensusRatio} (${matchedRoles.join('+')})`,
        extractedAt: Date.now(),
        consensusRatio,
        matchedRoles,
      };

      await putTaskAndResult(
        {
          id: `consensus-task:${job.id}:${page}`,
          jobId: job.id,
          kind: 'extract_page',
          role: 'A',
          params: { page },
          status: 'done',
          attempts: 0,
          transientRetries: 0,
          finishedAt: Date.now(),
        },
        consensusResult
      );

      await appendEvent({
        id: crypto.randomUUID(),
        jobId: job.id,
        type: 'task_done',
        message: `Page ${page} verified via ${consensusRatio} consensus (${matchedRoles.join('+')})`,
        data: { page, consensusRatio, matchedRoles },
        timestamp: Date.now(),
      });

      // Split units if all pages done
      const allRes = await getResultsForJob(job.id);
      await maybeSplitUnits(job, allRes, settings);
    } else {
      await appendEvent({
        id: crypto.randomUUID(),
        jobId: job.id,
        type: 'task_retry',
        message: `Page ${page} extraction disagreement (0/3 consensus). Retrying page extraction...`,
        data: { page },
        timestamp: Date.now(),
      });
      await this.retryPageExtraction(job.id, page, settings.maxReruns);
    }

    await this.updateJobStats(job.id);
  }

  private async retryPageExtraction(jobId: string, page: number, maxReruns: number): Promise<void> {
    const tasks = await getTasksForJob(jobId);
    const pageTasks = tasks.filter((t) => t.kind === 'extract_page' && t.params.page === page);
    for (const t of pageTasks) {
      if (t.attempts < maxReruns) {
        await putTask({
          ...t,
          status: 'pending',
          attempts: t.attempts + 1,
          startedAt: undefined,
          finishedAt: undefined,
        });
      } else {
        await putTask({
          ...t,
          status: 'needs_attention',
          finishedAt: Date.now(),
        });
      }
    }
  }

  private async runUnitExtraction(task: Task, job: Job, settings: JobSettings): Promise<void> {
    const { unitKey, hints = [] } = task.params;
    if (!unitKey) throw new Error('Missing unitKey');

    const units = await getUnitsForJob(job.id);
    const unit = units.find((u) => u.key === unitKey);
    if (!unit) {
      // Unit disappeared - mark done
      await putTask({ ...task, status: 'done', finishedAt: Date.now() });
      return;
    }

    const images: string[] = [];
    for (const page of unit.pages) {
      const blob = await getPageImage(job.id, page);
      if (!blob) continue;
      images.push(await blobToDataUrl(blob));
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_EXTRACTOR },
      {
        role: 'user',
        content: [
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          {
            type: 'text' as const,
            text: buildUnitReExtractionPrompt(
              unitKey,
              unitDescription(unit),
              hints.map((h) => ({ a: h.a, b: h.b }))
            ),
          },
        ],
      },
    ];

    const model = task.role === 'A' ? settings.modelA : settings.modelB;
    const clientOverrides = this.getEffectiveClientOverrides(settings);
    const result = await this.client.complete(
      { model, messages, max_tokens: settings.maxTokens },
      undefined,
      task.role,
      clientOverrides
    );

    const raw = result.data.choices[0]!.message.content;
    const parsed = parseJsonOutput(raw);
    const output = validatePageOutput(parsed);

    // Store as a page result (re-used schema)
    const pageResult: PageResult = {
      taskId: task.id,
      jobId: job.id,
      page: unit.pages[0] ?? 0,
      role: task.role,
      paragraphs: output.paragraphs,
      modelUsed: result.modelUsed,
      gatewayHeaders: result.gatewayHeaders,
      extractedAt: Date.now(),
    };

    const doneTask: Task = { ...task, status: 'done', finishedAt: Date.now(), modelUsed: result.modelUsed };
    await putTaskAndResult(doneTask, pageResult);
    this.gate.handleSuccess();

    // Update resolution
    const resolutions = await getResolutionsForJob(job.id);
    const resolution = resolutions.find((r) => r.unitKey === unitKey);
    if (resolution) {
      // Check if A and B both done for this round
      const allTasks = await getTasksForJob(job.id);
      const roundTasks = allTasks.filter(
        (t) => t.params.unitKey === unitKey && t.params.round === task.params.round && t.kind === 'extract_unit'
      );

      const aTask = roundTasks.find((t) => t.role === 'A' && t.status === 'done');
      const bTask = roundTasks.find((t) => t.role === 'B' && t.status === 'done');

      if (aTask && bTask) {
        const aResult = await import('../storage/repositories').then((r) => r.getResult(aTask.id));
        const bResult = await import('../storage/repositories').then((r) => r.getResult(bTask.id));

        if (aResult && bResult) {
          const equal = unitsAreEqual(aResult.paragraphs, bResult.paragraphs);
          if (equal) {
            await putResolution({
              ...resolution,
              status: 'agreed_after_rerun',
              textA: aResult.paragraphs.map((p) => p.text),
              textB: bResult.paragraphs.map((p) => p.text),
              finalText: aResult.paragraphs.map((p) => p.text),
              reruns: resolution.reruns + 1,
              resolvedAt: Date.now(),
              resolvedBy: 'auto',
            });
          } else {
            await putResolution({
              ...resolution,
              textA: aResult.paragraphs.map((p) => p.text),
              textB: bResult.paragraphs.map((p) => p.text),
              reruns: resolution.reruns + 1,
            });
          }
        }
      }
    }
    await this.updateJobStats(job.id);
  }

  private async runJudge(task: Task, job: Job, settings: JobSettings): Promise<void> {
    const { unitKey } = task.params;
    if (!unitKey) throw new Error('Missing unitKey');

    const units = await getUnitsForJob(job.id);
    const unit = units.find((u) => u.key === unitKey);
    if (!unit) {
      await putTask({ ...task, status: 'done', finishedAt: Date.now() });
      return;
    }

    const resolutions = await getResolutionsForJob(job.id);
    const resolution = resolutions.find((r) => r.unitKey === unitKey);
    if (!resolution || !resolution.textA || !resolution.textB) {
      await putTask({ ...task, status: 'needs_attention', finishedAt: Date.now() });
      return;
    }

    const images: string[] = [];
    for (const page of unit.pages) {
      let blob = await getPageImage(job.id, page);
      if (!blob) {
        try {
          blob = await renderPage(job.id, page, {
            maxEdge: settings.imageMaxEdge,
            format: settings.imageFormat,
          });
        } catch {}
      }
      if (blob) images.push(await blobToDataUrl(blob));
    }

    const diffs = wordDiff(
      resolution.textA.join('\n'),
      resolution.textB.join('\n')
    ).map((d) => ({ a: d.a, b: d.b }));

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_JUDGE },
      {
        role: 'user',
        content: [
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          {
            type: 'text' as const,
            text: buildJudgePrompt(
              unitKey,
              unitDescription(unit),
              resolution.textA,
              resolution.textB,
              diffs
            ),
          },
        ],
      },
    ];

    const clientOverrides = this.getEffectiveClientOverrides(settings);
    const judgeModel = (settings.modelJ && settings.modelJ !== 'law-judge')
      ? settings.modelJ
      : (settings.modelA || 'gemini-2.5-flash');

    let result: import('../gateway/client').GatewayResult | null = null;
    let attempts = 0;
    while (true) {
      try {
        result = await this.client.complete(
          {
            model: judgeModel,
            messages,
            max_tokens: settings.maxTokens,
          },
          undefined,
          'J',
          clientOverrides
        );

        const raw = result.data.choices[0]!.message.content;
        const parsed = parseJsonOutput(raw);
        validateJudgeOutput(parsed);
        break;
      } catch (err) {
        const appErr = isAppError(err) ? err : classify(err);
        if ((appErr.class === 'BAD_OUTPUT' || appErr.class === 'EMPTY') && attempts < 2) {
          if (messages.length < 3) {
            messages.push({ role: 'assistant', content: 'Invalid JSON' });
            const lastUser = messages[1]!;
            const userText = typeof lastUser.content === 'string' ? lastUser.content : '';
            messages.push({ role: 'user', content: buildCorrectivePrompt(userText) });
          }
          attempts++;
          continue;
        }
        throw err;
      }
    }

    const raw = result!.data.choices[0]!.message.content;
    const parsed = parseJsonOutput(raw);
    const judgeOutput = validateJudgeOutput(parsed);

    const isHighConfidence = judgeOutput.confidence === 'high';
    const judgeMatchesAorB =
      normaliseForCompare(judgeOutput.reading.map((t) => ({ text: t }))) ===
        normaliseForCompare((resolution.textA ?? []).map((t) => ({ text: t }))) ||
      normaliseForCompare(judgeOutput.reading.map((t) => ({ text: t }))) ===
        normaliseForCompare((resolution.textB ?? []).map((t) => ({ text: t })));

    const needsReview = !(isHighConfidence && judgeMatchesAorB);

    await putResolution({
      ...resolution,
      status: needsReview ? 'needs_review' : 'judge_resolved',
      textJ: judgeOutput.reading,
      finalText: judgeOutput.reading,
      judgeConfidence: judgeOutput.confidence,
      judgeNote: judgeOutput.note,
      modelUsedJ: result!.modelUsed,
      resolvedAt: Date.now(),
      resolvedBy: 'judge',
    });

    const doneTask: Task = { ...task, status: 'done', finishedAt: Date.now(), modelUsed: result!.modelUsed };
    await putTask(doneTask);
    this.gate.handleSuccess();

    await appendEvent({
      id: crypto.randomUUID(),
      jobId: job.id,
      taskId: task.id,
      type: 'task_done',
      message: `Judge resolved unit ${unitKey} (confidence: ${judgeOutput.confidence}, needsReview: ${needsReview})`,
      timestamp: Date.now(),
    });
    await this.updateJobStats(job.id);
  }

  private async handleTaskError(task: Task, job: Job, err: unknown, _settings: JobSettings): Promise<void> {
    const appErr = isAppError(err) ? err : classify(err);

    if (appErr.class === 'TRANSIENT_NETWORK' || appErr.class === 'TRANSIENT_UPSTREAM') {
      // Pause gate - do NOT increment attempts
      const wasFirst = this.gate.handleTransientError(appErr);
      if (wasFirst) {
        // Abort all in-flight - the gate already did this
        // Revert this task to pending
        await putTask({ ...task, status: 'pending', startedAt: undefined });

        // Pause job
        await putJob({
          ...job,
          status: 'paused_offline',
          pausedReason: appErr.class === 'TRANSIENT_NETWORK' ? 'network_down' : 'upstream_error',
        });

        await appendEvent({
          id: crypto.randomUUID(),
          jobId: job.id,
          taskId: task.id,
          type: 'job_paused',
          message: appErr.userMessage,
          data: { reason: appErr.class },
          timestamp: Date.now(),
        });
      } else {
        await putTask({ ...task, status: 'pending', startedAt: undefined });
      }
      return;
    }

    if (appErr.class === 'RATE_LIMIT') {
      this.gate.handleRateLimit(appErr);
      await putTask({ ...task, status: 'pending', startedAt: undefined });
      if (appErr.retryAfterMs) {
        this.gate.setNextProbeDelay(appErr.retryAfterMs);
      }
      await putJob({ ...job, status: 'paused_offline', pausedReason: 'rate_limit' });
      return;
    }

    if (appErr.class === 'AUTH' || appErr.class === 'CONFIG_MODEL') {
      // Permanent errors - pause job with attention
      await putTask({ ...task, status: 'needs_attention', lastError: appErr, finishedAt: Date.now() });
      await putJob({
        ...job,
        status: 'paused_attention',
        pausedReason: appErr.class === 'AUTH' ? 'auth_error' : 'config_error',
      });
      await appendEvent({
        id: crypto.randomUUID(),
        jobId: job.id,
        taskId: task.id,
        type: 'task_attention',
        message: appErr.userMessage,
        data: { error: appErr },
        timestamp: Date.now(),
      });
      return;
    }

    // For other errors, increment attempts and possibly mark needs_attention
    const newAttempts = task.attempts + 1;
    const maxAttempts = 3;

    if (newAttempts >= maxAttempts) {
      await putTask({
        ...task,
        status: 'needs_attention',
        attempts: newAttempts,
        lastError: appErr,
        finishedAt: Date.now(),
      });
      await appendEvent({
        id: crypto.randomUUID(),
        jobId: job.id,
        taskId: task.id,
        type: 'task_attention',
        message: `Task failed after ${newAttempts} attempts: ${appErr.userMessage}`,
        data: { error: appErr },
        timestamp: Date.now(),
      });
      // Job continues with other tasks
    } else {
      await putTask({
        ...task,
        status: 'pending',
        attempts: newAttempts,
        lastError: appErr,
      });
      await appendEvent({
        id: crypto.randomUUID(),
        jobId: job.id,
        taskId: task.id,
        type: 'task_retry',
        message: `Task retry ${newAttempts}/${maxAttempts}: ${appErr.userMessage}`,
        timestamp: Date.now(),
      });
    }
  }

  private async finaliseJob(job: Job, allTasks: Task[]): Promise<void> {
    const units = await getUnitsForJob(job.id);
    const warnings = checkArticleNumbering(units);

    const resolutions = await getResolutionsForJob(job.id);
    const stats = computeStats(allTasks, resolutions, job);

    await putJob({
      ...job,
      status: 'done',
      stats,
      articleNumberWarnings: warnings,
      updatedAt: Date.now(),
    });

    await appendEvent({
      id: crypto.randomUUID(),
      jobId: job.id,
      type: 'job_done',
      message: `Job "${job.fileName}" completed. ${stats.unitsAgreed} agreed, ${stats.unitsNeedsReview} need review.`,
      data: { warnings },
      timestamp: Date.now(),
    });

    // Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('LawText: Job finished', {
        body: `"${job.fileName}" is ready for review.`,
      });
    }

    this.activeJobIds.delete(job.id);
  }

  /** Resume jobs after reload (on start or after gate reconnects) */
  async resumeJobs(autoResume: boolean): Promise<void> {
    const { getAllJobs } = await import('../storage/repositories');
    const jobs = await getAllJobs();

    for (const job of jobs) {
      if (job.status === 'running' || job.status === 'paused_offline') {
        // Reset interrupted tasks
        await resetInterruptedTasks(job.id);

        if (autoResume) {
          await putJob({ ...job, status: 'running' });
          this.addJob(job.id);
          await appendEvent({
            id: crypto.randomUUID(),
            jobId: job.id,
            type: 'job_resumed',
            message: 'Job resumed automatically after reload.',
            timestamp: Date.now(),
          });
        }
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function taskPriority(task: Task): number {
  // extract_page first (to build partial results fast), then unit tasks
  if (task.kind === 'extract_page') return 0;
  if (task.kind === 'extract_unit') return 1;
  return 2; // judge_unit
}

function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'class' in e && 'retryable' in e;
}

function unitDescription(unit: import('../storage/schema').Unit): string {
  if (unit.type === 'article') return `article ${unit.key.replace('art:', '')}`;
  if (unit.type === 'heading') return `heading "${unit.key}"`;
  if (unit.type === 'preamble') return 'preamble section';
  if (unit.type === 'closing') return 'closing section';
  return `section "${unit.key}"`;
}

function computeStats(
  allTasks: Task[],
  resolutions: import('../storage/schema').Resolution[],
  job: Job
): import('../storage/schema').JobStats {
  const doneTasks = allTasks.filter((t) => t.status === 'done').length;
  const numRoles = job.settingsSnapshot?.modelC ? 3 : 2;
  const totalTasks = Math.max(allTasks.length, job.pageCount * numRoles);
  return {
    totalPages: job.pageCount,
    pagesRendered: job.pageCount,
    pagesExtracted: allTasks.filter((t) => t.kind === 'extract_page' && t.status === 'done').length,
    totalUnits: resolutions.length,
    unitsAgreed: resolutions.filter((r) => r.status === 'agreed').length,
    unitsAgreedAfterRerun: resolutions.filter((r) => r.status === 'agreed_after_rerun').length,
    unitsJudgeResolved: resolutions.filter((r) => r.status === 'judge_resolved').length,
    unitsNeedsReview: resolutions.filter((r) => r.status === 'needs_review').length,
    unitsHumanResolved: resolutions.filter((r) => r.status === 'human_resolved').length,
    unitsNeedsAttention: resolutions.filter((r) => r.status === 'needs_attention').length,
    tasksDone: doneTasks,
    tasksTotal: totalTasks,
    startedAt: job.stats?.startedAt ?? Date.now(),
    finishedAt: job.status === 'done' ? (job.stats?.finishedAt ?? Date.now()) : undefined,
  };
}

async function maybeSplitUnits(
  job: Job,
  results: PageResult[],
  settings: JobSettings
): Promise<void> {
  const aResults = results.filter((r) => r.role === 'A');
  const bResults = results.filter((r) => r.role === 'B');
  const cResults = results.filter((r) => r.role === 'C');

  if (aResults.length < job.pageCount || bResults.length < job.pageCount) return;
  if (settings.modelC && cResults.length < job.pageCount) return;

  const profile = getProfile(job.profile) ?? getProfile('fr')!;
  const existingResolutions = await getResolutionsForJob(job.id);

  const { units, resolutions } = await alignAndCompareUnits(
    job.id,
    results,
    profile,
    settings.hyphenJoin,
    existingResolutions
  );

  await putUnits(units);
  for (const res of resolutions) {
    await putResolution(res);
  }

  const jobFresh = await getJob(job.id);
  if (jobFresh) {
    const allTasks = await getTasksForJob(job.id);
    const stats = computeStats(allTasks, resolutions, jobFresh);
    stats.totalUnits = units.length;
    await putJob({ ...jobFresh, stats, updatedAt: Date.now() });
  }
}
