import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@shared/types/cloudflare-runtime";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { publishDigestEdition } from "../publish";

const GENERATED_AT = 1_710_000_000;

/**
 * D1 can report a retriable overload error after the statement already
 * committed (the platform suite pins that "commit, then throw" shape for
 * insertDigestRecord). Here the first INSERT persists and loses its response;
 * the retry then dedupes against the row this same run just wrote.
 */
function makeCommitThenTimeoutDb(db: D1Database): {
  db: D1Database;
  getInsertAttempts: () => number;
} {
  let insertAttempts = 0;
  const retrying = {
    prepare: (query: string) => {
      const statement = db.prepare(query);
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              const result = await bound.run();
              if (query.includes("INSERT INTO daily_digest")) {
                insertAttempts += 1;
                if (insertAttempts === 1) {
                  throw new Error("D1 DB storage operation exceeded timeout");
                }
              }
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db: retrying, getInsertAttempts: () => insertAttempts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("publishDigestEdition after a commit-then-timeout D1 retry", () => {
  it("reports the durably stored edition on the confirmed output clock", async () => {
    vi.useFakeTimers();
    const { sqlite, db: sqliteDb } = createLatestSchemaSqlite();
    try {
      const { db, getInsertAttempts } = makeCommitThenTimeoutDb(sqliteDb);

      const pending = publishDigestEdition({
        db,
        kind: "weekly",
        generatedAt: GENERATED_AT,
        digestDate: "2024-03-09",
        editionNumber: null,
        copy: {
          title: "Treasury yields hold steady",
          text: "Digest body for the week.",
          extended: "Extended digest body for the week.",
          meta: JSON.stringify({ type: "weekly" }),
        },
        inputData: { activeDepegCount: 2 },
        safetyContext: null,
        qualityGateStatus: null,
        degradedReasons: [],
        safetyMap: null,
        // Optional channels without credentials are a terminal-unsent delivery
        // outcome, not a persistence failure; neither touches D1.
        twitter: {
          creds: null,
          markerKey: "digest:2024-03-09",
          required: true,
          missingCredentialNames: [],
        },
        telegram: {
          creds: null,
          editionKey: "weekly:2024-03-09",
          required: true,
          missingCredentialNames: [],
        },
      });
      await vi.runAllTimersAsync();
      const outcome = await pending;

      expect(getInsertAttempts()).toBe(2);
      expect(
        sqlite
          .prepare("SELECT generated_at, digest_title FROM daily_digest")
          .all(),
      ).toEqual([{ generated_at: GENERATED_AT, digest_title: "Treasury yields hold steady" }]);

      // The row is stored and served by the public digest endpoints, so this
      // run published its output; a later attempt must not inherit an older
      // confirmed-output clock.
      expect(outcome.outputPublishedAt).toBe(GENERATED_AT);
    } finally {
      sqlite.close();
    }
  });
});
