import type gsapType from "gsap";

export interface TimelineRegistry {
  parent: ReturnType<typeof gsapType.timeline>;
  pause(): void;
  resume(): void;
  destroy(): void;
}

export function createTimelineRegistry(gsap: typeof gsapType): TimelineRegistry {
  const parent = gsap.timeline({ paused: false });
  return {
    parent,
    pause() { parent.pause(); },
    resume() { parent.resume(); },
    destroy() { parent.kill(); },
  };
}
