import {
  type Job,
  type Task,
  type PageResult,
  type Unit,
  type Resolution,
  type LlmCacheEntry,
  type EventLogEntry,
  type JobSettings,
  STORE_SETTINGS,
  STORE_JOBS,
  STORE_PDF_BLOBS,
  STORE_PAGE_IMAGES,
  STORE_TASKS,
  STORE_RESULTS,
  STORE_UNITS,
  STORE_RESOLUTIONS,
  STORE_LLM_CACHE,
  STORE_EVENTS,
} from './schema';
import { getDB } from './db';

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_ID = 'global';

export async function loadSettings(): Promise<JobSettings | null> {
  const db = await getDB();
  const row = await db.get(STORE_SETTINGS, SETTINGS_ID);
  return (row as { id: string; data: JobSettings } | undefined)?.data ?? null;
}

export async function saveSettings(settings: JobSettings): Promise<void> {
  const db = await getDB();
  await db.put(STORE_SETTINGS, { id: SETTINGS_ID, data: settings });
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function getJob(id: string): Promise<Job | undefined> {
  const db = await getDB();
  return db.get(STORE_JOBS, id) as Promise<Job | undefined>;
}

export async function getAllJobs(): Promise<Job[]> {
  const db = await getDB();
  return db.getAll(STORE_JOBS) as Promise<Job[]>;
}

export async function putJob(job: Job): Promise<void> {
  const db = await getDB();
  await db.put(STORE_JOBS, { ...job, updatedAt: Date.now() });
}

export async function deleteJob(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(
    [STORE_JOBS, STORE_PDF_BLOBS, STORE_PAGE_IMAGES, STORE_TASKS, STORE_RESULTS, STORE_UNITS, STORE_RESOLUTIONS],
    'readwrite'
  );
  await tx.objectStore(STORE_JOBS).delete(id);
  await tx.objectStore(STORE_PDF_BLOBS).delete(id);

  // delete all page images for this job
  const imgIndex = tx.objectStore(STORE_PAGE_IMAGES).index('by_job');
  const imgKeys = await imgIndex.getAllKeys(IDBKeyRange.only(id));
  for (const k of imgKeys) await tx.objectStore(STORE_PAGE_IMAGES).delete(k);

  const taskIndex = tx.objectStore(STORE_TASKS).index('by_job');
  const taskKeys = await taskIndex.getAllKeys(IDBKeyRange.only(id));
  for (const k of taskKeys) await tx.objectStore(STORE_TASKS).delete(k);

  const resultIndex = tx.objectStore(STORE_RESULTS).index('by_job');
  const resultKeys = await resultIndex.getAllKeys(IDBKeyRange.only(id));
  for (const k of resultKeys) await tx.objectStore(STORE_RESULTS).delete(k);

  const unitIndex = tx.objectStore(STORE_UNITS).index('by_job');
  const unitKeys = await unitIndex.getAllKeys(IDBKeyRange.only(id));
  for (const k of unitKeys) await tx.objectStore(STORE_UNITS).delete(k);

  const resIndex = tx.objectStore(STORE_RESOLUTIONS).index('by_job');
  const resKeys = await resIndex.getAllKeys(IDBKeyRange.only(id));
  for (const k of resKeys) await tx.objectStore(STORE_RESOLUTIONS).delete(k);

  await tx.done;
}

// ─── PDF Blobs ────────────────────────────────────────────────────────────────

export async function storePdfBlob(jobId: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put(STORE_PDF_BLOBS, { jobId, blob });
}

export async function getPdfBlob(jobId: string): Promise<Blob | undefined> {
  const db = await getDB();
  const row = await db.get(STORE_PDF_BLOBS, jobId);
  return (row as { jobId: string; blob: Blob } | undefined)?.blob;
}

// ─── Page Images ─────────────────────────────────────────────────────────────

export async function storePageImage(jobId: string, page: number, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put(STORE_PAGE_IMAGES, { id: `${jobId}:${page}`, jobId, page, blob });
}

export async function getPageImage(jobId: string, page: number): Promise<Blob | undefined> {
  const db = await getDB();
  const row = await db.get(STORE_PAGE_IMAGES, `${jobId}:${page}`);
  return (row as { blob: Blob } | undefined)?.blob;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export async function getTask(id: string): Promise<Task | undefined> {
  const db = await getDB();
  return db.get(STORE_TASKS, id) as Promise<Task | undefined>;
}

export async function getTasksForJob(jobId: string): Promise<Task[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_TASKS, 'by_job', jobId) as Promise<Task[]>;
}

export async function getPendingTasksForJob(jobId: string): Promise<Task[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_TASKS, 'by_job_status', [jobId, 'pending']) as Promise<Task[]>;
}

export async function putTask(task: Task): Promise<void> {
  const db = await getDB();
  await db.put(STORE_TASKS, task);
}

export async function putTaskAndResult(task: Task, result: PageResult | null): Promise<void> {
  const db = await getDB();
  const stores = result
    ? ([STORE_TASKS, STORE_RESULTS] as const)
    : ([STORE_TASKS] as const);
  const tx = db.transaction(stores, 'readwrite');
  tx.objectStore(STORE_TASKS).put(task);
  if (result) tx.objectStore(STORE_RESULTS).put(result);
  await tx.done;
}

/** Reset any tasks still in 'running' state back to 'pending' (crash recovery). */
export async function resetInterruptedTasks(jobId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_TASKS, 'readwrite');
  const index = tx.store.index('by_job');
  let cursor = await index.openCursor(IDBKeyRange.only(jobId));
  while (cursor) {
    const task = cursor.value as Task;
    if (task.status === 'running') {
      await cursor.update({ ...task, status: 'pending', startedAt: undefined });
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export async function getResult(taskId: string): Promise<PageResult | undefined> {
  const db = await getDB();
  return db.get(STORE_RESULTS, taskId) as Promise<PageResult | undefined>;
}

export async function getResultsForJob(jobId: string): Promise<PageResult[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_RESULTS, 'by_job', jobId) as Promise<PageResult[]>;
}

export async function putResult(result: PageResult): Promise<void> {
  const db = await getDB();
  await db.put(STORE_RESULTS, result);
}

// ─── Units ───────────────────────────────────────────────────────────────────

export async function getUnitsForJob(jobId: string): Promise<Unit[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_UNITS, 'by_job', jobId) as Promise<Unit[]>;
}

export async function putUnit(unit: Unit): Promise<void> {
  const db = await getDB();
  await db.put(STORE_UNITS, unit);
}

export async function putUnits(units: Unit[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_UNITS, 'readwrite');
  for (const u of units) tx.store.put(u);
  await tx.done;
}

// ─── Resolutions ─────────────────────────────────────────────────────────────

export async function getResolution(id: string): Promise<Resolution | undefined> {
  const db = await getDB();
  return db.get(STORE_RESOLUTIONS, id) as Promise<Resolution | undefined>;
}

export async function getResolutionsForJob(jobId: string): Promise<Resolution[]> {
  const db = await getDB();
  return db.getAllFromIndex(STORE_RESOLUTIONS, 'by_job', jobId) as Promise<Resolution[]>;
}

export async function putResolution(resolution: Resolution): Promise<void> {
  const db = await getDB();
  await db.put(STORE_RESOLUTIONS, resolution);
}

// ─── LLM Cache ───────────────────────────────────────────────────────────────

export async function getLlmCache(id: string): Promise<LlmCacheEntry | undefined> {
  const db = await getDB();
  return db.get(STORE_LLM_CACHE, id) as Promise<LlmCacheEntry | undefined>;
}

export async function putLlmCache(entry: LlmCacheEntry): Promise<void> {
  const db = await getDB();
  await db.put(STORE_LLM_CACHE, entry);
}

export async function clearOldLlmCache(maxAge = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const db = await getDB();
  const cutoff = Date.now() - maxAge;
  const tx = db.transaction(STORE_LLM_CACHE, 'readwrite');
  const index = tx.store.index('by_createdAt');
  let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export async function appendEvent(event: EventLogEntry): Promise<void> {
  const db = await getDB();
  await db.put(STORE_EVENTS, event);
}

export async function getEventsForJob(jobId: string): Promise<EventLogEntry[]> {
  const db = await getDB();
  const events = await (db.getAllFromIndex(STORE_EVENTS, 'by_job', jobId) as Promise<EventLogEntry[]>);
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getRecentEvents(limit = 200): Promise<EventLogEntry[]> {
  const db = await getDB();
  const all = await (db.getAll(STORE_EVENTS) as Promise<EventLogEntry[]>);
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export async function getStorageUsage(): Promise<{ usageBytes: number; quotaBytes: number }> {
  if (navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usageBytes: usage, quotaBytes: quota };
  }
  return { usageBytes: 0, quotaBytes: 0 };
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const stores = [
    STORE_SETTINGS,
    STORE_JOBS,
    STORE_PDF_BLOBS,
    STORE_PAGE_IMAGES,
    STORE_TASKS,
    STORE_RESULTS,
    STORE_UNITS,
    STORE_RESOLUTIONS,
    STORE_LLM_CACHE,
    STORE_EVENTS,
  ];
  const tx = db.transaction(stores, 'readwrite');
  for (const s of stores) {
    await tx.objectStore(s).clear();
  }
  await tx.done;
}
