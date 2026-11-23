import { FetchFailedError, SsrfBlockedError } from './errors';

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: Array<[base: string, bits: number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (
    (((nums[0]! << 24) >>> 0) + (nums[1]! << 16) + (nums[2]! << 8) + nums[3]!) >>> 0
  );
}

function inV4Cidr(value: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseInt & mask);
}

export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '').toLowerCase();

  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return BLOCKED_V4.some(([base, bits]) => inV4Cidr(v4, base, bits));

  if (!ip.includes(':')) return false;
  if (ip === '::' || ip === '::1') return true;

  // IPv4-mapped IPv6 addresses must be checked against the v4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isBlockedIp(mapped[1]!);

  const first = Number.parseInt(ip.split(':')[0] || '0', 16);
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7  unique local
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link local
  if (ip.startsWith('2001:db8:')) return true; // documentation
  return false;
}

function isIpLiteral(host: string): boolean {
  return ipv4ToInt(host) !== null || host.includes(':');
}

/** Cheap checks done at submission time and again before every fetch. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfBlockedError('Only http(s) URLs are allowed');
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('URLs with credentials are not allowed');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new SsrfBlockedError('Local hostnames are not allowed');
  }
  if (isIpLiteral(host) && isBlockedIp(host)) {
    throw new SsrfBlockedError('Private or reserved IP addresses are not allowed');
  }
  return url;
}

interface DnsAnswer {
  type: number;
  data: string;
}

/** DNS-over-HTTPS: Workers cannot call node:dns, and resolving is required to
 *  prevent DNS rebinding past the hostname checks above. */
async function resolvePublicIps(hostname: string): Promise<string[]> {
  const query = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new FetchFailedError(`DNS lookup failed (${response.status})`);
    const data = (await response.json()) as { Answer?: DnsAnswer[] };
    const recordType = type === 'A' ? 1 : 28;
    return (data.Answer ?? [])
      .filter((answer) => answer.type === recordType)
      .map((answer) => answer.data.replace(/\.$/, ''));
  };

  const v4 = await query('A');
  const v6 = await query('AAAA').catch(() => [] as string[]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) throw new SsrfBlockedError('Hostname did not resolve');
  if (addresses.some(isBlockedIp)) {
    throw new SsrfBlockedError('Hostname resolves to a private or reserved IP address');
  }
  return addresses;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new FetchFailedError('Source response is too large');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new FetchFailedError('Source response has no body');

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new FetchFailedError('Source response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export interface SafeFetchResult {
  body: Uint8Array;
  contentType: string;
  finalUrl: string;
}

/** Validate → resolve → fetch, re-checking every redirect hop. */
export async function fetchSafe(
  rawUrl: string,
  options: { maxBytes: number; timeoutMs: number; maxRedirects?: number },
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertPublicUrl(current);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!isIpLiteral(host)) await resolvePublicIps(host);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { 'user-agent': 'async-ai-job-queue/1.0 (+portfolio project)' },
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) throw error;
      throw new FetchFailedError(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || hop === maxRedirects) throw new FetchFailedError('Too many redirects');
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new FetchFailedError(`Source returned HTTP ${response.status}`);

    const body = await readLimited(response, options.maxBytes);
    if (body.byteLength === 0) throw new FetchFailedError('Source response was empty');

    return {
      body,
      contentType: (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
      finalUrl: url.toString(),
    };
  }

  throw new FetchFailedError('Too many redirects');
}
