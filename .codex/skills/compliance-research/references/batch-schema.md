# Compliance Batch Schemas

These are the harness-neutral response envelopes for batch mode. The live regime object, enum set, cross-field rules, and required evidence remain owned by `shared/types/stablecoin-meta-schemas.ts`, `docs/genius-tracker.md`, and `docs/mica-tracker.md`; validate parsed `proposedJson` and `finalJson` with the repository check before writing.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "regimeProposal": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "assessed": { "type": "boolean" },
        "changeKind": { "type": "string", "enum": ["no-change", "correct", "add-new-row", "remove-row", "unable-to-verify"] },
        "consequential": { "type": "boolean" },
        "consequentialReason": { "type": "string" },
        "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
        "summary": { "type": "string" },
        "proposedJson": { "type": "string" },
        "sources": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["assessed", "changeKind", "consequential", "confidence", "summary", "proposedJson"]
    },
    "research": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string" },
        "mica": { "$ref": "#/$defs/regimeProposal" },
        "genius": { "$ref": "#/$defs/regimeProposal" },
        "notes": { "type": "string" }
      },
      "required": ["id", "mica", "genius"]
    },
    "regimeVerdict": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "verdict": { "type": "string", "enum": ["confirm-no-change", "apply-correction", "flag-for-approval", "reject-proposal", "unable-to-verify", "not-applicable"] },
        "safeToAutoApply": { "type": "boolean" },
        "isNewRow": { "type": "boolean" },
        "finalJson": { "type": "string" },
        "changeSummary": { "type": "string" },
        "issues": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["verdict", "safeToAutoApply", "isNewRow", "finalJson", "changeSummary"]
    },
    "verify": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string" },
        "mica": { "$ref": "#/$defs/regimeVerdict" },
        "genius": { "$ref": "#/$defs/regimeVerdict" },
        "flags": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "regime": { "type": "string", "enum": ["mica", "genius"] },
              "summary": { "type": "string" },
              "action": { "type": "string", "enum": ["needs-approval", "needs-more-research"] }
            },
            "required": ["regime", "summary", "action"]
          }
        },
        "overallConfidence": { "type": "string", "enum": ["high", "medium", "low"] }
      },
      "required": ["id", "mica", "genius", "flags"]
    },
    "landscape": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "headline": { "type": "string" },
        "findings": { "type": "array", "items": { "type": "string" } },
        "regimeStateRecommendation": { "type": "string" },
        "sources": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["headline", "findings"]
    },
    "gap": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "regime": { "type": "string", "enum": ["mica", "genius"] },
        "shortlist": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": { "type": "string" },
              "symbol": { "type": "string" },
              "reason": { "type": "string" }
            },
            "required": ["id", "reason"]
          }
        },
        "rejectedNote": { "type": "string" }
      },
      "required": ["regime", "shortlist"]
    }
  }
}
```
