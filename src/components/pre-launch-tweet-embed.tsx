"use client";

import dynamic from "next/dynamic";

interface PreLaunchTweetEmbedProps {
  id: string;
}

function TweetEmbedLoading() {
  return (
    <div className="flex h-40 items-center justify-center rounded-xl border border-border/60 bg-card/50 text-sm text-muted-foreground">
      Loading tweet...
    </div>
  );
}

const Tweet = dynamic(() => import("react-tweet").then((mod) => mod.Tweet), {
  ssr: false,
  loading: TweetEmbedLoading,
});

export function PreLaunchTweetEmbed({ id }: PreLaunchTweetEmbedProps) {
  return <Tweet id={id} />;
}
