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
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${filename}-${new Date().toISOString().split("T")[0]}.png`;
    a.click();
    return true;
  } catch (err) {
    console.error("Chart export failed:", err);
    return false;
  }
}
