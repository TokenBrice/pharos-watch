import { vi, type Mock } from "vitest";

/**
 * Four options is the agreed ceiling: at a fifth behaviour knob, split the
 * helper into two named factories (`mockFetchRetryPassthrough` /
 * `mockFetchRetryOverBase`) instead of adding another flag.
 */
export interface MockFetchRetryOptions {
  /**
   * Base mock the JSON/text wrappers delegate to. Supply the suite's own
   * `fetchWithRetryMock` when the tests drive the transport directly; omit it to
   * get a passthrough to the global `fetch` (which the suite controls through
   * `mockFetch`/`vi.stubGlobal`).
   */
  fetchWithRetry?: Mock;
  /**
   * Mirror the production wrapper's "a non-2xx response yields no body" contract:
   * drain the body and resolve `null` instead of parsing it. Opt-in, because most
   * suites resolve only 2xx responses and assert on the parsed body.
   */
  notOkAsNull?: boolean;
  /**
   * Resolve a base result that is not a real `Response` straight through, so a
   * test may hand back the already-shaped `{ response, body }` result. Opt-in:
   * suites that resolve duck-typed `Response` stubs need the normal parse path.
   */
  passthroughNonResponse?: boolean;
  /**
   * Mirror the production wrapper's exhausted-retry contract: a transport error
   * or an unparseable body resolves `null` rather than rejecting. Opt-in, because
   * most suites want an unexpected throw to surface as a test failure.
   */
  failureAsNull?: boolean;
}

/** Minimal surface the wrappers touch, so duck-typed `Response` stubs keep working. */
interface ResponseLike {
  ok: boolean;
  body?: { cancel(): Promise<void> } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Build the common stub for `worker/src/lib/fetch-retry`.
 *
 * Used when the retry wrapper itself is not under test: `fetchJsonWithRetry` and
 * `fetchTextWithRetry` are derived from a single base mock, so a suite only has
 * to control one transport seam. Every argument is forwarded to the base, so
 * `toHaveBeenCalledWith(url, init, retries, options)` assertions still see the
 * caller's full argument list.
 *
 * Usage:
 *   vi.mock("../../lib/fetch-retry", () => mockFetchRetry());
 *   vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ fetchWithRetry: fetchWithRetryMock }));
 */
export function mockFetchRetry(options: MockFetchRetryOptions = {}) {
  const { notOkAsNull = false, passthroughNonResponse = false, failureAsNull = false } = options;
  const fetchWithRetry: Mock =
    options.fetchWithRetry ?? vi.fn(async (url: string, init?: RequestInit) => fetch(url, init));

  type Resolved = { kind: "empty" } | { kind: "raw"; value: unknown } | { kind: "response"; value: ResponseLike };

  async function resolveResponse(args: unknown[]): Promise<Resolved> {
    const response: unknown = await fetchWithRetry(...args);
    if (!response) return { kind: "empty" };
    if (passthroughNonResponse && !(response instanceof Response)) return { kind: "raw", value: response };
    const responseLike = response as ResponseLike;
    if (notOkAsNull && !responseLike.ok) {
      await responseLike.body?.cancel();
      return { kind: "empty" };
    }
    return { kind: "response", value: responseLike };
  }

  function readBody(read: (response: ResponseLike) => Promise<unknown>) {
    return async (...args: unknown[]): Promise<unknown> => {
      try {
        const resolved = await resolveResponse(args);
        if (resolved.kind === "empty") return null;
        if (resolved.kind === "raw") return resolved.value;
        return { response: resolved.value, body: await read(resolved.value) };
      } catch (error) {
        if (!failureAsNull) throw error;
        return null;
      }
    };
  }

  return {
    fetchWithRetry,
    fetchJsonWithRetry: vi.fn(readBody(async (response) => await response.json())),
    fetchTextWithRetry: vi.fn(readBody(async (response) => await response.text())),
  };
}
