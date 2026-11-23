import { signBody } from '../lib/signature';

export interface CallbackPayload {
  id: string;
  status: 'completed' | 'failed' | 'dead_letter';
  result?: { summary: string; key_points: string[] } | null;
  error?: string | null;
  updated_at: string;
}

/** Best-effort signed callback. Failures never fail the underlying job. */
export async function deliverCallback(
  url: string,
  secret: string | undefined,
  payload: CallbackPayload,
  timeoutMs: number,
): Promise<boolean> {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Job-Id': payload.id,
  };
  if (secret) headers['X-Job-Signature'] = await signBody(raw, secret);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // fall through to one retry
    }
  }
  return false;
}
