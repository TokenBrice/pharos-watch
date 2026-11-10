// Nightly tier: PR coverage retained by worker/src/lib/__tests__/response-body.test.ts
/**
 * Workerd evidence for the response-body readers: a second V8 (workerd) runtime
 * proves null-body, byte-stream and cancellation observations match the Node
 * cases. It spawns `unstable_dev` (60 s), so it belongs to the nightly full
 * suite; the PR tier keeps every branch it asserts in the Node project
 * (`response-body.test.ts`): null bodies, consumed/locked bodies, stall+cancel
 * and the UTF-8 byte caps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { unstable_dev, unstable_readConfig } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";
import { expect, it } from "vitest";

it("preserves null-body, byte-stream and cancellation evidence in workerd", async () => {
  const root = resolve(import.meta.dirname, "../../../..");
  mkdirSync(resolve(root, "agents"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, "agents/response-body-runtime-"));
  let worker: Unstable_DevWorker | undefined;
  try {
    const config = resolve(scratch, "wrangler.json");
    const entry = resolve(scratch, "worker.ts");
    const production = unstable_readConfig({ config: resolve(root, "worker/wrangler.toml") });
    writeFileSync(config, JSON.stringify({
      name: "response-body-runtime-test",
      compatibility_date: production.compatibility_date,
      compatibility_flags: production.compatibility_flags,
      tsconfig: relative(scratch, resolve(root, "worker/tsconfig.json")),
    }));
    writeFileSync(entry, `
      import {
        readResponseBytesWithinLimitWithSignal as bytes,
        readResponseTextWithinLimitWithSignal as text,
        readResponseJsonWithinLimitWithSignal as json,
      } from ${JSON.stringify(resolve(root, "worker/src/lib/response-body.ts"))};
      export default {
        async fetch() {
          const observations = [];
          const observe = evidence => observations.push(evidence);
          const emptyBytes = await bytes(new Response(null), 0, undefined, observe);
          const emptyText = await text(new Response(null), 0, undefined, observe);
          let jsonError;
          try { await json(new Response(null), 0, undefined, observe); }
          catch (error) { jsonError = error.name; }
          const body = await bytes(new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0, 128, 255]));
              controller.close();
            },
          })), 3, undefined, observe);
          let cancelReason;
          const parent = new AbortController();
          const reason = new Error("parent stopped");
          const stalled = new Response(new ReadableStream({
            cancel(value) { cancelReason = value; },
          }));
          const pending = bytes(stalled, 3, parent.signal, observe);
          const rejected = pending.catch(error => error === reason);
          parent.abort(reason);
          return Response.json({
            emptyBytes: [...emptyBytes], emptyText, jsonError, body: [...body],
            originalReason: await rejected, cancelled: cancelReason === reason, observations,
          });
        },
      };
    `);
    worker = await unstable_dev(entry, {
      config, local: true, persist: false, logLevel: "error", port: 0,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    });
    const response = await worker.fetch("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      emptyBytes: [], emptyText: "", jsonError: "SyntaxError", body: [0, 128, 255],
      originalReason: true, cancelled: true,
      observations: [
        { intakeBytes: null, declaredBytes: null, limitBytes: 0, outcome: "accepted" },
        { intakeBytes: null, declaredBytes: null, limitBytes: 0, outcome: "accepted" },
        { intakeBytes: null, declaredBytes: null, limitBytes: 0, outcome: "rejected" },
        { intakeBytes: 3, declaredBytes: null, limitBytes: 3, outcome: "accepted" },
        { intakeBytes: 0, declaredBytes: null, limitBytes: 3, outcome: "rejected" },
      ],
    });
  } finally {
    try { await worker?.stop(); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}, 60_000);
