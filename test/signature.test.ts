import { describe, expect, it } from 'vitest';
import { signBody, verifySignature } from '../src/lib/signature';

describe('callback signatures', () => {
  it('signs and verifies a payload', async () => {
    const payload = JSON.stringify({ id: 'job_1', status: 'completed' });
    const signature = await signBody(payload, 'secret');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifySignature(payload, signature, 'secret')).toBe(true);
  });

  it('rejects tampered payloads, wrong secrets and malformed headers', async () => {
    const payload = '{"id":"job_1","status":"completed"}';
    const signature = await signBody(payload, 'secret');
    expect(await verifySignature(`${payload} `, signature, 'secret')).toBe(false);
    expect(await verifySignature(payload, signature, 'other')).toBe(false);
    expect(await verifySignature(payload, 'sha256=abc', 'secret')).toBe(false);
    expect(await verifySignature(payload, undefined, 'secret')).toBe(false);
  });
});
