// Preserve the Worker-local test-helper import for existing Worker tests.
export {
  assertAllFetchRoutesUsed,
  jsonResponse,
  mockFetch,
  mockFetchStrict,
} from "@shared/test-utils/mock-fetch";
export type {
  MockFetchOutcome,
  MockFetchSpy,
  MockRoute,
} from "@shared/test-utils/mock-fetch";
