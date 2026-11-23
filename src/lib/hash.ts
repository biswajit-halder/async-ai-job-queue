import type { JobKind, SourceType } from '../types';

/** SHA-256 via Web Crypto (available in Workers, no node:crypto needed). */
export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeText(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalize a URL for hashing: drop fragments and common tracking params. */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

/**
 * Cache key for a summary job. Includes every input that can change the answer
 * so a hit is always for semantically identical content.
 */
export async function contentHash(
  kind: JobKind,
  sourceType: SourceType,
  sourceValue: string,
): Promise<string> {
  const normalized =
    sourceType === 'url' ? normalizeUrl(sourceValue) : normalizeText(sourceValue);
  return sha256(JSON.stringify({ v: 1, kind, sourceType, value: normalized }));
}

/** Opaque API key: `ajk_` prefix for display, random secret for auth. */
export function generateApiKey(): { raw: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const prefix = secret.slice(0, 8);
  return { raw: `ajk_${prefix}${secret.slice(8)}`, prefix };
}
