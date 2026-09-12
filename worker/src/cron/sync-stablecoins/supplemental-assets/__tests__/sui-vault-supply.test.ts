import { afterEach, describe, expect, it, vi } from "vitest";
import { EEARN_SUI_COIN_TYPE } from "@shared/lib/onchain-supply-probe";
import { fetchEearnSuiSupply } from "../sui-vault-supply";

const post = vi.hoisted(() => vi.fn());
vi.mock("../../../reserve-adapters/request", () => ({ fetchJsonPostWithRetry: post }));
const fixture = {
  "data": {
    "checkpoint": {
      "timestamp": "2026-09-12T12:55:21.861Z"
    },
    "coinMetadata": {
      "decimals": 6
    },
    "object": {
      "asMoveObject": {
        "contents": {
          "type": {
            "repr": "0xc83d5406fd355f34d3ce87b35ab2c0b099af9d309ba96c17e40309502a49976f::vault::Vault<0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC,0x34469c8accdd673df02600265cbbad3688577f0e716866e257f88d448d463492::eearn::EEARN>"
          },
          "json": {
            "id": "0x0779d2a4e1a6d3412982404cfe5567aac8cea229f17622c7b72d198b22a22e37",
            "receipt_token_treasury_cap": {
              "id": "0x0217f609f9e15c1160ef0ee1a432e9374c40a09d38fddba731ca713c7180f684",
              "total_supply": {
                "value": "7752490070268"
              }
            }
          }
        }
      }
    }
  }
};
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function response() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(fixture.data.checkpoint.timestamp));
  return structuredClone(fixture);
}
const read = () => fetchEearnSuiSupply(EEARN_SUI_COIN_TYPE, 6, new AbortController().signal);
describe("pinned eEARN Sui supply", () => {
  it("reads the native embedded TreasuryCap with the reviewed identity and decimals", async () => {
    post.mockResolvedValue(response());
    expect(await read()).toBe(7752490070268n);
    expect(post.mock.calls[0][1].variables.coinType).toBe(EEARN_SUI_COIN_TYPE);
  });
  it.each(["missing", "type", "decimals", "negative", "overflow", "stale", "future", "errors"])(
    "rejects %s evidence", async (failure) => {
      const value = response();
      const contents = value.data.object.asMoveObject.contents;
      if (failure === "missing") Reflect.deleteProperty(value.data, "object");
      if (failure === "type") contents.type.repr += "wrong";
      if (failure === "decimals") value.data.coinMetadata.decimals = 9;
      if (failure === "negative") contents.json.receipt_token_treasury_cap.total_supply.value = "-1";
      if (failure === "overflow") contents.json.receipt_token_treasury_cap.total_supply.value = "18446744073709551616";
      if (failure === "stale" || failure === "future") value.data.checkpoint.timestamp = new Date(Date.now() + (failure === "stale" ? -601000 : 601000)).toISOString();
      post.mockResolvedValue(failure === "errors" ? { ...value, errors: [{}] } : value);
      await expect(read()).rejects.toThrow();
    },
  );
});
