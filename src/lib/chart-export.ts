export async function downloadChartPng(
  elementRef: React.RefObject<HTMLElement | null>,
  filename: string,
): Promise<void> {
  if (!elementRef.current) return;
  try {
    const { toPng } = await import("html-to-image");
    const dataUrl = await toPng(elementRef.current, {
      pixelRatio: 2,
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${filename}-${new Date().toISOString().split("T")[0]}.png`;
    a.click();
  } catch (err) {
    console.error("Chart export failed:", err);
  }
}
