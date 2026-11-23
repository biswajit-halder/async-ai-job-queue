import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, fetchSafe, isBlockedIp } from '../src/lib/fetch-safe';
import { SsrfBlockedError } from '../src/lib/errors';
import { makeEnv, response, SAMPLE_TEXT } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, CGNAT, reserved and documentation ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '[::1]',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicUrl', () => {
  it('rejects local hostnames, private literals and bad schemes', () => {
    for (const url of [
      'http://localhost/a',
      'http://app.local',
      'http://service.internal',
      'http://127.0.0.1',
      'http://[::1]/',
      'file:///etc/passwd',
      'https://user:pass@example.com',
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow(SsrfBlockedError);
    }
  });

  it('accepts an ordinary https URL', () => {
    expect(assertPublicUrl('https://example.com/article').hostname).toBe('example.com');
  });
});

describe('fetchSafe', () => {
  it('resolves DNS over HTTPS and rejects a hostname that points to a private IP', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cloudflare-dns.com')) {
        return response(200, { Answer: [{ type: 1, data: '169.254.169.254' }] });
      }
      throw new Error('the page should never be fetched');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSafe('https://metadata.example.com/', { maxBytes: 1000, timeoutMs: 1000 }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('fetches a public page and re-validates redirect targets', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cloudflare-dns.com')) {
        return response(200, { Answer: [{ type: 1, data: '93.184.215.14' }] });
      }
      if (url.startsWith('https://example.com/start')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/latest/meta-data' },
        });
      }
      throw new Error('the private redirect should never be fetched');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSafe('https://example.com/start', { maxBytes: 1000, timeoutMs: 1000 }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('returns the body and content type for a safe public response', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cloudflare-dns.com')) {
        return response(200, { Answer: [{ type: 1, data: '93.184.215.14' }] });
      }
      return new Response(SAMPLE_TEXT, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSafe('https://example.com/article', {
      maxBytes: 100_000,
      timeoutMs: 1000,
    });
    expect(new TextDecoder().decode(result.body)).toContain('content delivery network');
    expect(result.contentType).toBe('text/plain');
    expect(result.finalUrl).toBe('https://example.com/article');
  });

  it('caps response size using content-length', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cloudflare-dns.com')) {
        return response(200, { Answer: [{ type: 1, data: '93.184.215.14' }] });
      }
      return new Response('x'.repeat(100), {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '999999' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchSafe('https://example.com/big', { maxBytes: 1000, timeoutMs: 1000 }),
    ).rejects.toThrow(/too large/);
  });

  it('uses makeEnv with a queue binding for downstream tests', () => {
    expect(makeEnv().JOBS).toBeDefined();
  });
});
