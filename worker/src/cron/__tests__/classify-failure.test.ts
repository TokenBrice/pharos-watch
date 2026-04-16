import { describe, expect, it } from "vitest";
import { classifyFailure, type ReserveFailureCategory } from "../sync-live-reserves-shared";

interface Case {
  name: string;
  reason: string;
  lastError: string | null;
  expected: ReserveFailureCategory;
}

const CASES: Case[] = [
  // adapter-config
  { name: "unknown-adapter reason", reason: "unknown-adapter", lastError: null, expected: "adapter-config" },
  {
    name: "zod adapter params invalid",
    reason: "adapter-exception",
    lastError: "infinifi adapter params invalid.cauldrons.0.address: Required",
    expected: "adapter-config",
  },
  {
    name: "adapter requires input",
    reason: "adapter-exception",
    lastError: "single-asset adapter requires rpcUrl",
    expected: "adapter-config",
  },

  // circuit-open
  { name: "circuit-open reason", reason: "circuit-open", lastError: null, expected: "circuit-open" },

  // storage-write
  { name: "storage-write-timeout reason", reason: "storage-write-timeout", lastError: null, expected: "storage-write" },
  {
    name: "success-finalize-rejected reason",
    reason: "success-finalize-rejected",
    lastError: null,
    expected: "storage-write",
  },
  {
    name: "d1 write timeout in message",
    reason: "adapter-exception",
    lastError: "D1 write timeout for iusd-infinifi",
    expected: "storage-write",
  },
  {
    name: "sqlite error",
    reason: "adapter-exception",
    lastError: "SQLITE_BUSY: database is locked",
    expected: "storage-write",
  },

  // validation
  { name: "validation-failed reason", reason: "validation-failed", lastError: null, expected: "validation" },
  { name: "fatal-warning reason", reason: "fatal-warning", lastError: null, expected: "validation" },
  { name: "empty-slices reason", reason: "empty-slices", lastError: null, expected: "validation" },
  {
    name: "adapter-exception + invalid reserve output",
    reason: "adapter-exception",
    lastError: "Invalid reserve output from adapter XYZ",
    expected: "validation",
  },

  // parser-drift
  {
    name: "layout-changed error",
    reason: "adapter-exception",
    lastError: "layout-changed for https://example.com",
    expected: "parser-drift",
  },

  // parse-failure
  {
    name: "parse-failed error",
    reason: "adapter-exception",
    lastError: "parse-failed: unexpected token",
    expected: "parse-failure",
  },
  {
    name: "json parse failed error",
    reason: "adapter-exception",
    lastError: "JSON parse failed at position 42",
    expected: "parse-failure",
  },

  // upstream-http
  {
    name: "http 503",
    reason: "adapter-exception",
    lastError: "HTTP 503 for https://api.example.com",
    expected: "upstream-http",
  },
  {
    name: "http 429",
    reason: "adapter-exception",
    lastError: "HTTP 429 rate limit",
    expected: "upstream-http",
  },

  // network
  {
    name: "fetch failed",
    reason: "adapter-exception",
    lastError: "fetch failed: ECONNREFUSED",
    expected: "network",
  },
  {
    name: "adapter-timeout",
    reason: "adapter-exception",
    lastError: "adapter-timeout after 15s",
    expected: "network",
  },
  {
    name: "aborted",
    reason: "adapter-exception",
    lastError: "The operation was aborted",
    expected: "network",
  },
  {
    name: "timed out",
    reason: "adapter-exception",
    lastError: "request timed out",
    expected: "network",
  },
  {
    name: "no-response",
    reason: "adapter-exception",
    lastError: "no-response from upstream",
    expected: "network",
  },

  // unknown
  {
    name: "unrecognised error",
    reason: "adapter-exception",
    lastError: "something weird happened",
    expected: "unknown",
  },
  { name: "null lastError with unknown reason", reason: "adapter-exception", lastError: null, expected: "unknown" },
];

describe("classifyFailure", () => {
  it.each(CASES)("$name -> $expected", ({ reason, lastError, expected }) => {
    expect(classifyFailure(reason, lastError)).toBe(expected);
  });
});
