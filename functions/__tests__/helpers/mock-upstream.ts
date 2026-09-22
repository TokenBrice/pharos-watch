import { mockFetchStrict, type MockFetchSpy } from "@shared/test-utils/mock-fetch";

/**
 * Strict per-origin fetch installers for the Pages proxy suites. `strictUrl` +
 * `requireMatch` are part of the preset so a suite cannot silently match a
 * wrong upstream URL.
 */
export interface MockUpstream {
  json(path: string, body: unknown, status?: number, headers?: Record<string, string>): MockFetchSpy;
  response(path: string, response: Response): MockFetchSpy;
  error(path: string, error: Error): MockFetchSpy;
  stall(path: string): MockFetchSpy;
}

export function mockUpstream(origin: string): MockUpstream {
  return {
    json: (path, body, status = 200, headers = {}) =>
      mockFetchStrict([{ match: `${origin}${path}`, body, status, headers }]),
    response: (path, response) => mockFetchStrict([{ match: `${origin}${path}`, outcomes: [{ response }] }]),
    error: (path, error) => mockFetchStrict([{ match: `${origin}${path}`, outcomes: [error] }]),
    stall: (path) => mockFetchStrict([{ match: `${origin}${path}`, outcomes: [{ stall: true }] }]),
  };
}
