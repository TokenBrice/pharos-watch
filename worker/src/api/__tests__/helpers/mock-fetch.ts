import { vi } from "vitest";

interface MockRoute {
  match: string;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export function mockFetch(routes: MockRoute[] = []): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json", ...route.headers },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}
