import { describe, expect, it } from 'vitest';
import { contentHash, generateApiKey, normalizeText, normalizeUrl, sha256 } from '../src/lib/hash';

describe('hashing', () => {
  it('produces a stable SHA-256 hex digest', async () => {
    expect(await sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('normalizes whitespace, URL fragments and tracking parameters', () => {
    expect(normalizeText('  a\t b\r\n\n\n c  ')).toBe('a b\n\nc');
    expect(normalizeUrl('https://Example.com/a?utm_source=x&b=2#frag')).toBe(
      'https://example.com/a?b=2',
    );
  });

  it('gives the same content hash for equivalent inputs and different ones for changed content', async () => {
    const first = await contentHash('summary', 'url', 'https://Example.com/a#one');
    const second = await contentHash('summary', 'url', 'https://example.com/a');
    const changed = await contentHash('summary', 'url', 'https://example.com/b');
    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(await contentHash('summary', 'text', 'hello')).not.toBe(
      await contentHash('summary', 'url', 'https://example.com/hello'),
    );
  });

  it('generates an opaque API key with a display prefix', () => {
    const { raw, prefix } = generateApiKey();
    expect(raw).toMatch(/^ajk_[0-9a-f]{48}$/);
    expect(raw).toContain(prefix);
    expect(prefix).toHaveLength(8);
  });
});
