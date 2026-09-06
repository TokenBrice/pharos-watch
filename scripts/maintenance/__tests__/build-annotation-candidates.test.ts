import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCoinIdResolver,
  buildFile,
  candidateId,
  fetchTapeEvents,
  fetchTapeJson,
  filterAgainstExisting,
  renderAppendBlock,
  runAnnotationCandidates,
  type AnnotationSnapshot,
  type Candidate,
} from "../build-annotation-candidates";
import type { StablecoinMeta } from "@shared/types";

function coin(id: string, symbol: string, name = symbol): StablecoinMeta {
  return { id, symbol, name, flags: {} } as StablecoinMeta;
}

describe("buildCoinIdResolver", () => {
  it("keeps shared labels ambiguous after later duplicate fields", () => {
    const resolveCoinId = buildCoinIdResolver([
      coin("usdx-hex-trust", "USDX", "Hex Trust USDX"),
      coin("usdx-kava", "USDX", "USDX"),
    ]);

    expect(resolveCoinId("USDX")).toBeNull();
    expect(resolveCoinId("usdx-hex-trust")).toBe("usdx-hex-trust");
    expect(resolveCoinId("usdx-kava")).toBe("usdx-kava");
  });

  it("resolves labels that belong to only one stablecoin", () => {
    const resolveCoinId = buildCoinIdResolver([coin("unique-usd", "UUSD", "Unique USD")]);

    expect(resolveCoinId(" uusd ")).toBe("unique-usd");
    expect(resolveCoinId("Unique USD")).toBe("unique-usd");
  });
});

describe("filterAgainstExisting", () => {
  const candidate = (date: string, kind = "launch"): Candidate => ({
    coinId: "example-usd",
    date,
    kind,
    description: "Example candidate",
    source: "https://example.com",
  });

  it("does not treat a date-only editorial cursor as proof of event review", () => {
    expect(
      filterAgainstExisting(
        [candidate("2026-08-10"), candidate("2026-08-11"), candidate("2026-08-12")],
        "",
        "2026-08-11",
      ),
    ).toEqual([candidate("2026-08-10"), candidate("2026-08-11"), candidate("2026-08-12")]);
  });

  it("still rejects duplicate rows newer than the last sweep", () => {
    const queued = "## 2026-08-12\n- example-usd | launch | Example candidate | source: https://example.com\n";

    expect(filterAgainstExisting([candidate("2026-08-12")], queued, "2026-08-11")).toEqual([]);
  });

  it.each([null, "2026-08-10"])("preserves the review cursor %s across source recovery", (lastSweptAt) => {
    const footer = lastSweptAt == null ? "" : `<!-- last_swept_at: ${lastSweptAt} -->`;
    const generated = buildFile(footer, renderAppendBlock("2026-08-12", [], ["depeg tape unavailable — skipped"]));
    const readCursor = (body: string) => /<!-- last_swept_at: (\d{4}-\d{2}-\d{2}) -->/.exec(body)?.[1] ?? null;
    expect(readCursor(generated)).toBe(lastSweptAt);

    // Both recovered history and a later same-day event must remain eligible.
    const recovered = [candidate("2026-08-11", "depeg"), candidate("2026-08-12", "depeg")];
    const fresh = filterAgainstExisting(recovered, generated, readCursor(generated));
    expect(fresh).toEqual(recovered);
    const updated = buildFile(generated, renderAppendBlock("2026-08-12", fresh, []));
    expect(updated).toContain("- 2026-08-11 | example-usd | depeg |");
    expect(updated).toContain("- 2026-08-12 | example-usd | depeg |");
    expect(readCursor(updated)).toBe(lastSweptAt);
    expect(updated.match(/<!-- last_swept_at:/g) ?? []).toHaveLength(lastSweptAt == null ? 0 : 1);
    expect(filterAgainstExisting(recovered, updated, readCursor(updated))).toEqual([]);
  });
});

describe("bounded tape collection", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const event = (id: string) => ({
    id, type: "depeg.started", severity: "warning", ts: 1_783_000_000_000,
    coinId: "test-usd", title: "Depeg", summary: "Depeg", sourceUrl: null,
  });

  it("collects every page in one fixed window", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ events: [event("one")], nextCursor: "second" }))
      .mockResolvedValueOnce(Response.json({ events: [event("two")], nextCursor: null }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchTapeEvents("depeg", 1000, 2000, { apiKey: "fixture" });
    expect(result).toMatchObject({ complete: true, pages: 2, events: [{ id: "one" }, { id: "two" }] });
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "second"]);
    expect(urls.every((url) => url.searchParams.get("since") === "1000" && url.searchParams.get("until") === "2000")).toBe(true);
  });

  it.each(["loop", "http", "malformed", "page-limit"])("retains collected rows and reports %s incompleteness", async (failure) => {
    const second = failure === "http" ? new Response("failure", { status: 503 })
      : failure === "malformed" ? new Response("invalid-json")
        : Response.json({ events: [event("two")], nextCursor: "again" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ events: [event("one")], nextCursor: "again" }))
      .mockResolvedValueOnce(second);
    vi.stubGlobal("fetch", fetch);
    const result = await fetchTapeEvents("depeg", 1000, 2000, { apiKey: "fixture", maxPages: failure === "page-limit" ? 1 : 25 });
    expect(result.complete).toBe(false);
    expect(result.events[0].id).toBe("one");
    expect(result.note).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(failure === "page-limit" ? 1 : 2);
  });

  it("keeps the deadline active after headers until a stalled body aborts", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signal = init.signal;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      }) };
    }));
    const result = fetchTapeEvents("depeg", 1000, 2000, { apiKey: "fixture", timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ complete: false, pages: 0, note: "body aborted" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an HTTP error body and rejects invalid successful JSON", async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 503, body: { cancel } })
      .mockResolvedValueOnce(new Response("invalid")));
    await expect(fetchTapeJson("https://example.test", {})).rejects.toThrow("HTTP 503");
    expect(cancel).toHaveBeenCalledOnce();
    await expect(fetchTapeJson("https://example.test", {})).rejects.toThrow();
  });

  it("does not reset the source deadline on the second page", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockImplementationOnce(async () => ({ ok: true, json: () => new Promise((resolve) => {
        setTimeout(() => resolve({ events: [event("one")], nextCursor: "second" }), 20);
      }) }))
      .mockImplementationOnce(async (_url, init) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      }) }));
    vi.stubGlobal("fetch", fetch);
    const result = fetchTapeEvents("depeg", 1000, 2000, { apiKey: "fixture", timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ complete: false, pages: 1, events: [{ id: "one" }], note: "body aborted" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("retained annotation replay", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  });

  it.each(["", "<!-- last_swept_at: 2026-09-07 -->\n"])("preserves editorial state through actual generation and recovered sources (footer=%s)", async (footer) => {
    const root = mkdtempSync(join(tmpdir(), "pharos-annotation-generation-"));
    roots.push(root);
    mkdirSync(join(root, "agents"));
    const queue = join(root, "agents/annotation-candidates.md");
    const snapshotPath = join(root, "agents/annotation-candidates.json");
    writeFileSync(queue, footer);
    vi.stubEnv("PHAROS_API_KEY", "fixture");
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-07T16:00:00.000Z");
    let recovered = false;
    const fetch = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      expect(Number(url.searchParams.get("until")) - Number(url.searchParams.get("since"))).toBe(14 * 86_400_000);
      if (url.searchParams.get("class") === "freeze") return Response.json({ events: [], nextCursor: null });
      if (!recovered) return new Response("unavailable", { status: 503 });
      return Response.json({ events: ["morning", "afternoon"].map((id, index) => ({
        id, type: "depeg.started", severity: "warning", ts: Date.parse(`2026-09-07T${index === 0 ? "08" : "15"}:00:00.000Z`),
        coinId: "example-usd", title: "same title", summary: "same summary", sourceUrl: null,
      })), nextCursor: null });
    });
    vi.stubGlobal("fetch", fetch);
    await runAnnotationCandidates([], root);
    expect(readFileSync(queue, "utf8")).toContain("INCOMPLETE collection");
    recovered = true;
    await runAnnotationCandidates([], root);
    expect(readFileSync(queue, "utf8")).toContain("id: tape:morning");
    expect(readFileSync(queue, "utf8")).toContain("id: tape:afternoon");
    await runAnnotationCandidates([], root);
    const body = readFileSync(queue, "utf8");
    expect(body.match(/id: tape:morning/g)).toHaveLength(1);
    expect(body.match(/id: tape:afternoon/g)).toHaveLength(1);
    expect(body.match(/<!-- last_swept_at:[^>]*-->/)?.[0] ?? "").toBe(footer.trim());
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as AnnotationSnapshot;
    expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.coverage.filter((entry) => entry.source === "depeg").map((entry) => entry.complete)).toEqual([false, true]);
  });

  it("replays full consecutive snapshots, preserving deferrals and same-day arrivals without requeueing decisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-annotation-replay-"));
    roots.push(root);
    const history = join(root, "agents/history");
    const first: AnnotationSnapshot = {
      version: 1, generatedAt: "2026-09-07T08:00:00.000Z",
      coverage: [{ source: "depeg", since: "2026-08-24T08:00:00.000Z", until: "2026-09-07T08:00:00.000Z", complete: false, pages: 1, note: "HTTP 503" }],
      candidates: Array.from({ length: 180 }, (_, i) => ({
        id: `tape:${i}`, coinId: "example-usd", date: "2026-09-07", kind: "depeg", description: `event ${i}`, source: "depeg tape",
      })),
    };
    const writeSnapshot = (run: string, snapshot: AnnotationSnapshot) => {
      const path = join(history, run); mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "annotation-candidates.json"), JSON.stringify(snapshot));
    };
    writeSnapshot("run-1", first);
    const queue = join(root, "agents/annotation-candidates.md");
    const legacy = "## 2026-08-20\n- legacy-usd | depeg | old deferred event | source: issuer | deferred: await postmortem\n" +
      "  Await source: https://issuer.example/postmortem — revisit when final.\n\n" +
      "<!-- freeze tape unavailable for 2026-08-20; coverage gap unresolved -->\n" +
      "<!-- last_swept_at: 2026-09-07 -->\n";
    writeFileSync(queue, legacy);
    const fetch = vi.fn(() => { throw new Error("replay must remain offline"); });
    vi.stubGlobal("fetch", fetch);
    await runAnnotationCandidates(["--replay", history], root);
    expect(readFileSync(queue, "utf8")).toContain("event 179");
    expect(readFileSync(queue, "utf8")).toContain("deferred: await postmortem");
    const decisions = JSON.stringify({ version: 1, decisions: {
      "tape:0": { disposition: "promote", reviewedAt: "2026-09-07T09:00:00.000Z", reason: "Added annotation" },
      "tape:1": { disposition: "drop", reviewedAt: "2026-09-07T09:00:00.000Z", reason: "Duplicate incident" },
      "tape:2": { disposition: "defer", reviewedAt: "2026-09-07T09:00:00.000Z", reason: "Await issuer source" },
    } });
    const review = join(root, "agents/annotation-review.json");
    writeFileSync(review, decisions);
    writeSnapshot("run-2", { ...first, generatedAt: "2026-09-07T16:00:00.000Z", coverage: [], candidates: [
      first.candidates[0], { ...first.candidates[0], id: "tape:afternoon" },
    ] });
    for (let repeat = 0; repeat < 2; repeat++) {
      await runAnnotationCandidates(["--replay", history], root);
      const body = readFileSync(queue, "utf8");
      expect(body).not.toMatch(/ \| id: tape:[01](?:\n| \|)/);
      expect(body).toContain("id: tape:2 | review: defer — Await issuer source");
      expect(body.match(/id: tape:afternoon/g)).toHaveLength(1);
      expect(body.match(/id: tape:179/g)).toHaveLength(1);
      expect(body).toContain("INCOMPLETE collection");
      expect(body).toContain("last_swept_at: 2026-09-07");
      expect(body.match(/\[original queue\]\(annotation-candidates\.legacy\.md\)/g)).toHaveLength(1);
      expect(readFileSync(join(root, "agents/annotation-candidates.legacy.md"), "utf8")).toBe(legacy);
      expect(readFileSync(review, "utf8")).toBe(decisions);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(candidateId(first.candidates[0])).not.toBe(candidateId({ ...first.candidates[0], id: "tape:afternoon" }));
  });

  it("fails before replacing queue bytes when review or history evidence is invalid", async () => {
    const root = mkdtempSync(join(tmpdir(), "pharos-annotation-invalid-"));
    roots.push(root);
    const history = join(root, "agents/history"); mkdirSync(history, { recursive: true });
    const queue = join(root, "agents/annotation-candidates.md");
    writeFileSync(queue, "untouched editorial notes");
    await expect(runAnnotationCandidates(["--replay", history, "--review", "missing.json"], root)).rejects.toThrow("Review file not found");
    await expect(runAnnotationCandidates(["--replay", history], root)).rejects.toThrow("No annotation-candidates.json snapshots");
    writeFileSync(join(history, "annotation-candidates.json"), "{}");
    await expect(runAnnotationCandidates(["--replay", history], root)).rejects.toThrow();
    writeFileSync(join(history, "annotation-candidates.json"), JSON.stringify({
      version: 1, generatedAt: "2026-09-07T16:00:00.000Z", coverage: [], candidates: [],
    }));
    const backup = join(root, "agents/annotation-candidates.legacy.md");
    writeFileSync(backup, "different preserved legacy evidence");
    await expect(runAnnotationCandidates(["--replay", history], root)).rejects.toThrow("Legacy backup already contains different evidence");
    expect(readFileSync(backup, "utf8")).toBe("different preserved legacy evidence");
    expect(readFileSync(queue, "utf8")).toBe("untouched editorial notes");
  });
});
