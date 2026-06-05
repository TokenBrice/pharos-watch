"use client";

import Image from "next/image";

type CoinCellSize = "default" | "compact";

const COIN_CELL_SIZE: Record<
  CoinCellSize,
  { height: number; width: number; className: string }
> = {
  default: {
    height: 14,
    width: 14,
    className: "h-3.5 w-3.5 rounded-full",
  },
  compact: {
    height: 12,
    width: 12,
    className: "h-3 w-3 rounded-full",
  },
};

export function CoinCell({
  logoSrc,
  size = "default",
}: {
  logoSrc: string | undefined;
  size?: CoinCellSize;
}): React.JSX.Element {
  const spec = COIN_CELL_SIZE[size];

  if (!logoSrc) {
    return <span aria-hidden="true" />;
  }

  return (
    <Image
      src={logoSrc}
      alt=""
      width={spec.width}
      height={spec.height}
      className={spec.className}
      aria-hidden
    />
  );
}
