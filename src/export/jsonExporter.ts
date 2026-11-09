/**
 * JSON exporter stub.
 * The target schema has not been provided yet (see README / Section 12).
 * DO NOT implement this until the format is specified.
 */

import type { Job, Unit, Resolution } from '../storage/schema';

/** The final job object passed to the exporter. */
export interface FinalJob {
  job: Job;
  units: Unit[];
  resolutions: Resolution[];
}

/**
 * Export a job in the shareable JSON format.
 * @throws Error - format not provided yet.
 */
export function exportJson(_job: FinalJob, _format: unknown): unknown {
  throw new Error(
    'JSON export format not provided yet. ' +
    'This stub exists as a clean seam for the future exporter. ' +
    'See README section 12.'
  );
}
