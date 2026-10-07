import { describe, expect, it, vi } from "vitest";
import { checkWorkerPackage } from "../ci/check-worker-package";

describe("check-worker-package", () => {
  it("packages both configs into distinct directories", () => {
    const run = vi.fn((_command: string, _args: string[]) => ({ status: 0 }));
    expect(checkWorkerPackage({ run })).toEqual({ status: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    const publicArgs = run.mock.calls[0]?.[1];
    const heavyArgs = run.mock.calls[1]?.[1];
    expect(publicArgs).toEqual(expect.arrayContaining(["--config", "wrangler.toml", "--dry-run"]));
    expect(heavyArgs).toEqual(expect.arrayContaining(["--config", "wrangler.heavy.toml", "--dry-run"]));
    expect(publicArgs?.at(-1)).not.toBe(heavyArgs?.at(-1));
  });

  it.each([0, 1])("fails when bundle %s fails", (failedIndex) => {
    let invocation = 0;
    const run = vi.fn(() => ({ status: invocation++ === failedIndex ? 7 : 0 }));
    expect(checkWorkerPackage({ run })).toEqual({ status: 7 });
    expect(run).toHaveBeenCalledTimes(failedIndex + 1);
  });

  it("fails closed on spawn errors or signal termination", () => {
    expect(checkWorkerPackage({ run: () => ({ error: new Error("spawn failed"), status: null }) })).toEqual({ status: 1 });
    expect(checkWorkerPackage({ run: () => ({ status: null }) })).toEqual({ status: 1 });
  });
});
