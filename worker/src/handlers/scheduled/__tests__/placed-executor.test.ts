import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { PLACED_EXECUTOR_URL, PlacedProjectTapeRequestSchema, PlacedProjectTapeResultSchema } from "@shared/types/placed-executor";
import type { PlacedProjectTapeRequest } from "@shared/types/placed-executor";
import type { HeavyEnv } from "../../../lib/env";
import { createSlotDeadline } from "../../../lib/cron-timeouts";
import { markScheduledChildStarted } from "../../../lib/scheduled-child-terminal";
import type { ScheduledChildIdentity } from "../../../lib/scheduled-child-terminal";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";
import { makeScheduledRuntime } from "../../../test-helpers/scheduled-runtime.test-support";

const mocks = vi.hoisted(() => ({ projectTape: vi.fn(), dews: vi.fn(), psi: vi.fn() }));
vi.mock("../../../cron/project-tape", () => ({ projectTape: mocks.projectTape }));
vi.mock("../../../lib/dews/service", () => ({ computeAndStoreDEWS: mocks.dews }));
vi.mock("../../../cron/stability-index", () => ({ computeAndStoreStabilityIndex: mocks.psi }));
import { handlePlacedExecutorFetch, runProjectTapeCanary } from "../placed-executor";
import { runDewsPsiSlot } from "../dews-psi";
import heavyWorker from "../../../index.heavy";

const fixtures = createLatestSchemaFixtureTracker();
const SECRET = "test-internal-canary-secret";
const realResult = { status: "ok" as const, itemCount: 7, productivity: { productive: true },
  metadata: JSON.stringify({ reason: "tape-projection-completed", perClass: { depeg: 7 } }) };

function driver(fetch: Mock, flag = "on") {
  const now = Date.now();
  return makeScheduledRuntime({
    scheduleKey: "dewsPsiOffset", slotStartedAt: Math.floor(now / 1000), deadline: createSlotDeadline(now),
    executionFence: { scheduleKey: "dewsPsiOffset", slotStartedAt: Math.floor(now / 1000),
      invocationId: "driver", owner: "owner", generation: 3, workerRole: "public" },
    env: createWorkerEnv({ PROJECT_TAPE_PLACED_EXECUTOR: flag, HEAVY_EXECUTOR_SHARED_SECRET: SECRET,
      HEAVY_EXECUTOR: { fetch } as Fetcher }),
  });
}

function internalRequest(payload: PlacedProjectTapeRequest, authorization = `Bearer ${SECRET}`): Request {
  const request = new Request(PLACED_EXECUTOR_URL, { method: "POST", headers: { authorization }, body: JSON.stringify(payload) });
  Object.defineProperty(request, "cf", { value: { colo: "FRA" } });
  return request;
}

async function executorFixture() {
  const fixture = fixtures.open();
  const now = Math.floor(Date.now() / 1000);
  const payload: PlacedProjectTapeRequest = { job: "project-tape", scheduleKey: "dewsPsiOffset", slotStartedAt: now,
    eventEntryMs: now * 1000, deadlineMs: now * 1000 + 120_000, workDeadlineMs: now * 1000 + 60_000,
    invocationId: "driver", owner: "owner", generation: 3 };
  fixture.sqlite.prepare(`INSERT INTO cron_slot_executions (slot_key,slot_started_at,state,execution_owner,
    execution_generation,invocation_id,started_at,updated_at,metadata)
    VALUES ('dewsPsiOffset',?,'running','owner',3,'driver',?,?,?)`).run(now, now, now,
    JSON.stringify({ slotDeadlineMs: payload.deadlineMs }));
  const identity: ScheduledChildIdentity = { scheduleKey: "dewsPsiOffset", slotStartedAt: now, job: "project-tape",
    producerPath: "dewsPsiOffset", producerKind: "scheduled-job", invocationId: "producer", attemptNo: 1,
    executionFence: { scheduleKey: "dewsPsiOffset", slotStartedAt: now, invocationId: "driver", owner: "owner",
      generation: 3, workerRole: "public" } };
  await markScheduledChildStarted(fixture.db, identity, now, "driver-lease");
  fixture.sqlite.prepare(`INSERT INTO cron_leases (job,lease_owner,lease_until,heartbeat_at,updated_at)
    VALUES ('project-tape','driver-lease',?,?,?)`).run(now + 300, now, now);
  const env: HeavyEnv = { ...createWorkerEnv({ DB: fixture.db, HEAVY_EXECUTOR_SHARED_SECRET: SECRET }),
    SAFETY_CAPTURE_ARCHIVE: {} as R2Bucket };
  return { ...fixture, payload, env };
}

describe("project-tape placed-fetch canary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectTape.mockResolvedValue(realResult);
    mocks.dews.mockResolvedValue({ status: "ok" });
    mocks.psi.mockResolvedValue({ status: "ok" });
  });
  afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("flag off runs the original in-process projector with its signal and reporter", async () => {
    const fetch = vi.fn();
    const runtime = driver(fetch, "off");
    const signal = new AbortController().signal;
    const report = vi.fn();
    expect(await runProjectTapeCanary(runtime, signal, report)).toEqual(realResult);
    expect(mocks.projectTape).toHaveBeenCalledExactlyOnceWith(runtime.db, signal, report);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("flag on delegates only project-tape and returns its real result and executor colo", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
      const payload = PlacedProjectTapeRequestSchema.parse(await request.json());
      expect(payload).toMatchObject({ job: "project-tape", scheduleKey: "dewsPsiOffset", generation: 3,
        invocationId: "driver", owner: "owner", slotStartedAt: runtime.slotStartedAt,
        eventEntryMs: runtime.deadline.eventEntryMs, deadlineMs: runtime.deadline.platformDeadlineMs });
      return Response.json({ ...realResult, metadata: JSON.stringify({ reason: "tape-projection-completed", executorColo: "FRA" }) });
    });
    const runtime = driver(fetch);
    await runDewsPsiSlot(runtime);
    expect(runtime.runLeasedCron).toHaveBeenCalledTimes(3);
    expect(mocks.dews).toHaveBeenCalledOnce();
    expect(mocks.psi).toHaveBeenCalledOnce();
    expect(mocks.projectTape).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    const result = await runProjectTapeCanary(runtime, new AbortController().signal, vi.fn());
    expect(result.itemCount).toBe(7);
    expect(JSON.parse(result.metadata!)).toMatchObject({ executorColo: "FRA" });
  });

  it("defaults on when the canary variable is absent", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(realResult));
    const runtime = driver(fetch);
    delete runtime.env.PROJECT_TAPE_PLACED_EXECUTOR;
    expect((await runProjectTapeCanary(runtime, new AbortController().signal, vi.fn())).status).toBe("ok");
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.projectTape).not.toHaveBeenCalled();
  });

  it("names transport failure without retrying or executing in-process", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("lost response after remote commit"));
    const result = await runProjectTapeCanary(driver(fetch), new AbortController().signal, vi.fn());
    expect(result.status).toBe("error");
    expect(JSON.parse(result.metadata!).reason).toBe("placed-executor-transport-failed");
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.projectTape).not.toHaveBeenCalled();
  });

  it("names a stuck transport timeout without in-process rerun", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("test-transport-timeout")), ms);
      return controller.signal;
    });
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const runtime = driver(fetch);
    runtime.deadline = createSlotDeadline(Date.now(), Date.now() + 10);
    const pending = runProjectTapeCanary(runtime, new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse((await pending).metadata!).reason).toBe("placed-executor-timeout");
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.projectTape).not.toHaveBeenCalled();
  });

  it.each(["", "Bearer wrong", "wrong"])("rejects unauthorized heavy fetch (%s) before D1 or work", async (authorization) => {
    const { env, payload } = await executorFixture();
    const prepare = vi.spyOn(env.DB, "prepare");
    expect((await heavyWorker.fetch(internalRequest(payload, authorization), env)).status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.projectTape).not.toHaveBeenCalled();
  });

  it("executes under the original generation and reports fetch colo without owning terminal accounting", async () => {
    const { env, payload, sqlite } = await executorFixture();
    const response = await handlePlacedExecutorFetch(internalRequest(payload), env);
    const result = PlacedProjectTapeResultSchema.parse(await response.json());
    expect(result).toMatchObject({ status: "ok", itemCount: 7, productivity: { productive: true } });
    expect(JSON.parse(result.metadata)).toMatchObject({ perClass: { depeg: 7 }, executorColo: "FRA",
      executorColoSource: "request.cf.colo", slotStartedAt: payload.slotStartedAt, executionGeneration: 3 });
    expect(sqlite.prepare("SELECT state,execution_generation FROM cron_slot_executions").get())
      .toEqual({ state: "running", execution_generation: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cron_runs").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT terminal_token FROM scheduled_child_attempts").get()).toEqual({ terminal_token: null });
  });

  it("durably rejects duplicate delivery without re-executing the projector", async () => {
    const { env, payload } = await executorFixture();
    await handlePlacedExecutorFetch(internalRequest(payload), env);
    const duplicate = await handlePlacedExecutorFetch(internalRequest(payload), env);
    expect(JSON.parse(PlacedProjectTapeResultSchema.parse(await duplicate.json()).metadata).reason).toBe("placed-executor-duplicate-or-stale");
    expect(mocks.projectTape).toHaveBeenCalledOnce();
  });

  it.each(["generation", "lease", "terminal", "deadline"])("rejects stale %s before executing", async (stale) => {
    const { env, payload, sqlite } = await executorFixture();
    if (stale === "generation") sqlite.exec("UPDATE cron_slot_executions SET execution_generation=4");
    if (stale === "lease") sqlite.exec("UPDATE cron_leases SET lease_until=0");
    if (stale === "terminal") sqlite.exec("UPDATE scheduled_child_attempts SET terminal_token='done'");
    if (stale === "deadline") payload.workDeadlineMs = Date.now() - 1;
    const result = PlacedProjectTapeResultSchema.parse(await (await handlePlacedExecutorFetch(internalRequest(payload), env)).json());
    expect(result.status).toBe("error");
    expect(mocks.projectTape).not.toHaveBeenCalled();
  });
  it("preserves prepared and batched writes under the live driver fence", async () => {
    const { env, payload, sqlite } = await executorFixture();
    mocks.projectTape.mockImplementationOnce(async (db: D1Database) => {
      await db.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)").bind("canary-one", "one", 1).run();
      await db.batch([db.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)").bind("canary-two", "two", 1)]);
      return realResult;
    });
    const result = PlacedProjectTapeResultSchema.parse(await (await handlePlacedExecutorFetch(internalRequest(payload), env)).json());
    expect(result.status).toBe("ok");
    expect(sqlite.prepare("SELECT key FROM cache WHERE key LIKE 'canary-%' ORDER BY key").all())
      .toEqual([{ key: "canary-one" }, { key: "canary-two" }]);
  });

  it("rejects concurrent duplicate deliveries across separate requests", async () => {
    const { env, payload } = await executorFixture();
    let started!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    mocks.projectTape.mockImplementationOnce(async () => { started(); await finish; return realResult; });
    const first = handlePlacedExecutorFetch(internalRequest(payload), env);
    await admitted;
    const duplicate = await handlePlacedExecutorFetch(internalRequest(payload), env);
    expect(PlacedProjectTapeResultSchema.parse(await duplicate.json()).status).toBe("error");
    release();
    expect(PlacedProjectTapeResultSchema.parse(await (await first).json()).status).toBe("ok");
    expect(mocks.projectTape).toHaveBeenCalledOnce();
  });


  it.each(["takeover", "terminal", "lease", "child-timeout"])("fences a queued projector write after %s", async (lost) => {
    const { env, payload, sqlite } = await executorFixture();
    mocks.projectTape.mockImplementationOnce(async (db: D1Database) => {
      if (lost === "takeover") sqlite.exec("UPDATE cron_slot_executions SET execution_generation=4");
      if (lost === "terminal") sqlite.exec("UPDATE cron_slot_executions SET state='finished'");
      if (lost === "lease") sqlite.exec("UPDATE cron_leases SET lease_until=0");
      if (lost === "child-timeout") sqlite.exec("UPDATE scheduled_child_attempts SET started_at=unixepoch()-301");
      await db.prepare("INSERT INTO cache (key,value,updated_at) VALUES ('canary-write','bad',1)").run();
      return realResult;
    });
    const result = PlacedProjectTapeResultSchema.parse(await (await handlePlacedExecutorFetch(internalRequest(payload), env)).json());
    expect(result.status).toBe("error");
    expect(sqlite.prepare("SELECT value FROM cache WHERE key='canary-write'").get()).toBeUndefined();
  });
});
