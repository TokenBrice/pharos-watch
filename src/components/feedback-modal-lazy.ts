import dynamic from "next/dynamic";

/** Shared lazy-loaded FeedbackModal — imported by FeedbackButton and MobileUtilityDock
 *  so the dynamic() descriptor is authored once. */
export const FeedbackModal = dynamic(
  () => import("@/components/feedback-modal").then((mod) => mod.FeedbackModal),
  { ssr: false },
);
