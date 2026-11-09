/**
 * Pure planner: derives all tasks that should exist from stored state.
 * Called on every relevant state change. Idempotent - safe to run multiple times.
 * The scheduler only executes tasks; it never keeps logic in memory.
 */

import type { Job, Task, PageResult, Resolution, Unit, JobSettings, Role } from '../storage/schema';
import { hashString } from '../utils/hash';
import { wordDiff } from '../pipeline/parse';

export interface PlannerState {
  job: Job;
  settings: JobSettings;
  results: PageResult[]; // all results from IndexedDB
  units: Unit[]; // all units from IndexedDB
  resolutions: Resolution[]; // all resolutions from IndexedDB
  existingTasks: Task[]; // existing tasks from IndexedDB
}

export interface PlanResult {
  newTasks: Task[]; // tasks to insert
  updatedResolutions: Resolution[]; // resolutions to upsert
}

export async function plan(state: PlannerState): Promise<PlanResult> {
  const { job, settings } = state;
  const newTasks: Task[] = [];
  const updatedResolutions: Resolution[] = [];

  const existingTaskIds = new Set(state.existingTasks.map((t) => t.id));

  // Build result index by (jobId, page, role)
  const resultIndex = new Map<string, PageResult>();
  for (const r of state.results) {
    resultIndex.set(`${r.page}:${r.role}`, r);
  }

  const resolutionIndex = new Map<string, Resolution>();
  for (const r of state.resolutions) {
    resolutionIndex.set(r.unitKey, r);
  }

  // ── Phase 1: Extract each page with agent A, B, and C (3-extractor consensus) ─────────
  const extractRoles: Role[] = settings.modelC ? ['A', 'B', 'C'] : ['A', 'B'];

  for (let page = 1; page <= job.pageCount; page++) {
    for (const role of extractRoles) {
      const resultRole = resultIndex.get(`${page}:${role}`);
      if (!resultRole) {
        // Need to extract this page
        const taskId = await makeTaskId(job.id, 'extract_page', role, { page });
        if (!existingTaskIds.has(taskId)) {
          newTasks.push({
            id: taskId,
            jobId: job.id,
            kind: 'extract_page',
            role,
            params: { page },
            status: 'pending',
            attempts: 0,
            transientRetries: 0,
          });
        }
      }
    }
  }

  // ── Phase 2: For pages where both A and B are done, compare units ─────────

  // Collect pages where both A and B extraction is done
  const pagesWithBothResults = new Set<number>();
  for (let page = 1; page <= job.pageCount; page++) {
    if (resultIndex.has(`${page}:A`) && resultIndex.has(`${page}:B`)) {
      pagesWithBothResults.add(page);
    }
  }

  // For each unit, create or update resolution
  const unitIndex = new Map<string, Unit>();
  for (const u of state.units) {
    unitIndex.set(u.key, u);
  }

  for (const unit of state.units) {
    const resolution = resolutionIndex.get(unit.key);

    if (resolution) {
      if (resolution.status === 'needs_review' && resolution.reruns < settings.maxReruns) {
        const round = resolution.reruns;
        await planUnitRound(job, unit, resolution, round, settings, newTasks, existingTaskIds);
      }
    }
  }

  return { newTasks, updatedResolutions };
}

async function planUnitRound(
  job: Job,
  unit: Unit,
  resolution: Resolution,
  round: number,
  settings: JobSettings,
  newTasks: Task[],
  existingTaskIds: Set<string>
): Promise<void> {
  const hints = resolution.textA && resolution.textB
    ? wordDiff(
        resolution.textA.join('\n'),
        resolution.textB.join('\n')
      ).map((d) => ({ a: d.a, b: d.b }))
    : [];

  // Re-extract with A and B
  for (const role of ['A', 'B'] as const) {
    const taskId = await makeTaskId(job.id, 'extract_unit', role, { unitKey: unit.key, round });
    if (!existingTaskIds.has(taskId)) {
      newTasks.push({
        id: taskId,
        jobId: job.id,
        kind: 'extract_unit',
        role,
        params: { unitKey: unit.key, round, hints },
        status: 'pending',
        attempts: 0,
        transientRetries: 0,
      });
    }
  }

  // Judge on each round if configured, or only on last round
  const judgeRound = settings.judgeEachRound || round === settings.maxReruns - 1;
  if (judgeRound) {
    const taskId = await makeTaskId(job.id, 'judge_unit', 'J', { unitKey: unit.key, round });
    if (!existingTaskIds.has(taskId)) {
      newTasks.push({
        id: taskId,
        jobId: job.id,
        kind: 'judge_unit',
        role: 'J',
        params: { unitKey: unit.key, round, hints },
        status: 'pending',
        attempts: 0,
        transientRetries: 0,
      });
    }
  }
}

async function makeTaskId(
  jobId: string,
  kind: string,
  role: string,
  params: Record<string, unknown>
): Promise<string> {
  const key = `${jobId}:${kind}:${role}:${JSON.stringify(params)}`;
  return hashString(key);
}
