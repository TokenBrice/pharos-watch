import { describe, expect, it, vi } from "vitest";
import { insertDigestRecord } from "../platform";

describe("insertDigestRecord", () => {
  function makeOptions(db: D1Database, signal?: AbortSignal) {
    return {
      db,
      generatedAt: 1_710_000_000,
      digestText: "Digest body",
      digestTitle: "Digest title",
      inputData: { ok: true },
      digestExtended: "Extended body",
      digestMeta: JSON.stringify({ type: "daily" }),
      signal,
    };
  }

  it("retries transient D1 overloads", async () => {
    let attempts = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            attempts++;
            if (attempts === 1) throw new Error("D1 DB is overloaded");
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;

    await insertDigestRecord(makeOptions(db));

    expect(attempts).toBe(2);
  });

  it("honors an already-aborted signal before preparing the insert", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop-digest"));
    const prepare = vi.fn();
    const db = {
      prepare,
    } as unknown as D1Database;

    await expect(insertDigestRecord(makeOptions(db, controller.signal))).rejects.toThrow("stop-digest");
    expect(prepare).not.toHaveBeenCalled();
  });
});
