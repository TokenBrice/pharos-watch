import { formatUtcDateOnly } from "@shared/lib/format";
import { triggerUrlDownload } from "@/lib/exports/download";

export async function downloadChartPng(
  elementRef: React.RefObject<HTMLElement | null>,
  filename: string,
): Promise<boolean> {
  if (!elementRef.current) return false;
  try {
    const { toPng } = await import("html-to-image");
    const dataUrl = await toPng(elementRef.current, {
      pixelRatio: 2,
    });
    triggerUrlDownload(dataUrl, `${filename}-${formatUtcDateOnly(new Date())}.png`);
    return true;
  } catch (err) {
    console.error("Chart export failed:", err);
    return false;
  }
}
