import { vi, type Mock } from "vitest";

const NativeURL = URL;

type MockRequestPredicate = (request: Request) => boolean | Promise<boolean>;
type MockJsonPredicate = (body: unknown, request: Request) => boolean | Promise<boolean>;
type MockJsonValue = null | boolean | number | string | MockJsonValue[] | { [key: string]: MockJsonValue };

interface MockRouteMatcher {
  match: string | MockRequestPredicate;
  /** Optional request-body substring used to disambiguate requests to one URL. */
  matchBody?: string;
  /** Required request headers. Header names are case-insensitive and extra headers are allowed. */
  matchHeaders?: HeadersInit;
  /** Exact parsed JSON body, or a predicate over the parsed JSON body. */
  matchJson?: MockJsonValue | MockJsonPredicate;
}

interface MockResponseRoute extends MockRouteMatcher {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
}

interface MockReplayRoute extends MockRouteMatcher {
  /** Ordered results to replay for this route. */
  outcomes: MockFetchOutcome[];
  body?: never;
  status?: never;
  headers?: never;
  delayMs?: never;
}

interface MockDynamicRoute extends MockRouteMatcher {
  /** Compute a result from the normalized request. */
  respond: MockFetchResponder;
  body?: never;
  status?: never;
  headers?: never;
  delayMs?: never;
  outcomes?: never;
}

export type MockRoute = MockResponseRoute | MockReplayRoute | MockDynamicRoute;

interface MockResponseOutcome {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
}

interface MockRawResponseOutcome {
  response: Response;
  delayMs?: number;
}

export type MockFetchOutcome = MockResponseOutcome | MockRawResponseOutcome | Error | { stall: true };
type MockFetchResponder = (request: Request) => MockFetchOutcome | Response | Promise<MockFetchOutcome | Response>;

interface MockFetchOptions {
  /** Require every fetch URL to match a configured route. */
  requireMatch?: boolean;
  /** Choose how unmatched URLs behave. Defaults to not-found, or throw with requireMatch. */
  unmatched?: "throw" | "not-found" | "passthrough";
  /** Match the full request URL exactly instead of substring search. */
  strictUrl?: boolean;
  /** Do not install the spy as global fetch. */
  stubGlobal?: boolean;
}

type MockFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface MockFetchHistoryEntry {
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
  const locationValue: unknown = Reflect.get(globalThis, "location");
  const locationHref: unknown = typeof locationValue === "object" && locationValue != null
    ? Reflect.get(locationValue, "href")
    : undefined;
  const normalizedInput = typeof input === "string" && !NativeURL.canParse(input)
    ? new NativeURL(input, typeof locationHref === "string" && locationHref ? locationHref : "http://localhost").toString()
    : input;
  const request = new Request(normalizedInput, init);
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

function responseFromOutcome(outcome: MockResponseOutcome | MockRawResponseOutcome): Response {
  if ("response" in outcome) return outcome.response;
  const body = typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body);
  return new Response(body, {
    status: outcome.status ?? 200,
    headers: { "Content-Type": "application/json", ...outcome.headers },
  });
}

function isJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => isJsonEqual(value, right[index]));
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => {
      const rightEntry = rightEntries[index];
      return rightEntry != null && key === rightEntry[0] && isJsonEqual(value, rightEntry[1]);
    });
}

async function routeMatches(
  route: MockRoute,
  request: Request,
  history: MockFetchHistoryEntry,
  strictUrl: boolean,
): Promise<boolean> {
  const requestMatches = typeof route.match === "function"
    ? await route.match(request.clone())
    : strictUrl
      ? history.url === route.match
      : history.url.includes(route.match);
  if (!requestMatches || (route.matchBody != null && history.body?.includes(route.matchBody) !== true)) {
    return false;
  }
  if (route.matchHeaders != null) {
    const expectedHeaders = new Headers(route.matchHeaders);
    for (const [name, value] of expectedHeaders) {
      if (request.headers.get(name) !== value) return false;
    }
  }
  if (route.matchJson !== undefined) {
    if (history.body == null) return false;
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(history.body);
    } catch {
      return false;
    }
    const jsonMatches = typeof route.matchJson === "function"
      ? await route.matchJson(parsedBody, request.clone())
      : isJsonEqual(parsedBody, route.matchJson);
    if (!jsonMatches) return false;
  }
  return true;
}

function routeLabel(route: MockRoute): string {
  return typeof route.match === "string" ? route.match : "[request predicate]";
}

function isReplayRoute(route: MockRoute): route is MockReplayRoute {
  return "outcomes" in route && route.outcomes !== undefined;
}

function delayedResponse(delayMs: number, signal: AbortSignal | null): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`mockFetch: delayMs must be a non-negative finite number, received ${delayMs}`);
  }
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
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
  if (options.requireMatch === true && options.unmatched && options.unmatched !== "throw") {
    throw new Error("mockFetch: requireMatch cannot be combined with a non-throw unmatched policy");
  }

  const history: MockFetchHistoryEntry[] = [];
  const routeHits = new Map<MockRoute, number>();
  const outcomeHits = new Map<MockRoute, number>();
  const unmatchedPolicy = options.unmatched ?? (options.requireMatch ? "throw" : "not-found");
  const passthroughFetch = globalThis.fetch.bind(globalThis);

  const fetchImplementation: MockFetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const normalized = await normalizeRequest(input, init);
    history.push(normalized.history);
    let route: MockRoute | undefined;
    for (const candidate of routes) {
      if (await routeMatches(candidate, normalized.request, normalized.history, options.strictUrl === true)) {
        route = candidate;
        break;
      }
    }
    if (!route) {
      if (unmatchedPolicy === "throw") {
        throw new Error(`mockFetch: no match for URL: ${normalized.history.url}`);
      }
      if (unmatchedPolicy === "passthrough") {
        return passthroughFetch(normalized.request);
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    routeHits.set(route, (routeHits.get(route) ?? 0) + 1);
    let outcome: MockFetchOutcome | Response;
    if ("respond" in route) {
      outcome = await route.respond(normalized.request.clone());
    } else if (isReplayRoute(route)) {
      const outcomeIndex = outcomeHits.get(route) ?? 0;
      const scriptedOutcome = route.outcomes[outcomeIndex];
      if (!scriptedOutcome) {
        throw new Error(
          `mockFetch: scripted outcomes exhausted for route match: ${routeLabel(route)} (configured ${route.outcomes.length})`,
        );
      }
      outcomeHits.set(route, outcomeIndex + 1);
      outcome = scriptedOutcome;
    } else {
      outcome = route;
    }
    if (outcome instanceof Error) throw outcome;
    if (outcome instanceof Response) return outcome;
    if ("stall" in outcome) return await stalledResponse(normalized.request.signal);
    if (outcome.delayMs != null) await delayedResponse(outcome.delayMs, normalized.request.signal);
    return responseFromOutcome(outcome);
  };
  const spy = Object.assign(vi.fn<MockFetchFn>(fetchImplementation), {
    getHistory: () => history.map((entry) => ({ ...entry, headers: { ...entry.headers } })),
    assertAllRoutesUsed: () => {
      const unused = routes.filter((route) => (routeHits.get(route) ?? 0) === 0);
      if (unused.length > 0) {
        throw new Error(`mockFetch: unused route match(es): ${unused.map(routeLabel).join(", ")}`);
      }
    },
    assertAllOutcomesUsed: () => {
      const unused = routes
        .filter((route): route is MockReplayRoute => (
          isReplayRoute(route) && (outcomeHits.get(route) ?? 0) < route.outcomes.length
        ))
        .map((route) => `${routeLabel(route)} (${route.outcomes.length - (outcomeHits.get(route) ?? 0)} remaining)`);
      if (unused.length > 0) {
        throw new Error(`mockFetch: unused scripted outcome(s): ${unused.join(", ")}`);
      }
    },
  });
  if (options.stubGlobal !== false) {
    vi.stubGlobal("fetch", spy);
  }
  return spy;
}

export function mockFetchStrict(
  routes: MockRoute[] = [],
  options: Omit<MockFetchOptions, "requireMatch" | "strictUrl" | "unmatched"> = {},
): MockFetchSpy {
  return mockFetch(routes, { ...options, requireMatch: true, strictUrl: true });
}

export function assertAllFetchRoutesUsed(fetchSpy: Pick<MockFetchSpy, "assertAllRoutesUsed">): void {
  fetchSpy.assertAllRoutesUsed();
}
