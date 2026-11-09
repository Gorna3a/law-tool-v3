/**
 * Provider catalog, vision model detection, and backend vision testing.
 */

import { GatewayClient } from './client';
import type { AgentEndpointConfig } from '../storage/schema';

export interface ProviderCatalogEntry {
  id: 'gemini' | 'groq' | 'mistral' | 'freetheai' | 'omniroute' | 'custom';
  name: string;
  defaultEndpoint: string;
  proxyEndpoint: string;
  recommendedVisionModels: string[];
}

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    proxyEndpoint: '/gemini',
    recommendedVisionModels: [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-2.0-flash-exp',
      'gemini-1.5-pro',
    ],
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    defaultEndpoint: 'https://api.mistral.ai/v1',
    proxyEndpoint: '/mistral',
    recommendedVisionModels: [
      'pixtral-12b-2409',
      'mistral-small-latest',
      'pixtral-large-latest',
      'mistral-large-latest',
    ],
  },
  groq: {
    id: 'groq',
    name: 'Groq Cloud',
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    proxyEndpoint: '/groq',
    recommendedVisionModels: [
      'qwen/qwen3.8-27b',
      'meta-llama/llama-4-scenic-17b',
      'llama-3.2-11b-vision-preview',
      'llama-3.2-90b-vision-preview',
    ],
  },
  freetheai: {
    id: 'freetheai',
    name: 'Free the AI',
    defaultEndpoint: 'https://api.freetheai.org/v1',
    proxyEndpoint: '/freetheai',
    recommendedVisionModels: [
      'gpt-4o-mini',
      'gemini-2.0-flash',
      'claude-3-5-haiku',
    ],
  },
  omniroute: {
    id: 'omniroute',
    name: 'OmniRoute Local',
    defaultEndpoint: 'http://localhost:20128',
    proxyEndpoint: '/omniroute',
    recommendedVisionModels: [
      'law-extract-a',
      'law-extract-b',
      'law-extract-c',
    ],
  },
};

// 64x64 valid PNG (white background) compatible with all vision transformers & ViT patch architectures
const VALID_TEST_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAK0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAeAM7jAABp2l9ZwAAAABJRU5ErkJggg==';

/** Match and rank vision models from raw list of model IDs returned by an endpoint */
export function filterVisionModels(provider: string, modelIds: string[]): string[] {
  const catalog = PROVIDER_CATALOG[provider];
  const recommended = catalog ? catalog.recommendedVisionModels : [];

  // Match known recommended models first in preference order
  const matches: string[] = [];
  for (const rec of recommended) {
    if (modelIds.includes(rec)) {
      matches.push(rec);
    }
  }

  // Next add any model that has vision keywords, excluding pure text/embedding models
  const visionKeywords = ['vision', 'pixtral', 'flash', '4o', 'vl', 'multimodal', 'scenic', 'qwen3.8'];
  const excludeKeywords = ['text', 'versatile', 'instant', 'embedding', 'whisper', 'moderation', 'guard', 'reward'];

  for (const id of modelIds) {
    if (!matches.includes(id)) {
      const lower = id.toLowerCase();
      const isExcluded = excludeKeywords.some((ex) => lower.includes(ex));
      if (!isExcluded && visionKeywords.some((kw) => lower.includes(kw))) {
        matches.push(id);
      }
    }
  }

  // Fallback to recommended list if none returned
  if (matches.length === 0 && recommended.length > 0) {
    return [...recommended];
  }

  return matches;
}

/** Find single best vision model */
export function findBestVisionModel(provider: string, modelIds: string[]): string {
  const visionList = filterVisionModels(provider, modelIds);
  if (visionList.length > 0) return visionList[0]!;
  const catalog = PROVIDER_CATALOG[provider];
  return catalog?.recommendedVisionModels[0] ?? 'gemini-2.5-flash';
}

/** Execute a lightweight backend vision ping to verify model vision support */
export async function testVisionCapability(
  client: GatewayClient,
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<{ ok: boolean; rttMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await client.complete(
      {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: VALID_TEST_PNG_DATA_URL } },
              { type: 'text', text: 'Respond with ONLY a JSON object: {"status":"ok"}' },
            ],
          },
        ],
        max_tokens: 30,
      },
      undefined,
      undefined,
      { baseUrl, apiKey, timeoutMs: 25_000 }
    );
    return { ok: true, rttMs: Date.now() - start };
  } catch (err: unknown) {
    const errorObj = err as { userMessage?: string; message?: string; raw?: string; httpStatus?: number };
    const status = errorObj.httpStatus;
    let msg = errorObj.userMessage || errorObj.raw || errorObj.message || String(err);
    if (status === 429 || msg.includes('429')) {
      msg = 'Rate limit exceeded (HTTP 429). Please wait a few seconds before testing again.';
    } else if (status === 400 || msg.includes('400')) {
      msg = `Model '${model}' does not support vision or image was rejected (HTTP 400).`;
    } else if (status === 503 || msg.includes('503')) {
      msg = 'Provider service temporarily busy (HTTP 503).';
    }
    return { ok: false, rttMs: Date.now() - start, error: msg };
  }
}
