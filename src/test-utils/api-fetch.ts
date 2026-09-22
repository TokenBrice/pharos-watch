import { vi } from "vitest";
import { jsonResponse } from "@shared/test-utils/mock-fetch";

/** One-shot JSON fetch stub; returns the spy so callers can assert the request. */
export function mockJsonOnce(body: unknown, status = 200, headers?: Record<string, string>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body, status, headers));
}

/**
 * Fetch stub that never settles on its own: it rejects only when the request
 * signal aborts, so timeout and caller-abort paths are observable.
 */
export function mockAbortableFetch(fallbackReason: DOMException) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? fallbackReason);
        });
      }),
  );
}

/** Snapshot an env var and return the teardown that restores (or deletes) it. */
export function captureEnvVar(key: string): () => void {
  const original = process.env[key];
  return () => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  };
}
