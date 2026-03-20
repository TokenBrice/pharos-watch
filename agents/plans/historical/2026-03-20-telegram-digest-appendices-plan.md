## Telegram Digest Appendices Plan

1. Move cemetery-addition Telegram delivery off the dedicated 5-minute sidecar and into the daily digest Telegram post path.
2. Add deploy-diff tracking for newly tracked stablecoins, split between live tracked assets and pre-launch stablecoins.
3. Advance diff snapshots only after a successful Telegram digest post so pending additions are not lost on delivery failure.
4. Remove the standalone cemetery announcer wiring, then update tests and docs for the new behavior.
