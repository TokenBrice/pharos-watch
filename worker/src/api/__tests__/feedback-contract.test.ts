import { describe, expect, it } from "vitest";
import {
  FeedbackResponseSchema,
  FeedbackWireFieldsSchema,
} from "@shared/types/feedback";
import { FeedbackBodySchema } from "../feedback/types";

const BROWSER_PAYLOAD = {
  type: "data-correction",
  description: "The current reserve source is stale on the stablecoin detail page.",
  expectedValue: "The issuer report dated yesterday.",
  stablecoinId: "usdc-circle",
  stablecoinName: "USD Coin",
  pageUrl: "/stablecoin/usdc-circle?tab=overview#reserves",
  pegValue: "$1.0000",
  contactHandle: "@pharos_user",
  website: "",
};

const WORKER_PAYLOAD = {
  ...BROWSER_PAYLOAD,
  contactConsent: true,
  contactChannel: "telegram",
  acceptedTerms: true,
};

describe("feedback wire contract", () => {
  it("accepts representative browser and Worker payloads through the shared base", () => {
    expect(FeedbackWireFieldsSchema.parse(BROWSER_PAYLOAD)).toEqual(BROWSER_PAYLOAD);
    expect(FeedbackWireFieldsSchema.parse(WORKER_PAYLOAD)).toEqual(WORKER_PAYLOAD);
    expect(FeedbackBodySchema.parse(WORKER_PAYLOAD)).toEqual(WORKER_PAYLOAD);
  });

  it("preserves legacy contact fields while keeping the Worker boundary strict", () => {
    const legacyPayload = {
      ...BROWSER_PAYLOAD,
      type: "bug",
      title: "The legacy bundle is broken",
      contactConsent: false,
      contactChannel: "x",
    };

    expect(FeedbackBodySchema.safeParse(legacyPayload).success).toBe(true);
    expect(FeedbackBodySchema.safeParse({ ...BROWSER_PAYLOAD, unsupported: true }).success).toBe(false);
  });

  it("keeps Worker-only guards narrower than the shared wire fields", () => {
    const workerOnlyRejections = [
      { title: "x".repeat(101) },
      { expectedValue: "x".repeat(501) },
      { stablecoinId: "x".repeat(101) },
      { stablecoinName: "x".repeat(101) },
      { pageUrl: "https://evil.example/feedback" },
      { pageUrl: `/${"x".repeat(300)}` },
      { pegValue: "x".repeat(101) },
      { contactHandle: "x".repeat(101) },
      { website: "x".repeat(301) },
      { acceptedTerms: false },
    ];

    for (const override of workerOnlyRejections) {
      expect(FeedbackWireFieldsSchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(true);
      expect(FeedbackBodySchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(false);
    }

    const sharedRejections = [
      { type: "spam" },
      { description: "short" },
      { description: "x".repeat(2001) },
    ];

    for (const override of sharedRejections) {
      expect(FeedbackWireFieldsSchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(false);
      expect(FeedbackBodySchema.safeParse({ ...BROWSER_PAYLOAD, ...override }).success).toBe(false);
    }
  });

  it("keeps the { ok, error? } response contract", () => {
    expect(FeedbackResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(FeedbackResponseSchema.parse({ ok: true, submissionId: "legacy" })).toEqual({ ok: true });
    expect(FeedbackResponseSchema.parse({ ok: false, error: "Try again" })).toEqual({
      ok: false,
      error: "Try again",
    });
    expect(FeedbackResponseSchema.safeParse({ ok: true, error: 123 }).success).toBe(false);
  });
});
