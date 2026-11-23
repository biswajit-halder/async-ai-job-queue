import type { CachedSummary, Env } from '../types';

const keyFor = (hash: string) => `summary:${hash}`;

export async function getCachedSummary(
  env: Env,
  hash: string,
): Promise<CachedSummary | null> {
  const value = await env.CACHE.get(keyFor(hash), 'json');
  return (value as CachedSummary | null) ?? null;
}

export async function setCachedSummary(
  env: Env,
  hash: string,
  value: CachedSummary,
): Promise<void> {
  await env.CACHE.put(keyFor(hash), JSON.stringify(value), {
    expirationTtl: Number(env.CACHE_TTL_SECONDS ?? 2_592_000),
  });
}
