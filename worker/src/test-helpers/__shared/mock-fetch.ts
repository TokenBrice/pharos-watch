import { vi, type Mock } from "vitest";

export interface MockRoute {
  match: string;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export interface MockFetchOptions {
  /** Require every fetch URL to match a configured route. */
  requireMatch?: boolean;
  /** Match the full request URL exactly instead of substring search. */
  strictUrl?: boolean;
  /** Do not install the spy as global fetch. */
  stubGlobal?: boolean;
}

type MockFetchFn = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

export type MockFetchSpy = Mock<MockFetchFn> & {
  getHistory(): Array<{ url: string }>;
  assertAllRoutesUsed(): void;
};

function requestUrl(input: string | Request | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function mockFetch(routes: MockRoute[] = [], options: MockFetchOptions = {}): MockFetchSpy {
  const history: Array<{ url: string }> = [];
  const routeHits = new Map<MockRoute, number>();

  const spy = vi.fn<MockFetchFn>(async (input: string | Request | URL) => {
    const url = requestUrl(input);
    history.push({ url });
    const route = routes.find((r) => options.strictUrl === true ? url === r.match : url.includes(r.match));
    if (!route) {
      if (options.requireMatch) {
        throw new Error(`mockFetch: no match for URL: ${url}`);
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    routeHits.set(route, (routeHits.get(route) ?? 0) + 1);
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json", ...route.headers },
    });
  }) as unknown as MockFetchSpy;
  spy.getHistory = () => history.map((entry) => ({ url: entry.url }));
  spy.assertAllRoutesUsed = () => {
    const unused = routes.filter((route) => (routeHits.get(route) ?? 0) === 0);
    if (unused.length > 0) {
      throw new Error(`mockFetch: unused route match(es): ${unused.map((route) => route.match).join(", ")}`);
    }
  };
  if (options.stubGlobal !== false) {
    vi.stubGlobal("fetch", spy);
  }
  return spy;
}

export function mockFetchStrict(routes: MockRoute[] = [], options: Omit<MockFetchOptions, "requireMatch" | "strictUrl"> = {}): MockFetchSpy {
  return mockFetch(routes, { ...options, requireMatch: true, strictUrl: true });
}

export function assertAllFetchRoutesUsed(fetchSpy: Pick<MockFetchSpy, "assertAllRoutesUsed">): void {
  fetchSpy.assertAllRoutesUsed();
}
