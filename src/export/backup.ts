/**
 * State backup (.lawtext.json) and Zip export utilities.
 * State backup is internal and versioned, preserving jobs, units, resolutions and events
 * (with API key redacted for security).
 */

import JSZip from 'jszip';
import type { Job, JobSettings, Unit, Resolution, EventLogEntry } from '../storage/schema';
import {
  getAllJobs,
  getUnitsForJob,
  getResolutionsForJob,
  getEventsForJob,
  loadSettings,
  saveSettings,
  putJob,
  putUnits,
  putResolution,
  appendEvent,
} from '../storage/repositories';
import { exportTxt } from './txtExporter';

export const BACKUP_VERSION = 1;

export interface StateBackup {
  version: number;
  exportedAt: number;
  settings?: Omit<JobSettings, 'apiKey'>;
  jobs: Array<{
    job: Job;
    units: Unit[];
    resolutions: Resolution[];
    events: EventLogEntry[];
  }>;
}

/** Export full state or specific jobs as a versioned .lawtext.json string */
export async function exportStateBackup(jobIds?: string[]): Promise<string> {
  const allJobs = await getAllJobs();
  const targetJobs = jobIds ? allJobs.filter((j) => jobIds.includes(j.id)) : allJobs;

  const currentSettings = await loadSettings();
  const sanitizedSettings = currentSettings
    ? { ...currentSettings, apiKey: '' } // Never include API key in exports
    : undefined;

  const exportedJobs: StateBackup['jobs'] = [];

  for (const job of targetJobs) {
    const [units, resolutions, events] = await Promise.all([
      getUnitsForJob(job.id),
      getResolutionsForJob(job.id),
      getEventsForJob(job.id),
    ]);
    exportedJobs.push({
      job: {
        ...job,
        settingsSnapshot: {
          ...job.settingsSnapshot,
          apiKey: '', // Redacted
        },
      },
      units,
      resolutions,
      events,
    });
  }

  const backup: StateBackup = {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    settings: sanitizedSettings,
    jobs: exportedJobs,
  };

  return JSON.stringify(backup, null, 2);
}

/** Import state backup from a .lawtext.json string */
export async function importStateBackup(jsonString: string): Promise<{ importedJobs: number }> {
  let data: unknown;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON format in backup file');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Backup data must be an object');
  }

  const backup = data as Partial<StateBackup>;
  if (!backup.version || !Array.isArray(backup.jobs)) {
    throw new Error('Unrecognized backup format');
  }

  // Restore settings if present and user doesn't already have them
  if (backup.settings) {
    const existing = await loadSettings();
    if (!existing) {
      await saveSettings({
        ...backup.settings,
        apiKey: '',
      } as JobSettings);
    }
  }

  let count = 0;
  for (const item of backup.jobs) {
    if (!item.job || !item.job.id) continue;

    await putJob(item.job);
    if (Array.isArray(item.units) && item.units.length > 0) {
      await putUnits(item.units);
    }
    if (Array.isArray(item.resolutions)) {
      for (const res of item.resolutions) {
        await putResolution(res);
      }
    }
    if (Array.isArray(item.events)) {
      for (const evt of item.events) {
        await appendEvent(evt);
      }
    }
    count++;
  }

  return { importedJobs: count };
}

/** Export multiple jobs as a zip archive of .txt files */
export async function exportJobsZip(jobIds?: string[]): Promise<Blob> {
  const zip = new JSZip();
  const allJobs = await getAllJobs();
  const jobsToExport = jobIds ? allJobs.filter((j) => jobIds.includes(j.id)) : allJobs;

  for (const job of jobsToExport) {
    const [units, resolutions] = await Promise.all([
      getUnitsForJob(job.id),
      getResolutionsForJob(job.id),
    ]);
    const text = await exportTxt(job, units, resolutions, { includeHeader: true });
    const fileName = job.fileName.replace(/\.pdf$/i, '') + '.txt';
    zip.file(fileName, text);
  }

  return zip.generateAsync({ type: 'blob' });
}
