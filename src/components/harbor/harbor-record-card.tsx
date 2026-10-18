/**
 * Harbor record card: the pinned berth's exact values. Everything here is read from the chain snapshot as published
 * (supply, `dominanceShare` never rescaled, Chain Health band/score or the NR reason, the five cargo rows, 7d $ and %);
 * the drawing's sliver floor never reaches it.
 */
import Image from "next/image";
import Link from "next/link";
import type { ReactElement, Ref } from "react";
import { CHAIN_HEALTH_LABELS } from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";
import { formatCompactUsd, formatSignedCompactUsd, formatSignedPercent } from "@shared/lib/format";
import { CONTAINERS_PER_BAY, HARBOR_UNIT_USD, isHarborChainVessel, type HarborVessel } from "@shared/lib/harbor-scene";
import styles from "./harbor.module.css";
import { resolveCompactLogoSrc } from "@/lib/logo-variants";

export interface HarborRecordCardProps {
  vessel: HarborVessel;
  /** Chain names by id (barge member lists). */
  names: ReadonlyMap<string, string>;
  /** Pinned chain inside the tail barge, listed first. */
  focusChainId: string | null;
  onClose: () => void;
  onShowInTable: (chainId: string) => void;
  docked?: boolean;
  cardRef?: Ref<HTMLDivElement>;
}

/** "14 bays + 8.9" — whole $10B bays then $1B containers, to one decimal. */
function bayReading(totalUsd: number): string {
  const units = totalUsd / HARBOR_UNIT_USD;
  const bays = Math.floor(units / CONTAINERS_PER_BAY);
  const rest = units - bays * CONTAINERS_PER_BAY;
  const restText = `${rest.toFixed(1)} container${rest.toFixed(1) === "1.0" ? "" : "s"}`;
  return bays > 0 ? `${bays} bay${bays === 1 ? "" : "s"} + ${restText}` : restText;
}

export function HarborRecordCard({ vessel, names, focusChainId, onClose, onShowInTable, docked = false, cardRef }: HarborRecordCardProps): ReactElement {
  const titleId = `harbor-card-title-${vessel.id}`;
  const close = (
    <button type="button" className={styles.close} onClick={onClose} aria-label="Close record card">
      ×
    </button>
  );

  if (!isHarborChainVessel(vessel)) {
    const members = focusChainId ? [focusChainId, ...vessel.memberIds.filter((id) => id !== focusChainId)] : vessel.memberIds;
    return (
      <div ref={cardRef} className={styles.card} data-docked={docked} role="region" aria-labelledby={titleId} data-harbor-card>
        <div className={styles.cardHead}>
          <h3 id={titleId} className={styles.cardTitle}>
            {vessel.kind === "tail" ? "Smaller chains, pooled" : "Unattributed supply"}
          </h3>
          {close}
        </div>
        <dl className={styles.facts}>
          <dt>Supply</dt>
          <dd>{formatCompactUsd(vessel.totalUsd)}</dd>
          {vessel.kind === "tail" ? (
            <>
              <dt>Chains</dt>
              <dd>{vessel.memberIds.length}</dd>
            </>
          ) : null}
          <dt>Containers</dt>
          <dd>{bayReading(vessel.totalUsd)}</dd>
        </dl>
        {vessel.kind === "unattributed" ? (
          <p className={styles.note}>Tracked supply DefiLlama does not assign to a chain. It is not part of any chain row.</p>
        ) : (
          <>
            <p className={styles.note}>Chains under $100M (and any beyond the berth caps) share one barge; the count and sum cover every one of them.</p>
            {vessel.partialMemberIds.length > 0 ? (
              <p className={styles.note}>Partial: {vessel.partialMemberIds.length} pooled chains have unobserved supply rows.</p>
            ) : null}
            <p className={styles.members}>
              {members.map((id, k) => (
                <span key={id}>
                  {k > 0 ? " · " : null}
                  {id === focusChainId ? <b>{names.get(id) ?? id}</b> : names.get(id) ?? id}
                </span>
              ))}
            </p>
            {focusChainId ? (
              <div className={styles.actions}>
                <Link href={`/chains/${focusChainId}/`}>Open {names.get(focusChainId) ?? focusChainId} profile →</Link>
                <button type="button" onClick={() => onShowInTable(focusChainId)}>
                  Show in table ↓
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const { chain, flag, partialRows } = vessel;
  const pct = chain.change7dPct == null ? null : chain.change7dPct * 100;
  return (
    <div ref={cardRef} className={styles.card} data-docked={docked} role="region" aria-labelledby={titleId} data-harbor-card>
      <div className={styles.cardHead}>
        {chain.logoPath ? (
          <Image src={resolveCompactLogoSrc(chain.logoPath, 20)!} alt="" width={20} height={20} className={CHAIN_META[chain.id]?.darkInvert ? "rounded-full dark:invert" : "rounded-full"} style={{ width: 20, height: 20 }} />
        ) : null}
        <h3 id={titleId} className={styles.cardTitle}>
          {chain.name}
        </h3>
        {close}
      </div>
      <dl className={styles.facts}>
        <dt>Supply</dt>
        <dd>{formatCompactUsd(vessel.totalUsd)}</dd>
        <dt>Global share</dt>
        <dd>{(chain.dominanceShare * 100).toFixed(2)}%</dd>
        <dt>Chain Health</dt>
        <dd>{flag.kind === "band" ? `${CHAIN_HEALTH_LABELS[flag.band]}${flag.score == null ? "" : ` ${flag.score}`}` : "NR"}</dd>
        <dt>7d</dt>
        <dd>
          {chain.change7d == null ? "—" : formatSignedCompactUsd(chain.change7d)}
          {" · "}
          {pct == null ? (vessel.wake.kind === "new" ? "new" : "—") : formatSignedPercent(pct, 2)}
        </dd>
        <dt>Stablecoins</dt>
        <dd>{chain.stablecoinCount}</dd>
        <dt>Containers</dt>
        <dd>{bayReading(vessel.totalUsd)}</dd>
      </dl>
      {flag.kind === "unrated" ? <p className={styles.note}>{flag.reason}</p> : null}
      {partialRows > 0 ? (
        <p className={styles.note}>
          Partial: {partialRows} {partialRows === 1 ? "row" : "rows"} unobserved. The supply shown is a lower bound.
        </p>
      ) : null}
      <ul className={styles.cargo} aria-label="Top stablecoins">
        {chain.topStablecoins.map((row) => (
          <li key={row.id}>
            <span>{row.symbol}</span>
            <span className={styles.num}>
              {formatCompactUsd(row.supplyUsd)} · {(row.share * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Link href={`/chains/${chain.id}/`}>Open chain profile →</Link>
        <button type="button" onClick={() => onShowInTable(chain.id)}>
          Show in table ↓
        </button>
      </div>
    </div>
  );
}
