import { parentPort, workerData } from "node:worker_threads";
import { register as registerCommonJs } from "tsx/cjs/api";
import { register as registerEsm } from "tsx/esm/api";

if (!parentPort) {
  throw new Error("social-preview-worker.mjs must run inside a worker thread");
}

// Register in this thread explicitly: Node 24's --import tsx registration is
// main-thread-only.
registerCommonJs();
registerEsm();

const { renderSocialPreviewWorkerBatch } = await import("./social-preview-build.ts");
const result = await renderSocialPreviewWorkerBatch(workerData);
parentPort.postMessage(result);
