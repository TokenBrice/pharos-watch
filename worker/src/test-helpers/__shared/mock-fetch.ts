import { vi, type Mock } from "vitest";

export interface MockResponseRoute {
  match: string;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export interface MockReplayRoute {
  match: string;
  /** Ordered results to replay for this route. */
  outcomes: MockFetchOutcome[];
  body?: never;
  status?: never;
  headers?: never;
}

export type MockRoute = MockResponseRoute | MockReplayRoute;

export interface MockResponseOutcome {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export type MockFetchOutcome = MockResponseOutcome | Error | { stall: true };

export interface MockFetchOptions {
  /** Require every fetch URL to match a configured route. */
  requireMatch?: boolean;
  /** Match the full request URL exactly instead of substring search. */
  strictUrl?: boolean;
  /** Do not install the spy as global fetch. */
  stubGlobal?: boolean;
}

type MockFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MockFetchHistoryEntry {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type MockFetchSpy = Mock<MockFetchFn> & {
  getHistory(): MockFetchHistoryEntry[];
  assertAllRoutesUsed(): void;
  assertAllOutcomesUsed(): void;
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function normalizeRequest(input: RequestInfo | URL, init?: RequestInit): Promise<{
  request: Request;
  history: MockFetchHistoryEntry;
}> {
  const request = new Request(input, init);
  const body = request.body == null ? null : await request.clone().text();
  return {
    request,
    history: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries([...request.headers].sort(([left], [right]) => left.localeCompare(right))),
      body: body || null,
    },
  };
}

function responseFromOutcome(outcome: MockResponseOutcome): Response {
  const body = typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body);
  return new Response(body, {
    status: outcome.status ?? 200,
    headers: { "Content-Type": "application/json", ...outcome.headers },
  });
}

function stalledResponse(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function mockFetch(routes: MockRoute[] = [], options: MockFetchOptions = {}): MockFetchSpy {
  const history: MockFetchHistoryEntry[] = [];
  const routeHits = new Map<MockRoute, number>();
  const outcomeHits = new Map<MockRoute, number>();

  const spy = vi.fn<MockFetchFn>(async (input: RequestInfo | URL, init?: RequestInit) => {
    const normalized = await normalizeRequest(input, init);
    history.push(normalized.history);
    const route = routes.find((r) => (
      options.strictUrl === true ? normalized.history.url === r.match : normalized.history.url.includes(r.match)
    ));
    if (!route) {
      if (options.requireMatch) {
        throw new Error(`mockFetch: no match for URL: ${normalized.history.url}`);
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    routeHits.set(route, (routeHits.get(route) ?? 0) + 1);
    if (!("outcomes" in route)) return responseFromOutcome(route);

    const outcomeIndex = outcomeHits.get(route) ?? 0;
    const outcome = route.outcomes[outcomeIndex];
    if (!outcome) {
      throw new Error(
        `mockFetch: scripted outcomes exhausted for route match: ${route.match} (configured ${route.outcomes.length})`,
      );
    }
    outcomeHits.set(route, outcomeIndex + 1);
    if (outcome instanceof Error) throw outcome;
    if ("stall" in outcome) return await stalledResponse(normalized.request.signal);
    return responseFromOutcome(outcome);
  }) as unknown as MockFetchSpy;
  spy.getHistory = () => history.map((entry) => ({ ...entry, headers: { ...entry.headers } }));
  spy.assertAllRoutesUsed = () => {
    const unused = routes.filter((route) => (routeHits.get(route) ?? 0) === 0);
    if (unused.length > 0) {
      throw new Error(`mockFetch: unused route match(es): ${unused.map((route) => route.match).join(", ")}`);
    }
  };
  spy.assertAllOutcomesUsed = () => {
    const unused = routes
      .filter((route): route is MockReplayRoute => (
        "outcomes" in route && (outcomeHits.get(route) ?? 0) < route.outcomes.length
      ))
      .map((route) => `${route.match} (${route.outcomes.length - (outcomeHits.get(route) ?? 0)} remaining)`);
    if (unused.length > 0) {
      throw new Error(`mockFetch: unused scripted outcome(s): ${unused.join(", ")}`);
    }
  };
  if (options.stubGlobal !== false) {
    vi.stubGlobal("fetch", spy);
  }
  return spy;
}

export function mockFetchStrict(
  routes: MockRoute[] = [],
  options: Omit<MockFetchOptions, "requireMatch" | "strictUrl"> = {},
): MockFetchSpy {
  return mockFetch(routes, { ...options, requireMatch: true, strictUrl: true });
}

export function assertAllFetchRoutesUsed(fetchSpy: Pick<MockFetchSpy, "assertAllRoutesUsed">): void {
  fetchSpy.assertAllRoutesUsed();
}
