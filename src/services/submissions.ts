import * as db from '../db/queries';
import { assertPublicUrl } from '../lib/fetch-safe';
import { contentHash, normalizeUrl } from '../lib/hash';
import { newId } from '../lib/ids';
import type { Env, JobMessage } from '../types';
import { recoverQuotaFailures } from './recovery';

export interface SubmissionInput {
  kind: 'summary';
  url?: string;
  text?: string;
  callback_url?: string;
  callback_secret?: string;
}

/** Validate the destination, persist the job, then hand it to the queue. */
export async function submitJob(
  env: Env,
  input: SubmissionInput,
  keyId: string,
): Promise<{ id: string; hash: string }> {
  if (input.url) assertPublicUrl(input.url);

  const sourceType = input.url ? 'url' : 'text';
  const sourceValue = (input.url ?? input.text)!;
  const sourceRef =
    sourceType === 'url' ? normalizeUrl(sourceValue) : `${sourceValue.slice(0, 120)}${sourceValue.length > 120 ? '…' : ''}`;
  const hash = await contentHash(input.kind, sourceType, sourceValue);
  const id = newId('job');

  await db.insertJob(env, {
    id,
    keyId,
    kind: input.kind,
    sourceType,
    sourceRef,
    sourcePayload: sourceType === 'text' ? sourceValue : null,
    contentHash: hash,
    callbackUrl: input.callback_url ?? null,
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 3),
  });

  const message: JobMessage = {
    id,
    keyId,
    kind: input.kind,
    sourceType,
    sourceValue,
    contentHash: hash,
    callbackUrl: input.callback_url,
    callbackSecret: input.callback_secret,
    createdAt: new Date().toISOString(),
  };
  await env.JOBS.send(message);
  // Piggyback on fresh submissions: no cron trigger required on free accounts.
  await recoverQuotaFailures(env, 5);

  return { id, hash };
}
