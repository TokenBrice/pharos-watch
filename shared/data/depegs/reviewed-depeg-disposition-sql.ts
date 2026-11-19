import { DISPUTED_AUDIT_VERDICTS } from "../../types/depeg-audit";

const DISPUTED_VERDICTS_SQL = DISPUTED_AUDIT_VERDICTS.map((verdict) => `'${verdict}'`).join(", ");

/**
 * The alias is a static depeg_events table name or alias chosen by the reader.
 *
 * An incident family is its root plus the incidents the root superseded. The lookup names both by
 * key so every step is indexed; joining on the COALESCE of the two columns scanned all links per
 * event. Keep SQL comments out of the string: some callers flatten it onto one line.
 */
export function reviewedDepegDisputeSql(
  event: "e" | "events" | "depeg_events",
  includeAutomatedFalsePositive = true,
): string {
  const excludedVerdicts = includeAutomatedFalsePositive ? DISPUTED_VERDICTS_SQL : "'disputed'";
  return `EXISTS (
    SELECT 1 FROM depeg_events reviewed
    LEFT JOIN depeg_event_provenance evidence ON evidence.event_id = reviewed.id
    WHERE reviewed.id IN (
      SELECT ${event}.id
      UNION ALL
      SELECT member_link.event_id
        FROM depeg_resolver_incident_event_links source_link
        JOIN depeg_resolver_incidents owner ON owner.incident_key = source_link.incident_key
        JOIN depeg_resolver_incident_event_links member_link ON member_link.incident_key IN (
          SELECT root.incident_key FROM depeg_resolver_incidents root
           WHERE root.incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
             AND root.superseded_by_incident_key IS NULL
          UNION ALL
          SELECT alias.incident_key FROM depeg_resolver_incidents alias
           WHERE alias.superseded_by_incident_key = COALESCE(owner.superseded_by_incident_key, owner.incident_key)
        )
       WHERE source_link.event_id = ${event}.id
    ) AND (
      (reviewed.disposition = 'repaired' AND reviewed.admitted_coverage_json = '[]')
      OR evidence.audit_verdict IN (${excludedVerdicts})
      OR CASE WHEN json_valid(evidence.public_json)
        THEN json_extract(evidence.public_json, '$.auditVerdict') IN (${excludedVerdicts}) END
      OR EXISTS (SELECT 1 FROM depeg_resolver_prediction_errata erratum
        WHERE erratum.event_id = reviewed.id AND erratum.reason = 'input_corruption')
    )
  )`;
}
