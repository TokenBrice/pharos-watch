import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

// tsImport registers tsx in this thread (including CommonJS TS support). A .mjs
// entry also works when the parent uses node --import tsx rather than tsx's CLI.
const { optimizeCriticalCssBatch } = await tsImport("./inline-homepage-critical-css.ts", import.meta.url);
const results = await optimizeCriticalCssBatch(workerData.outDir, workerData.filePaths);
parentPort.postMessage(results);
