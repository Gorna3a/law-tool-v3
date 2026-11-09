// ============================================================
// Storage schema – IndexedDB is the source of truth
// ============================================================

export type Role = 'A' | 'B' | 'C' | 'J';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused_offline'
  | 'paused_attention'
  | 'done'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'needs_attention'
  | 'cancelled';

export type TaskKind = 'extract_page' | 'extract_unit' | 'judge_unit';

export type UnitType = 'preamble' | 'heading' | 'article' | 'closing' | 'other';

export type ResolutionStatus =
  | 'agreed'
  | 'agreed_after_rerun'
  | 'consensus_resolved'
  | 'judge_resolved'
  | 'human_resolved'
  | 'needs_review'
  | 'needs_attention';

export type PauseReason =
  | 'network_down'
  | 'upstream_error'
  | 'rate_limit'
  | 'auth_error'
  | 'config_error'
  | 'unknown';

export interface Paragraph {
  text: string;
  continuesPrevious?: boolean;
}

export interface PageResult {
  taskId: string;
  jobId: string;
  page: number;
  role: Role;
  paragraphs: Paragraph[];
  modelUsed?: string;
  gatewayHeaders?: Record<string, string>;
  extractedAt: number;
  consensusRatio?: '3/3' | '2/3' | 'none';
  matchedRoles?: string[];
}

export interface Unit {
  id: string; // deterministic: hash(jobId, type, key, index)
  jobId: string;
  type: UnitType;
  key: string; // 'preamble', 'art:12', 'heading:chapitre:3/section:1', etc.
  pages: number[]; // which pages this unit spans
  paragraphs: Paragraph[];
  ancestorPath?: string; // for headings
  headingTitle?: string; // single next paragraph if heading
}

export interface Resolution {
  id: string; // = unitId
  jobId: string;
  unitId: string;
  unitKey: string;
  status: ResolutionStatus;
  textA?: string[];
  textB?: string[];
  textC?: string[];
  textJ?: string[];
  finalText?: string[];
  humanText?: string[];
  reruns: number;
  judgeConfidence?: 'high' | 'medium' | 'low';
  judgeNote?: string;
  modelUsedA?: string;
  modelUsedB?: string;
  modelUsedC?: string;
  modelUsedJ?: string;
  resolvedAt?: number;
  resolvedBy?: 'auto' | 'judge' | 'human' | 'consensus';
  consensusRatio?: '3/3' | '2/3' | 'none';
  matchedRoles?: string[];
}

export interface WordDiff {
  a: string;
  b: string;
  truth: string;
  correct: 'a' | 'b' | 'neither';
}

export interface JudgeResult {
  differences: WordDiff[];
  reading: string[];
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

export interface Diff {
  a: string;
  b: string;
}

export interface Task {
  id: string; // deterministic hash
  jobId: string;
  kind: TaskKind;
  role: Role;
  params: {
    page?: number;
    unitKey?: string;
    round?: number;
    hints?: Diff[];
    imageScale?: number;
  };
  status: TaskStatus;
  attempts: number; // counts only non-transient failures
  transientRetries: number;
  lastError?: AppError;
  startedAt?: number;
  finishedAt?: number;
  modelUsed?: string;
  gatewayHeaders?: Record<string, string>;
}

export interface AppError {
  class:
    | 'TRANSIENT_NETWORK'
    | 'TRANSIENT_UPSTREAM'
    | 'RATE_LIMIT'
    | 'AUTH'
    | 'CONFIG_MODEL'
    | 'PAYLOAD'
    | 'BAD_OUTPUT'
    | 'TRUNCATED'
    | 'EMPTY'
    | 'BUG';
  retryable: boolean;
  userMessage: string;
  retryAfterMs?: number;
  httpStatus?: number;
  raw?: string;
}

export interface AgentEndpointConfig {
  provider: 'gemini' | 'groq' | 'mistral' | 'freetheai' | 'omniroute' | 'custom';
  gatewayUrl: string;
  apiKey: string;
  model: string;
}

export interface JobSettings {
  gatewayUrl: string;
  apiKey: string; // stored encrypted or as-is; never logged
  modelA: string;
  modelB: string;
  modelC?: string;
  modelJ: string;
  agentA?: AgentEndpointConfig;
  agentB?: AgentEndpointConfig;
  agentC?: AgentEndpointConfig;
  providerKeys?: {
    gemini?: string;
    groq?: string;
    mistral?: string;
    freetheai?: string;
    omniroute?: string;
    custom?: string;
  };
  rpmA?: number;
  rpmB?: number;
  rpmC?: number;
  rpmJ?: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxReruns: number;
  judgeEachRound: boolean;
  neighborPages: number;
  concurrency: number;
  imageMaxEdge: number;
  imageFormat: 'png' | 'jpeg';
  useTextLayerHint: boolean;
  hyphenJoin: boolean;
  profile: 'fr' | 'ar' | string;
}

export interface JobStats {
  totalPages: number;
  pagesRendered: number;
  pagesExtracted: number;
  totalUnits: number;
  unitsAgreed: number;
  unitsAgreedAfterRerun: number;
  unitsJudgeResolved: number;
  unitsNeedsReview: number;
  unitsHumanResolved: number;
  unitsNeedsAttention: number;
  tasksDone: number;
  tasksTotal: number;
  startedAt?: number;
  finishedAt?: number;
  etaMs?: number;
}

export interface Job {
  id: string;
  fileName: string;
  sha256: string;
  pageCount: number;
  profile: 'fr' | 'ar' | string;
  status: JobStatus;
  settingsSnapshot: JobSettings;
  createdAt: number;
  updatedAt: number;
  pausedReason?: PauseReason;
  stats: JobStats;
  articleNumberWarnings?: string[];
}

export interface LlmCacheEntry {
  id: string; // hash(model, systemPrompt, userText, imageHashes, maxTokens)
  model: string;
  response: unknown;
  createdAt: number;
}

export interface EventLogEntry {
  id: string; // crypto random
  jobId?: string;
  taskId?: string;
  type:
    | 'job_created'
    | 'job_started'
    | 'job_paused'
    | 'job_resumed'
    | 'job_done'
    | 'job_cancelled'
    | 'task_started'
    | 'task_done'
    | 'task_retry'
    | 'task_attention'
    | 'gate_pausing'
    | 'gate_paused'
    | 'gate_probing'
    | 'gate_resumed'
    | 'gate_canary_start'
    | 'gate_canary_success'
    | 'gate_canary_fail'
    | 'human_resolved'
    | 'downscale'
    | 'compression_warning'
    | 'numbering_warning'
    | 'error';
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export const DB_NAME = 'lawtext-db';
export const DB_VERSION = 1;

// Store names
export const STORE_SETTINGS = 'settings';
export const STORE_JOBS = 'jobs';
export const STORE_PDF_BLOBS = 'pdfBlobs';
export const STORE_PAGE_IMAGES = 'pageImages';
export const STORE_TASKS = 'tasks';
export const STORE_RESULTS = 'results';
export const STORE_UNITS = 'units';
export const STORE_RESOLUTIONS = 'resolutions';
export const STORE_LLM_CACHE = 'llmCache';
export const STORE_EVENTS = 'events';
