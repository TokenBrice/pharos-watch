import { parentPort, workerData } from "node:worker_threads";
import { register as registerCommonJs } from "tsx/cjs/api";
import { register as registerEsm } from "tsx/esm/api";

// Register in this thread explicitly: Node 24's --import tsx registration is
// main-thread-only. Avoid tsImport namespaces so Beasties resolves normally.
registerCommonJs();
registerEsm();
const { optimizeCriticalCssBatch } = await import("./inline-homepage-critical-css.ts");
const results = await optimizeCriticalCssBatch(workerData.outDir, workerData.filePaths);
parentPort.postMessage(results);
