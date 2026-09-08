// Tests for use-api-query.ts — exercises the createApiQueryFn / createApiPollingQueryOptions
// layer via its real dependency: @/lib/api apiFetch.
//
// We mock the global fetch (the HTTP boundary), not apiFetch itself, so that
// the schema validation and contractMode paths in apiFetch are exercised for real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { z } from "zod";
import { jsonResponse as makeJsonResponse } from "@shared/test-utils/mock-fetch";

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
      Reflect.deleteProperty(AbortSignal, "any");
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
    it("sets the query key and default timing/retry policy", () => {
      const opts = createApiPollingQueryOptions(["k"], "/api/x", 15_000);
      expect(opts.queryKey).toEqual(["k"]);
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

    it("passes explicit falsy controls through to the built options", () => {
      const opts = createApiPollingQueryOptions(["k"], "/api/x", 15_000, {
        staleTime: 0,
        refetchInterval: false,
      });
      expect(opts.staleTime).toBe(0);
      expect(opts.refetchInterval).toBe(false);
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
      vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal!.addEventListener("abort", () => {
            reject(capturedSignal!.reason ?? new DOMException("aborted", "AbortError"));
          });
        });
      });

      const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema);
      const promise = fn({ signal: controller.signal });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());
      expect(capturedSignal!.aborted).toBe(false);

      // apiFetch composes the caller signal with a timeout signal, so the
      // fetch-level reference is a merged signal rather than the caller's.
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
      await expect(promise).rejects.toThrow();
    });

    it("rejects the pending query when either merged signal aborts without AbortSignal.any", async () => {
      await withAbortSignalAnyAbsent(async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        for (const abortSource of ["fetchInit", "context"] as const) {
          const fetchInitController = new AbortController();
          const contextController = new AbortController();
          let capturedSignal: AbortSignal | undefined;

          fetchSpy.mockImplementationOnce((_url, init) => {
            capturedSignal = init?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
              capturedSignal!.addEventListener("abort", () => {
                reject(capturedSignal!.reason ?? new DOMException("aborted", "AbortError"));
              });
            });
          });

          const fn = createApiQueryFn<SomeData>("/api/test", SomeSchema, { signal: fetchInitController.signal });
          const promise = fn({ signal: contextController.signal });
          await vi.waitFor(() => expect(capturedSignal).toBeDefined());
          expect(capturedSignal!.aborted).toBe(false);

          const abortReason = new Error(`${abortSource}-abort`);
          if (abortSource === "fetchInit") {
            fetchInitController.abort(abortReason);
          } else {
            contextController.abort(abortReason);
          }

          expect(capturedSignal!.aborted).toBe(true);
          await expect(promise).rejects.toThrow(`${abortSource}-abort`);
        }
      });
    });
  });

  // ------------------------------------------------------------------
  // createApiPollingQueryOptions — key transitions and queryFn wiring
  // ------------------------------------------------------------------
  describe("createApiPollingQueryOptions — key transitions", () => {
    function installPendingFetch() {
      const pending = new Map<string, (payload: SomeData) => void>();
      vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
        return new Promise<Response>((resolve) => {
          pending.set(String(input), (payload) => resolve(makeJsonResponse(payload)));
        });
      });
      return {
        async release(pathSuffix: string, payload: SomeData) {
          await vi.waitFor(() => {
            const match = [...pending.keys()].find((url) => url.includes(pathSuffix));
            if (!match) throw new Error(`no pending request matching ${pathSuffix}`);
            pending.get(match)!(payload);
          });
        },
      };
    }

    function filterOptions(filter: string, keepPreviousData?: boolean) {
      return createApiPollingQueryOptions<SomeData>(
        ["filter-surface", filter],
        `/api/filter-${filter}`,
        15_000,
        { keepPreviousData, staleTime: 0, refetchInterval: false, retry: false },
      );
    }

    it("keeps prior data visible while a replacement key fetch is pending", async () => {
      const http = installPendingFetch();
      const observer = new QueryObserver(new QueryClient(), filterOptions("a", true));
      const unsubscribe = observer.subscribe(() => undefined);

      await http.release("filter-a", { value: 1 });
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ value: 1 }));

      observer.setOptions(filterOptions("b", true));

      await vi.waitFor(() => {
        expect(observer.getCurrentResult()).toMatchObject({
          data: { value: 1 },
          isPlaceholderData: true,
        });
      });

      await http.release("filter-b", { value: 2 });
      await vi.waitFor(() => {
        expect(observer.getCurrentResult()).toMatchObject({
          data: { value: 2 },
          isPlaceholderData: false,
        });
      });
      unsubscribe();
    });

    it("drops visible data while a replacement key fetch is pending without keepPreviousData", async () => {
      const http = installPendingFetch();
      const observer = new QueryObserver(new QueryClient(), filterOptions("a"));
      const unsubscribe = observer.subscribe(() => undefined);

      await http.release("filter-a", { value: 1 });
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ value: 1 }));

      observer.setOptions(filterOptions("b"));

      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBeUndefined());
      // The replacement request is still in flight; the surface stays empty.
      await http.release("filter-b", { value: 2 });
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual({ value: 2 }));
      unsubscribe();
    });

    it("calls apiFetch with the configured path when queryFn is invoked", async () => {
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
