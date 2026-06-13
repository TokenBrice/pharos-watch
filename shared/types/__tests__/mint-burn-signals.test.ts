import { describe, expect, it } from "vitest";
import {
  COIN_FLOW_COMPOSITE_STATE_VALUES as RUNTIME_COIN_FLOW_COMPOSITE_STATE_VALUES,
  NET_FLOW_DIRECTION_24H_VALUES as RUNTIME_NET_FLOW_DIRECTION_24H_VALUES,
  PRESSURE_SHIFT_STATE_VALUES as RUNTIME_PRESSURE_SHIFT_STATE_VALUES,
} from "../../lib/mint-burn-signals";
import {
  COIN_FLOW_COMPOSITE_STATE_VALUES,
  NET_FLOW_DIRECTION_24H_VALUES,
  PRESSURE_SHIFT_STATE_VALUES,
} from "../mint-burn-signals";

describe("mint-burn signal type literals", () => {
  it("stay aligned with the runtime mint-burn signal helpers", () => {
    expect(NET_FLOW_DIRECTION_24H_VALUES).toEqual(RUNTIME_NET_FLOW_DIRECTION_24H_VALUES);
    expect(PRESSURE_SHIFT_STATE_VALUES).toEqual(RUNTIME_PRESSURE_SHIFT_STATE_VALUES);
    expect(COIN_FLOW_COMPOSITE_STATE_VALUES).toEqual(RUNTIME_COIN_FLOW_COMPOSITE_STATE_VALUES);
  });
});
