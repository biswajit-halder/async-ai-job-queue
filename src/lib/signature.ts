/**
 * HMAC-SHA256 over a raw payload, with a constant-time comparison.
 * Used to sign outbound job callbacks (mirrors GitHub's X-Hub-Signature-256).
 */
async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function signBody(payload: string, secret: string): Promise<string> {
  const digest = await hmac(secret, payload);
  return `sha256=${Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function verifySignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(signatureHeader.trim());
  if (!match) return false;

  try {
    const expected = await hmac(secret, payload);
    const provided = hexToBytes(match[1]!);
    if (expected.length !== provided.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i += 1) {
      difference |= expected[i]! ^ provided[i]!;
    }
    return difference === 0;
  } catch {
    return false;
  }
}
