import React from "react";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import type { CoinNotice as CoinNoticeType } from "@shared/types";

const STYLES: Record<CoinNoticeType["type"], { banner: string; icon: string; title: string }> = {
  danger: {
    banner: SEVERITY_TONE_CLASS.alert.banner,
    icon: "text-red-700 dark:text-red-400",
    title: "text-red-600 dark:text-red-400",
  },
  warning: {
    banner: SEVERITY_TONE_CLASS.watch.banner,
    icon: "text-amber-700 dark:text-amber-400",
    title: "text-amber-600 dark:text-amber-400",
  },
  info: {
    banner: SEVERITY_TONE_CLASS.info.banner,
    icon: "text-blue-700 dark:text-blue-400",
    title: "text-blue-600 dark:text-blue-400",
  },
};

const ICONS: Record<CoinNoticeType["type"], React.ReactNode> = {
  danger: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-5 shrink-0">
      <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
    </svg>
  ),
  warning: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-5 shrink-0">
      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
    </svg>
  ),
  info: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="size-5 shrink-0">
      <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clipRule="evenodd" />
    </svg>
  ),
};

interface CoinNoticesProps {
  notices: CoinNoticeType[];
}

export function CoinNotices({ notices }: CoinNoticesProps) {
  if (notices.length === 0) return null;

  return (
    <div className="space-y-3">
      {notices.map((notice) => {
        const s = STYLES[notice.type];
        return (
          /* Flat callout: full hairline border + severity tint + leading icon.
             The left stripe is retired (design-language.md); border-l accent is
             reserved for data-driven indicators, which a notice is not. */
          <div
            key={`${notice.type}-${notice.title}`}
            className={`flex items-start gap-3 rounded-lg border ${s.banner} px-4 py-3`}
          >
            <span className={s.icon}>{ICONS[notice.type]}</span>
            <div className="min-w-0">
              <p className={`text-sm font-semibold ${s.title}`}>{notice.title}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{notice.message}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
