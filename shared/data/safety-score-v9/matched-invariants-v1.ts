export const MATCHED_V9_INVARIANTS = [
  { id: "redemption-present", rationale: "A credible common-request redemption route must improve thin DEX exit." },
  { id: "weak-optional-route", rationale: "Adding a weak optional route cannot reduce the selected strong route." },
  { id: "reserve-loss-materiality", rationale: "Greater loss-bearing reserve exposure cannot score better." },
  { id: "bridge-materiality", rationale: "A peripheral route must not bind like a material route." },
  { id: "dependency-availability", rationale: "Unavailable required dependencies must be explicit and unrated." },
  { id: "oracle-common-mode", rationale: "Shared weak oracle domains must bind below isolated branch weakness." },
  {
    id: "evidence-criticality",
    rationale: "Critical missing evidence is NR; bounded noncritical gaps remain rateable.",
  },
  { id: "parent-propagation", rationale: "A required child cannot rate above or without its parent." },
] as const;
