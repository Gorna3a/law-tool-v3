import { classify, classifyOutputError, parseRetryAfterHeader, isCorsError } from './errorClassifier';
import type { AppError, Role } from '../storage/schema';
import { getLlmCache, putLlmCache } from '../storage/repositories';
import { hashString } from '../utils/hash';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  stream?: false;
}

export interface CompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GatewayResult {
  data: CompletionResponse;
  modelUsed: string;
  gatewayHeaders: Record<string, string>;
  fromCache: boolean;
}

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

// Headers to capture from responses
const CAPTURE_HEADERS = [
  'x-omniroute-model',
  'x-omniroute-provider',
  'x-omniroute-compression',
  'x-omniroute-latency',
  'x-omniroute-combo',
  'x-request-id',
];

export class GatewayClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  /** Global abort controller group for pausing all in-flight requests */
  private abortGroup: AbortController | null = null;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/$/, '').replace(/\/v1$/, '');
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  updateOptions(options: Partial<GatewayClientOptions>): void {
    if (options.baseUrl !== undefined) {
      this.baseUrl = options.baseUrl.trim().replace(/\/$/, '').replace(/\/v1$/, '');
    }
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey.trim();
    }
    if (options.timeoutMs !== undefined) {
      this.timeoutMs = options.timeoutMs;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private getEndpoint(path: string, baseUrlOverride?: string): string {
    const base = (baseUrlOverride ?? this.baseUrl).replace(/\/$/, '');
    if (base.includes('generativelanguage.googleapis.com')) {
      return `${base}${path.replace(/^\/v1/, '')}`;
    }
    return `${base}${path}`;
  }

  /** Create a new group abort controller (called when gate goes PAUSING) */
  createAbortGroup(): AbortController {
    this.abortGroup = new AbortController();
    return this.abortGroup;
  }

  /** Abort all in-flight requests */
  abortAll(): void {
    this.abortGroup?.abort();
    this.abortGroup = null;
  }

  async healthCheck(baseUrlOverride?: string, apiKeyOverride?: string): Promise<{ ok: boolean; rttMs: number; raw?: string }> {
    const start = Date.now();
    const base = (baseUrlOverride ?? this.baseUrl).replace(/\/$/, '');
    const isOmniRoute = base.includes('20128') || base.includes('omniroute');

    if (!isOmniRoute) {
      // Direct models probe for OpenAI compatible providers like Free the AI or Google Gemini
      try {
        const url = this.getEndpoint('/v1/models', base);
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
          headers: this.authHeaders(apiKeyOverride),
        });
        return { ok: res.ok, rttMs: Date.now() - start, raw: `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, rttMs: Date.now() - start, raw: String(err) };
      }
    }

    try {
      // First try OmniRoute v3.8+ monitoring health endpoint
      const resMon = await fetch(`${base}/api/monitoring/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (resMon.ok) {
        return { ok: true, rttMs: Date.now() - start };
      }
      // Next try standard /api/health
      const res = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return { ok: true, rttMs: Date.now() - start };
      }
      // If health endpoints returned non-200, fallback to /v1/models with key
      const res2 = await fetch(`${base}/v1/models`, {
        signal: AbortSignal.timeout(10_000),
        headers: this.authHeaders(apiKeyOverride),
      });
      return { ok: res2.ok, rttMs: Date.now() - start, raw: `HTTP ${res2.status}` };
    } catch (err) {
      // Try /api/health if monitoring threw
      try {
        const res = await fetch(`${base}/api/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          return { ok: true, rttMs: Date.now() - start };
        }
      } catch {}

      // Fallback to /v1/models before giving up
      try {
        const res2 = await fetch(`${base}/v1/models`, {
          signal: AbortSignal.timeout(10_000),
          headers: this.authHeaders(apiKeyOverride),
        });
        return { ok: res2.ok, rttMs: Date.now() - start, raw: `HTTP ${res2.status}` };
      } catch {
        return { ok: false, rttMs: Date.now() - start, raw: String(err) };
      }
    }
  }

  async listModels(baseUrlOverride?: string, apiKeyOverride?: string): Promise<{ id: string; owned_by: string }[]> {
    const url = this.getEndpoint('/v1/models', baseUrlOverride);
    const res = await fetch(url, {
      headers: this.authHeaders(apiKeyOverride),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw classify(null, res.status, await res.text());
    }
    const json = (await res.json()) as { data: { id: string; owned_by: string }[] };
    return json.data ?? [];
  }

  async complete(
    request: CompletionRequest,
    signal?: AbortSignal,
    role?: Role,
    overrides?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }
  ): Promise<GatewayResult> {
    const effectiveBaseUrl = (overrides?.baseUrl?.trim() || this.baseUrl).replace(/\/$/, '').replace(/\/v1$/, '');
    const effectiveApiKey = overrides?.apiKey !== undefined ? overrides.apiKey.trim() : this.apiKey;
    const effectiveTimeoutMs = overrides?.timeoutMs ?? this.timeoutMs;

    // Cache check
    const cacheKey = await buildCacheKey(request);
    const cached = await getLlmCache(cacheKey);
    if (cached) {
      const data = cached.response as CompletionResponse;
      return {
        data,
        modelUsed: data.model,
        gatewayHeaders: {},
        fromCache: true,
      };
    }

    // Merge abort signals
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), effectiveTimeoutMs);
    const signals = [timeoutController.signal];
    if (signal) signals.push(signal);
    if (this.abortGroup) signals.push(this.abortGroup.signal);
    const merged = anyAbort(signals);

    try {
      const targetUrl = this.getEndpoint('/v1/chat/completions', effectiveBaseUrl);
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          ...this.authHeaders(effectiveApiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...request, stream: false }),
        signal: merged,
      });

      clearTimeout(timeoutId);

      // Capture gateway headers
      const gatewayHeaders: Record<string, string> = {};
      for (const h of CAPTURE_HEADERS) {
        const v = res.headers.get(h);
        if (v) gatewayHeaders[h] = v;
      }

      // Check for compression warning
      if (gatewayHeaders['x-omniroute-compression']) {
        console.warn('[LawText] Prompt compression detected! This may alter transcription accuracy.');
      }

      if (!res.ok) {
        const bodyText = await res.text();
        const retryAfterMs = parseRetryAfterHeader(res.headers);
        const err = classify(null, res.status, bodyText);
        if (retryAfterMs && !err.retryAfterMs) {
          err.retryAfterMs = retryAfterMs;
        }
        throw err;
      }

      let data: CompletionResponse;
      try {
        data = (await res.json()) as CompletionResponse;
      } catch {
        throw classifyOutputError('bad_json');
      }

      if (!data.choices?.[0]?.message?.content) {
        throw classifyOutputError('empty');
      }

      const finishReason = data.choices[0]?.finish_reason;
      if (finishReason === 'length') {
        throw classifyOutputError('truncated');
      }
      if (finishReason === 'content_filter') {
        throw classifyOutputError('empty');
      }

      // Store in cache
      await putLlmCache({ id: cacheKey, model: request.model, response: data, createdAt: Date.now() });

      void role; // used by caller for throttle

      return {
        data,
        modelUsed: data.model || request.model,
        gatewayHeaders,
        fromCache: false,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      // If it's already an AppError, rethrow
      if (isAppError(err)) throw err;

      // CORS detection
      if (isCorsError(err)) {
        const corsErr: AppError = {
          class: 'TRANSIENT_NETWORK',
          retryable: true,
          userMessage:
            'Request blocked by CORS policy. Check that your OmniRoute gateway has the correct origin allow-list, and that you are not mixing HTTP/HTTPS. See README for setup guide.',
          raw: String(err),
        };
        throw corsErr;
      }

      throw classify(err);
    }
  }

  private authHeaders(keyOverride?: string): Record<string, string> {
    const key = keyOverride !== undefined ? keyOverride.trim() : this.apiKey;
    if (!key) return {};
    return {
      Authorization: `Bearer ${key}`,
      'x-goog-api-key': key,
    };
  }
}

function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'class' in e && 'retryable' in e;
}

async function buildCacheKey(request: CompletionRequest): Promise<string> {
  const parts: string[] = [request.model, String(request.max_tokens ?? '')];
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') {
          parts.push(part.text);
        } else {
          // hash the image URL (which is a data URL, so hash its content)
          const h = await hashString(part.image_url.url.slice(0, 200));
          parts.push('img:' + h);
        }
      }
    }
  }
  return hashString(parts.join('|'));
}

function anyAbort(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
