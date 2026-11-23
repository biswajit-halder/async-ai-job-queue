export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts), 60);
}
