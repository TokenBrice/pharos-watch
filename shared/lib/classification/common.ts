import type { FilterTag } from "../../types";

interface BadgeStyle {
  label: string;
  cls: string;
}

interface PegChartColor {
  label: string;
  textColor: string;
  bgColor: string;
  hex: string;
}

interface PegMetadata {
  label: string;
  shortLabel: string;
  filterTag: FilterTag;
  filterLabel: string;
  badge: BadgeStyle;
  chart?: PegChartColor;
}

export type { BadgeStyle, PegChartColor, PegMetadata };
