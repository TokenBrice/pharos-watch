import { describe, expect, it } from "vitest";
import { encodeState, type UrlStateSchema } from "@/lib/url-state";
import { replaceEncodedUrlState } from "@/lib/replace-encoded-url-state";

interface SampleState {
  alpha: string;
  beta: string;
}

const schema: UrlStateSchema<SampleState> = {
  alpha: { kind: "string", defaultValue: "", trim: false },
  beta: { kind: "string", defaultValue: "", trim: false },
};

describe("replaceEncodedUrlState", () => {
  it("preserves unrelated params and applies alphabetically encoded state", () => {
    const params = new URLSearchParams("keep=1&alpha=old&beta=old");

    replaceEncodedUrlState(
      params,
      encodeState({ alpha: "next", beta: "" }, schema),
      { clear: "all", schemaKeys: Object.keys(schema) },
    );

    expect(params.toString()).toBe("keep=1&alpha=next");
  });

  it("clears omitted defaults for all schema keys", () => {
    const params = new URLSearchParams("keep=1&alpha=old&beta=old");

    replaceEncodedUrlState(
      params,
      encodeState({ alpha: "", beta: "" }, schema),
      { clear: "all", schemaKeys: Object.keys(schema) },
    );

    expect(params.toString()).toBe("keep=1");
  });

  it("can clear only one schema key", () => {
    const params = new URLSearchParams("keep=1&alpha=old&beta=old");

    replaceEncodedUrlState(
      params,
      encodeState({ alpha: "", beta: "next" }, schema),
      { clear: "key", key: "alpha" },
    );

    expect(params.toString()).toBe("keep=1&beta=next");
  });
});
