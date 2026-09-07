import { createWorker, type Worker } from 'tesseract.js';

/**
 * Thin wrapper around tesseract.js. Configured with an explicit langPath
 * pointing at a GitHub-hosted mirror of the trained data, because the
 * library's default CDN (jsdelivr) is blocked in some restrictive network
 * environments (confirmed during development: this sandbox blocks
 * jsdelivr.net but allows raw.githubusercontent.com — a personal-tool
 * deployment on Railway/Render will very likely have unrestricted internet
 * access and could use either, but pinning to the mirror keeps behavior
 * identical between environments rather than silently depending on which
 * CDN happens to be reachable).
 *
 * A worker is expensive to spin up (loads the WASM engine + trained data),
 * so callers doing multiple recognitions should reuse one worker rather
 * than creating one per image — see evidenceRepairService.ts.
 */

const LANG_DATA_MIRROR = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast';

let sharedWorker: Worker | null = null;

async function getWorker(): Promise<Worker> {
  if (!sharedWorker) {
    sharedWorker = await createWorker('eng', 1, {
      langPath: LANG_DATA_MIRROR,
      gzip: true,
    });
  }
  return sharedWorker;
}

export async function recognizeText(imageBuffer: Buffer): Promise<string> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  return data.text;
}

export async function shutdownOcrWorker(): Promise<void> {
  if (sharedWorker) {
    await sharedWorker.terminate();
    sharedWorker = null;
  }
}
