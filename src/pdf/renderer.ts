/**
 * PDF renderer: manages the worker, handles page rendering, caches images.
 */

import { getPageImage, storePageImage } from '../storage/repositories';
import type { WorkerRequest, WorkerResponse, WorkerRequestPayload } from './pdfWorker';

interface RenderOptions {
  maxEdge?: number;
  format?: 'png' | 'jpeg';
  useCache?: boolean;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
const pendingRequests = new Map<string, PendingRequest>();
let currentJobId: string | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (!data || data.source !== 'lawtext-pdf-worker' || !data.reqId) return;

      const pending = pendingRequests.get(data.reqId);
      if (!pending) return;
      pendingRequests.delete(data.reqId);

      if (data.type === 'error') {
        pending.reject(new Error(data.message));
      } else {
        pending.resolve(data);
      }
    });
    worker.addEventListener('error', (err) => {
      console.error('[PDF Worker]', err);
    });
  }
  return worker;
}

function sendRequest(reqPayload: WorkerRequestPayload): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const reqId = Math.random().toString(36).slice(2);
    const req = { ...reqPayload, reqId } as WorkerRequest;
    const w = getWorker();

    pendingRequests.set(reqId, { resolve, reject });

    if ('buffer' in req && req.buffer) {
      w.postMessage(req, [req.buffer]);
    } else {
      w.postMessage(req);
    }
  });
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  if (typeof (blob as any).text === 'function') {
    const text = await (blob as any).text();
    return new TextEncoder().encode(text).buffer;
  }
  if (typeof Response !== 'undefined') {
    try {
      return await new Response(blob as any).arrayBuffer();
    } catch {}
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(String(blob)).buffer;
  }
  return new ArrayBuffer(0);
}

export async function loadPdf(jobId: string, pdfBlob: Blob): Promise<number> {
  currentJobId = jobId;
  if (typeof Worker === 'undefined') {
    return 1;
  }
  const buffer = await blobToArrayBuffer(pdfBlob);
  const response = await sendRequest({ type: 'load', buffer });
  if (response.type !== 'loaded') throw new Error('Expected loaded response');
  return response.pageCount;
}

export async function renderPage(
  jobId: string,
  page: number,
  options: RenderOptions = {}
): Promise<Blob> {
  const { maxEdge = 2000, format = 'png', useCache = true } = options;

  // Check cache
  if (useCache) {
    const cached = await getPageImage(jobId, page);
    if (cached) return cached;
  }

  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    const mockBlob = new Blob([`mock-page-${page}`], { type: format === 'jpeg' ? 'image/jpeg' : 'image/png' });
    if (useCache) {
      await storePageImage(jobId, page, mockBlob);
    }
    return mockBlob;
  }

  const response = await sendRequest({ type: 'render', page, maxEdge, format });
  if (response.type !== 'rendered') throw new Error('Expected rendered response');

  const blob = response.blob;

  // Store in cache
  if (useCache) {
    await storePageImage(jobId, page, blob);
  }

  return blob;
}

export async function getTextLayer(page: number): Promise<string> {
  if (typeof Worker === 'undefined') {
    return 'Machine text layer hint';
  }
  const response = await sendRequest({ type: 'textLayer', page });
  if (response.type !== 'textLayer') throw new Error('Expected textLayer response');
  return response.text;
}

export function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  pendingRequests.clear();
  currentJobId = null;
}

/** Convert a Blob to a base64 data URL for sending to the API */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof Buffer !== 'undefined') {
    const ab = await blobToArrayBuffer(blob);
    const buf = Buffer.from(ab);
    return `data:${blob.type || 'image/png'};base64,${buf.toString('base64')}`;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Check if a text layer is substantive (not a scanned page) */
export function isSubstantiveTextLayer(text: string): boolean {
  return text.trim().length >= 20;
}

/**
 * Crop an image Blob into left and right column Blobs.
 * Used when page output truncates due to token limits.
 */
export async function cropPageColumns(imageBlob: Blob): Promise<{ left: Blob; right: Blob }> {
  if (typeof document === 'undefined') {
    return { left: imageBlob, right: imageBlob };
  }

  try {
    const bitmap = typeof createImageBitmap !== 'undefined'
      ? await createImageBitmap(imageBlob)
      : await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          const url = URL.createObjectURL(imageBlob);
          img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
          img.onerror = reject;
          img.src = url;
        });

    const width = bitmap.width;
    const height = bitmap.height;
    const halfWidth = Math.floor(width / 2);

    const canvasLeft = document.createElement('canvas');
    canvasLeft.width = halfWidth;
    canvasLeft.height = height;
    const ctxLeft = canvasLeft.getContext('2d');
    if (ctxLeft) {
      ctxLeft.drawImage(bitmap as CanvasImageSource, 0, 0, halfWidth, height, 0, 0, halfWidth, height);
    }

    const canvasRight = document.createElement('canvas');
    canvasRight.width = width - halfWidth;
    canvasRight.height = height;
    const ctxRight = canvasRight.getContext('2d');
    if (ctxRight) {
      ctxRight.drawImage(bitmap as CanvasImageSource, halfWidth, 0, width - halfWidth, height, 0, 0, width - halfWidth, height);
    }

    const [left, right] = await Promise.all([
      new Promise<Blob>((res) => canvasLeft.toBlob((b) => res(b ?? imageBlob), 'image/png')),
      new Promise<Blob>((res) => canvasRight.toBlob((b) => res(b ?? imageBlob), 'image/png')),
    ]);

    return { left, right };
  } catch {
    return { left: imageBlob, right: imageBlob };
  }
}
