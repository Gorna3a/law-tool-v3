import { openDB, type IDBPDatabase } from 'idb';
import {
  DB_NAME,
  DB_VERSION,
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

export type LawTextDB = IDBPDatabase;

let dbPromise: Promise<LawTextDB> | null = null;

export function getDB(): Promise<LawTextDB> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        // Version 1: initial schema
        if (oldVersion < 1) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });

          const jobs = db.createObjectStore(STORE_JOBS, { keyPath: 'id' });
          jobs.createIndex('by_status', 'status');
          jobs.createIndex('by_createdAt', 'createdAt');

          db.createObjectStore(STORE_PDF_BLOBS, { keyPath: 'jobId' });

          const pageImages = db.createObjectStore(STORE_PAGE_IMAGES, {
            keyPath: 'id', // `${jobId}:${page}`
          });
          pageImages.createIndex('by_job', 'jobId');

          const tasks = db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
          tasks.createIndex('by_job', 'jobId');
          tasks.createIndex('by_job_status', ['jobId', 'status']);
          tasks.createIndex('by_status', 'status');

          const results = db.createObjectStore(STORE_RESULTS, { keyPath: 'taskId' });
          results.createIndex('by_job', 'jobId');
          results.createIndex('by_job_page', ['jobId', 'page']);

          const units = db.createObjectStore(STORE_UNITS, { keyPath: 'id' });
          units.createIndex('by_job', 'jobId');
          units.createIndex('by_job_key', ['jobId', 'key']);

          const resolutions = db.createObjectStore(STORE_RESOLUTIONS, { keyPath: 'id' });
          resolutions.createIndex('by_job', 'jobId');
          resolutions.createIndex('by_job_status', ['jobId', 'status']);

          const llmCache = db.createObjectStore(STORE_LLM_CACHE, { keyPath: 'id' });
          llmCache.createIndex('by_createdAt', 'createdAt');

          const events = db.createObjectStore(STORE_EVENTS, {
            keyPath: 'id',
          });
          events.createIndex('by_job', 'jobId');
          events.createIndex('by_timestamp', 'timestamp');
        }

        // Future migrations go here as: if (oldVersion < 2) { ... }
        void tx;
      },
    });
  }
  return dbPromise;
}

export function resetDB(): void {
  dbPromise = null;
}
