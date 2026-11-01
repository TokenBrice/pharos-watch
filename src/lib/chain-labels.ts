export function stablecoinCountLabel(count: number): string {
  return `${count} stablecoin${count === 1 ? "" : "s"}`;
}

export function deploymentCountLabel(count: number): string {
  return `${count} active deployment${count === 1 ? "" : "s"}`;
}
