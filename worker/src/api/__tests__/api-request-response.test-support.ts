import { expect } from "vitest";

export async function readJsonResponse<T = unknown>(response: Response, expectedStatus: number): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as T;
}

export function makeJsonRequest(
  path: string | URL,
  body: unknown,
  init: Omit<RequestInit, "body"> = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Request(path, {
    ...init,
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}
