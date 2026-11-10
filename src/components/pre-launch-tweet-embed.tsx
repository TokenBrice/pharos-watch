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
  loading: TweetEmbedLoading,
});

/**
 * A build-time fetch failure and a deleted tweet look identical here, and
 * neither is a reviewed finding about the coin: omit the embed rather than
 * baking react-tweet's "Tweet not found" card into the static export.
 */
function TweetUnavailable() {
  return <></>;
}

export function PreLaunchTweetEmbed({ id }: PreLaunchTweetEmbedProps) {
  return <Tweet id={id} components={{ TweetNotFound: TweetUnavailable }} onError={() => null} />;
}
