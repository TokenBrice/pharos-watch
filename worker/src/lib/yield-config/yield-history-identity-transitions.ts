import { buildOnChainSourceKey } from "../yield/yield-utils";

interface YieldHistoryIdentityTransitions {
  onChainAliases: Array<{ stablecoinId: string; sourceKey: string }>;
  legacyCarryForwardBreaks: Array<{ stablecoinId: string; sourceKey: string }>;
  ownershipHandoffs: Record<string, string[]>;
  linkedVariantFalseSwitchRepair: { lookbackDays: number; sql: string };
}

export const YIELD_HISTORY_IDENTITY_TRANSITIONS: YieldHistoryIdentityTransitions = {
  onChainAliases: [
    { stablecoinId: "lusd-liquity", sourceKey: "bprotocol-lqty-only" },
  ],
  legacyCarryForwardBreaks: [
    { stablecoinId: "scrvusd-curve", sourceKey: "onchain:scrvusd-curve:scrvusd-current-rate" },
  ],
  ownershipHandoffs: {
    "usde-ethena": [
      buildOnChainSourceKey("usde-ethena"),
      "66985a81-9c51-46ca-9977-42b4fe7bc6df",
    ],
    "usds-sky": [
      buildOnChainSourceKey("usds-sky"),
      "d8c4eff5-c8a9-46fc-a888-057c4c668e72",
    ],
    "dai-makerdao": [
      buildOnChainSourceKey("dai-makerdao"),
      "13392973-be6e-4b2f-bce9-4f7dd53d1c3a",
    ],
    "frxusd-frax": [
      buildOnChainSourceKey("frxusd-frax"),
      "42523cca-14b0-44f6-95fb-4781069520a5",
    ],
    "crvusd-curve": [
      "5fd328af-4203-471b-bd16-1705c726d926",
      "onchain:crvusd-curve:scrvusd-current-rate",
    ],
    "avusd-avant": [
      buildOnChainSourceKey("avusd-avant"),
      "2fe112ff-95a5-4ba0-8ee3-a741e6a8f7c9",
      "c74227a1-e738-4021-bbe1-13363815aecb",
    ],
    "dusd-dtrinity": [
      "defillama-weighted:dtrinity-sdusd",
      "78049985-79a8-4343-8618-3c27d41d5054",
      "f42cf641-393d-4671-895a-3c85cf7b1a57",
      "664664bb-31e0-4e65-808d-6dc82bdb05bb",
    ],
    "reusd-re-protocol": [
      "protocol-api:re-protocol-reusde",
    ],
  },
  linkedVariantFalseSwitchRepair: {
    lookbackDays: 7,
    sql: `WITH ranked_generations AS (
           SELECT d.stablecoin_id, d.generation_id, d.selected_source_key, d.source_switch,
                  ROW_NUMBER() OVER (
                    PARTITION BY d.stablecoin_id
                    ORDER BY d.created_at DESC, d.generation_id DESC
                  ) AS generation_rank
            FROM yield_source_decisions d INDEXED BY idx_yield_source_decisions_created_coin
             JOIN yield_publication_generations g
               ON g.generation_id = d.generation_id
              AND g.state = 'published'
            WHERE d.created_at >= ?
         ), verified_clean_identities AS (
           SELECT stablecoin_id, MIN(selected_source_key) AS selected_source_key
             FROM ranked_generations
            WHERE generation_rank <= 2
            GROUP BY stablecoin_id
           HAVING COUNT(*) = 2
              AND SUM(CASE WHEN source_switch = 0 AND selected_source_key LIKE 'linked-variant:%' THEN 1 ELSE 0 END) = 2
              AND MIN(selected_source_key) = MAX(selected_source_key)
         )
         UPDATE yield_source_decisions
            SET source_switch = 0,
                retention_reason = 'audit'
          WHERE source_switch = 1
            AND previous_best_source_key = 'onchain:' || stablecoin_id
            AND (stablecoin_id, selected_source_key) IN (
              SELECT stablecoin_id, selected_source_key FROM verified_clean_identities
            )`,
  },
};

export function isLegacyDeterministicOnChainSourceKey(
  stablecoinId: string,
  sourceKey: string | null | undefined,
): boolean {
  return YIELD_HISTORY_IDENTITY_TRANSITIONS.onChainAliases.some(
    (alias) => alias.stablecoinId === stablecoinId && alias.sourceKey === sourceKey,
  );
}
