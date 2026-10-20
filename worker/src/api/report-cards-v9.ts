import { jsonResponse, safetyScoreSnapshotHeaders, withRepresentationEtag } from "../lib/api-response";
import { loadV9PublicMaterializedResponse, V9PublicMaterializationUnavailableError } from "../lib/report-cards-v9-materialization";
import type { SafetyScoreV9FreshnessAssessment } from "@shared/types/safety-score-v9-public";

/**
 * Wire-only compatibility for full/detail reports. Track JSON structure across
 * authenticated fragments and buffer only a targeted freshness object. Every
 * byte outside the four card-local values is passed through unchanged.
 */
export function legacyV9FreshnessBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  type Role = "root" | "cards" | "card" | "pillars" | "pillar" | "evidence" | "other";
  type Frame = { object: boolean; role: Role; key: string | null; expectsKey: boolean };
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let quoted = false;
  let escaped = false;
  let keyOwner: Frame | null = null;
  let keyText = "";
  let targetDepth = 0;
  let parts: string[] = [];
  const project = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    let outputStart = 0;
    let targetStart = targetDepth > 0 ? 0 : -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      const parent = frames[frames.length - 1];
      if (quoted) {
        if (keyOwner !== null) keyText += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          quoted = false;
          if (keyOwner !== null) {
            keyOwner.key = JSON.parse(keyText) as string;
            keyOwner = null;
            keyText = "";
          }
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
        if (parent?.object && parent.expectsKey) {
          parent.expectsKey = false;
          if (parent.role !== "other") { keyOwner = parent; keyText = '"'; }
        }
      } else if (char === "{" || char === "[") {
        let role: Role = "other";
        if (frames.length === 0) role = "root";
        else if (char === "[" && parent?.role === "root" && parent.key === "cards") role = "cards";
        else if (char === "{") {
          if (parent?.role === "cards") role = "card";
          else if (parent?.role === "card" && parent.key === "pillars") role = "pillars";
          else if (parent?.role === "card" && parent.key === "evidence") role = "evidence";
          else if (parent?.role === "pillars" && (parent.key === "backing" || parent.key === "exit" || parent.key === "control")) role = "pillar";
          if ((parent?.role === "pillar" || parent?.role === "evidence") && parent.key === "freshness") {
            if (index > outputStart) controller.enqueue(encoder.encode(text.slice(outputStart, index)));
            targetStart = index;
            targetDepth = frames.length + 1;
          }
        }
        frames.push({ object: char === "{", role, key: null, expectsKey: char === "{" });
      } else if (char === "}" || char === "]") {
        if (targetDepth === frames.length) {
          parts.push(text.slice(targetStart, index + 1));
          // Only these small objects are decoded. Canonical cards, numeric
          // lexical forms and string escaping are never reserialized.
          const assessment = JSON.parse(parts.join("")) as Pick<SafetyScoreV9FreshnessAssessment, "verdict">;
          controller.enqueue(encoder.encode(JSON.stringify(assessment.verdict)));
          parts = [];
          targetDepth = 0;
          targetStart = -1;
          outputStart = index + 1;
        }
        frames.pop();
      } else if (char === "," && parent?.object) {
        parent.expectsKey = true;
        parent.key = null;
      }
    }
    if (targetDepth > 0) parts.push(text.slice(targetStart));
    else if (outputStart < text.length) controller.enqueue(encoder.encode(text.slice(outputStart)));
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { project(decoder.decode(chunk, { stream: true }), controller); },
    flush(controller) {
      project(decoder.decode(), controller);
      if (frames.length > 0 || quoted || targetDepth > 0) throw new Error("Incomplete materialized V9 JSON");
    },
  }));
}

/** Every invocation admits live accepted identity/health; only immutable bytes are reused. */
export const handleReportCardsV9 = async (db: D1Database, url?: URL): Promise<Response> => {
  try {
    const snapshot = await loadV9PublicMaterializedResponse(db);
    const assessments = url?.searchParams.get("freshness") === "assessments";
    const body = assessments ? snapshot.body : legacyV9FreshnessBody(snapshot.body);
    return withRepresentationEtag(new Response(body, { headers: safetyScoreSnapshotHeaders(snapshot) }),
      ["report-cards-v9", assessments ? "assessments" : "legacy-verdicts", snapshot.representationIdentity, snapshot.publicationHealth]);
  } catch (error) {
    const reason = error instanceof V9PublicMaterializationUnavailableError
      ? error.reason : "v9-public-materialization-read-failed";
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Canonical V9 representation is unavailable", reason },
      { status: 503, noStore: true },
    );
  }
};
