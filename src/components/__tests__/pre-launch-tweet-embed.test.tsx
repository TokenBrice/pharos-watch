// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));

vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    captured.props.push(props);
    return <div data-testid="tweet-embed" />;
  },
}));

import { PreLaunchTweetEmbed } from "@/components/pre-launch-tweet-embed";

describe("PreLaunchTweetEmbed", () => {
  it("omits an unresolved build-time tweet instead of baking in a not-found card", () => {
    render(<PreLaunchTweetEmbed id="1234567890" />);
    expect(screen.getByTestId("tweet-embed")).toBeTruthy();

    const props = captured.props.at(-1)!;
    expect(props.id).toBe("1234567890");
    const NotFound = (props.components as { TweetNotFound: () => React.ReactNode }).TweetNotFound;
    const { container } = render(<>{NotFound()}</>);
    expect(container.textContent).toBe("");
    expect((props.onError as () => unknown)()).toBeNull();
  });
});
