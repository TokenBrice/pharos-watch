# ADR-20–25 cron incident evidence

This is an evidence index, not a current topology or acceptance contract. The [immutable incident record](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md) preserves the dated queries, measurements, version identities and review rationale. Current decisions live in the architecture ADRs below; current topology ceilings come from `CRON_GROWTH_HEADROOM_POLICY` in [`shared/lib/cron-jobs.ts`](../../shared/lib/cron-jobs.ts).

Synthetic `platform-abandoned` rows are abandonment evidence, not proof of CPU exhaustion or OOM. [`scheduled-slot-reconciliation.ts`](../../worker/src/lib/scheduled-slot-reconciliation.ts) reconstructs terminal rows from stale slots/heartbeats. Same-version reconciliation can argue against deployment interruption but cannot identify a platform resource cause; Cloudflare invocation analytics are separate evidence, and wall duration is not active CPU.

## ADR-20

[Decision](../architecture.md#adr-20) · [dated comparison and deferral](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md#adr-20).

Hourly physical aliases preserved logical cadence and connection declarations. The original latency-only Telegram deferral premise was later contradicted by ADR-24; do not reuse it as a current safety claim.

## ADR-21

[Decision](../architecture.md#adr-21) · [publication-writer correction](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md#adr-21).

The V9 publication writer could lose an attempt, unlike a durable queue's delayed delivery. Physical aliasing changed neither logical work nor connection pressure; the historical comparison alone did not prove the resource cause.

## ADR-22

[Decision](../architecture.md#adr-22) · [graph separation and memory evidence](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md#adr-22).

Separating run-scoped graphs did not promise separate warm isolates within one Worker service. Observed production executions, rather than ordering or cooperative timeouts, remain the acceptance evidence.

## ADR-23

[Decision](../architecture.md#adr-23) · [extended mint/burn alias review](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md#adr-23).

CPU-class attribution for the recorded deaths is unproven: the overlapping invocation-analytics window recorded memory deaths and no CPU deaths. Configured CPU class, wall duration and synthetic reconciliation rows cannot resolve that attribution.

## ADR-24

[Decision](../architecture.md#adr-24) · [Telegram delivery ambiguity and correction](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md#adr-24).

Unconfirmed Bot API effects became permanently ambiguous, not merely late. Narrow registry/envelope reads addressed avoidable heap use without changing topology. The historical first-week gate required event-carrying dispatches **and sidecars**, no corresponding abandonment/memory deaths, and no new effect-owner-loss rows. This index does not certify that gate; use the current [Telegram operations owner](../telegram-alerts.md).

## ADR-25

[Decision](../architecture.md#adr-25) · [staggering and narrow membership review](https://github.com/TokenBrice/pharos-watch/blob/6188bc32dc069b621cc9cf4ba6042e5ed5626ef3/docs/process/adr-20-25-cron-incident-evidence.md#adr-25).

Staggering preserved logical freshness and connection peaks without promising isolate separation; a blanket rich-registry ban would have encoded a false boundary. The recorded gate required clean first executions of measured/daily triggers without corresponding memory deaths or abandonment. This index records no closure; current [operational acceptance](../deployment-process.md#operational-acceptance) owns new-release proof.
