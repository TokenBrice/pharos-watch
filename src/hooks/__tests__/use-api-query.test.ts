// Tests for use-api-query.ts — exercises the createApiQueryFn / createApiPollingQueryOptions
// layer via its real dependency: @/lib/api apiFetch.
//
// We mock the global fetch (the HTTP boundary), not apiFetch itself, so that
// the schema validation and contractMode paths in apiFetch are exercised for real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

// Stub modules that are not relevant to what we're testing here.
vi.mock("@shared/lib/site-data-lane", () => ({
  isSiteDataAllowedUiHostname: () => false,
  resolveSiteDataProxyPath: (p: string) => p,
}));
vi.mock("@shared/lib/runtime-origins", () => ({
  resolvePublicApiBase: () => "https://api.pharos.watch",
}));

import {
  createApiQueryFn,
  createApiPollingQueryOptions,
  getPollingWindow,
  createStaticQueryOptions,
} from "../use-api-query";

const SomeSchema = z.object({ value: z.number() });
type SomeData = z.infer<typeof SomeSchema>;

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function withAbortSignalAnyAbsent<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    value: undefined,
  });
  try {
    return await run();
  } finally {
    if (descriptor) {
      Object.defineProperty(AbortSignal, "any", descriptor);
    } else {
      delete (AbortSignal as unknown as { any?: typeof AbortSignal.any }).any;
    }
  }
}

describe("use-api-query", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // getPollingWindow / createApiPollingQueryOptions
  // ------------------------------------------------------------------
  describe("getPollingWindow", () => {
    it("encodes staleTime = interval, refetchInterval = 2× interval", () => {
      const { staleTime, refetchInterval } = getPollingWindow(30_000);
      expect(staleTime).toBe(30_000);
      expect(refetchInterval).toBe(60_000);
    });
  });

  describe("createApiPollingQueryOptions", () => {
    it("sets default retry=2 and propagates opts overrides", () => {
      const opts = createApiPollingQueryOptions(["k"], "/api/x", 15_000);
      expect(opts.staleTime).toBe(15_000);
      expect(opts.refetchInterval).toBe(30_000);
      expect(opts.retry).toBe(2);
      expect(opts.enabled).toBeUndefined();
    });

    it("respects enabled=false and retry override", () => {
      const opts = createApiPollingQueryOptions(["k"], "/api/x", 15_000, {
        enabled: false,
        retry: 0,
      });
      expect(opts.enabled).toBe(false);
      expect(opts.retry).toBe(0);
    });
  });

  describe("createStaticQueryOptions", () => {
    it("disables polling and sets staleTime=Infinity", () => {
      const opts = createStaticQueryOptions(["static"], async () => 42);
      expect(opts.staleTime).toBe(Infinity);
      expect(opts.refetchInterval).toBe(false);
      expect(opts.retry).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // createApiQueryFn — schema-success
  // ------------------------------------------------------------------
  describe("createApiQueryFn — schema success", () => {
    it("resolves with parsed data when response matches schema", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeJsonResponse({ value: 42 }));

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema);
      const result = await fn();
      expect(result).toEqual({ value: 42 });
    });

    it("resolves without schema when no schema provided", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeJsonResponse({ anything: true }));

      const fn = createApiQueryFn<{ anything: boolean }>("/api/test");
      const result = await fn();
      expect(result).toEqual({ anything: true });
    });
  });

  // ------------------------------------------------------------------
  // createApiQueryFn — schema-mismatch strict mode (default)
  // ------------------------------------------------------------------
  describe("createApiQueryFn — schema mismatch in strict mode", () => {
    it("throws SchemaValidationError when required field is missing (default strict)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeJsonResponse({ wrong: "field" }));

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema);
      await expect(fn()).rejects.toThrow(/Schema validation failed/);
    });
  });

  // ------------------------------------------------------------------
  // createApiQueryFn — schema-mismatch warn mode
  // ------------------------------------------------------------------
  describe("createApiQueryFn — schema mismatch in warn mode", () => {
    it("resolves with raw data and logs a warning when contractMode=warn", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeJsonResponse({ wrong: "field" }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema, undefined, "warn");
      const result = await fn();

      // The raw (invalid) payload comes through
      expect(result).toEqual({ wrong: "field" });
      // A console.warn was emitted with the contract failure context
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[API contract]"),
        expect.objectContaining({ endpoint: "/api/test" }),
      );
    });
  });

  // ------------------------------------------------------------------
  // createApiQueryFn — network failure
  // ------------------------------------------------------------------
  describe("createApiQueryFn — network failure", () => {
    it("propagates fetch rejection as-is", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network error"));

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema);
      await expect(fn()).rejects.toThrow("Network error");
    });
  });

  // ------------------------------------------------------------------
  // createApiQueryFn — non-OK HTTP response
  // ------------------------------------------------------------------
  describe("createApiQueryFn — non-OK response", () => {
    it("throws ApiFetchError on 500", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeJsonResponse({ error: "Internal Server Error" }, 500));

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema);
      await expect(fn()).rejects.toThrow(/Failed to fetch \/api\/test: 500/);
    });
  });

  // ------------------------------------------------------------------
  // createApiQueryFn — abort signal forwarding
  // ------------------------------------------------------------------
  describe("createApiQueryFn — abort signal", () => {
    it("aborts the in-flight fetch when the context signal is aborted", async () => {
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return makeJsonResponse({ value: 7 });
      });

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema);
      await fn({ signal: controller.signal });

      // apiFetch wraps the caller's signal with a timeout signal via
      // AbortSignal.any([parent, timeout]), so the reference won't be identical.
      // Assert the composed signal aborts when the parent is aborted.
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
    });

    it("falls back when AbortSignal.any is absent and either merged signal aborts", async () => {
      await withAbortSignalAnyAbsent(async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        for (const abortSource of ["fetchInit", "context"] as const) {
          const response = deferred<Response>();
          const fetchInitController = new AbortController();
          const contextController = new AbortController();
          let capturedSignal: AbortSignal | undefined;

          fetchSpy.mockImplementationOnce(async (_url, init) => {
            capturedSignal = init?.signal ?? undefined;
            return response.promise;
          });

          const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema, { signal: fetchInitController.signal });
          const promise = fn({ signal: contextController.signal });
          await Promise.resolve();

          expect(capturedSignal).toBeDefined();
          const signal = capturedSignal!;
          expect(signal.aborted).toBe(false);

          if (abortSource === "fetchInit") {
            fetchInitController.abort(new Error("fetch-init-abort"));
          } else {
            contextController.abort(new Error("context-abort"));
          }
          expect(signal.aborted).toBe(true);

          response.resolve(makeJsonResponse({ value: abortSource === "fetchInit" ? 8 : 9 }));
          await expect(promise).resolves.toEqual({ value: abortSource === "fetchInit" ? 8 : 9 });
        }
      });
    });
  });

  // ------------------------------------------------------------------
  // createApiPollingQueryOptions — option shape
  // ------------------------------------------------------------------
  describe("createApiPollingQueryOptions", () => {
    it("produces options with correct key, staleTime, refetchInterval", () => {
      const opts = createApiPollingQueryOptions<SomeData>(["test-key"], "/api/test", 60_000, { schema: SomeSchema });

      expect(opts.queryKey).toEqual(["test-key"]);
      expect(opts.staleTime).toBe(60_000);
      expect(opts.refetchInterval).toBe(120_000);
      expect(opts.retry).toBe(2);
    });

    it("calls apiFetch with correct path when queryFn is invoked", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(makeJsonResponse({ value: 99 }));

      const opts = createApiPollingQueryOptions<SomeData>(["test-key"], "/api/test", 60_000, { schema: SomeSchema });

      const queryFn = opts.queryFn;
      expect(queryFn).toBeTypeOf("function");
      if (typeof queryFn !== "function") throw new Error("Expected an API polling query function");
      const result = await queryFn({
        client: new QueryClient(),
        signal: new AbortController().signal,
        queryKey: opts.queryKey,
        meta: undefined,
      });
      expect(result).toEqual({ value: 99 });
    });
  });
});
