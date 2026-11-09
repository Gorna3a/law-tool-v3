/**
 * PDF.js web worker - renders pages to images.
 * Runs in a worker context; communicates via postMessage.
 */

import * as pdfjs from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

if (typeof pdfjs.GlobalWorkerOptions !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
}

export type WorkerRequestPayload =
  | { type: 'load'; buffer: ArrayBuffer }
  | { type: 'render'; page: number; maxEdge: number; format: 'png' | 'jpeg' }
  | { type: 'textLayer'; page: number }
  | { type: 'pageCount' };

export type WorkerRequest = WorkerRequestPayload & { reqId: string };

export type WorkerResponsePayload =
  | { type: 'loaded'; pageCount: number }
  | { type: 'rendered'; page: number; blob: Blob; width: number; height: number }
  | { type: 'textLayer'; page: number; text: string }
  | { type: 'pageCount'; count: number }
  | { type: 'error'; message: string };

export type WorkerResponse = WorkerResponsePayload & { reqId: string; source: 'lawtext-pdf-worker' };

let pdfDoc: pdfjs.PDFDocumentProxy | null = null;

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (!req || typeof req !== 'object' || !('reqId' in req)) return;
  const { reqId } = req;

  const reply = (res: WorkerResponsePayload) => {
    (self as unknown as Worker).postMessage({
      ...res,
      reqId,
      source: 'lawtext-pdf-worker',
    });
  };

  try {
    if (req.type === 'load') {
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(req.buffer),
      });
      pdfDoc = await loadingTask.promise;
      reply({ type: 'loaded', pageCount: pdfDoc.numPages });
      return;
    }

    if (!pdfDoc) {
      reply({ type: 'error', message: 'PDF not loaded' });
      return;
    }

    if (req.type === 'pageCount') {
      reply({ type: 'pageCount', count: pdfDoc.numPages });
      return;
    }

    if (req.type === 'render') {
      const page = await pdfDoc.getPage(req.page);
      const viewport = page.getViewport({ scale: 1 });

      // Scale to maxEdge
      const longEdge = Math.max(viewport.width, viewport.height);
      const scale = req.maxEdge / longEdge;
      const scaledViewport = page.getViewport({ scale });

      const canvas = new OffscreenCanvas(
        Math.round(scaledViewport.width),
        Math.round(scaledViewport.height)
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No canvas 2d context');

      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport: scaledViewport,
        canvas: canvas as unknown as HTMLCanvasElement,
      } as Parameters<typeof page.render>[0]).promise;

      // Convert to blob
      const type = req.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const quality = req.format === 'jpeg' ? 0.92 : undefined;
      const blob = await canvas.convertToBlob({ type, quality });

      reply({
        type: 'rendered',
        page: req.page,
        blob,
        width: canvas.width,
        height: canvas.height,
      });
      page.cleanup();
      return;
    }

    if (req.type === 'textLayer') {
      const page = await pdfDoc.getPage(req.page);
      const content = await page.getTextContent();
      const text = content.items
        .flatMap((item) => ('str' in item ? [(item as { str: string }).str] : []))
        .join(' ')
        .trim();
      reply({ type: 'textLayer', page: req.page, text });
      page.cleanup();
      return;
    }
  } catch (err) {
    reply({ type: 'error', message: String(err) });
  }
});
