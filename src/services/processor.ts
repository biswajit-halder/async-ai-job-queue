import * as db from '../db/queries';
import { extractText } from '../lib/extract';
import { assertPublicUrl, fetchSafe } from '../lib/fetch-safe';
import { InvalidContentError } from '../lib/errors';
import { normalizeText } from '../lib/hash';
import { newId } from '../lib/ids';
import type { Env, JobMessage, ProcessResult } from '../types';
import { deliverCallback } from './webhook';
import { summarize } from './summarizer';

/** One queue job: claim → fetch/extract → cache/LLM → persist → callback. */
export async function processJob(
  env: Env,
  message: JobMessage,
  attempts: number,
): Promise<ProcessResult> {
  const claim = await db.claimJob(env, message.id, attempts);
  if (claim.status !== 'claimed') {
    return {
      action: 'skipped',
      cache: 'MISS',
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      reason: claim.status === 'missing' ? 'job-not-found' : 'already-finished',
    };
  }

  const maxChars = Number(env.MAX_SOURCE_CHARS ?? 12_000);
  let text: string;
  let sourceRef: string;

  if (message.sourceType === 'url') {
    assertPublicUrl(message.sourceValue);
    const fetched = await fetchSafe(message.sourceValue, {
      maxBytes: Number(env.MAX_FETCH_BYTES ?? 2_000_000),
      timeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 20_000),
    });
    const extracted = extractText(fetched.body, fetched.contentType, maxChars);
    text = extracted.text;
    sourceRef = fetched.finalUrl;
  } else {
    text = normalizeText(message.sourceValue).slice(0, maxChars);
    sourceRef = `${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`;
  }

  if (text.length < 40) throw new InvalidContentError('The source has too little usable text');

  const summary = await summarize(env, message.contentHash, text, message.sourceType, sourceRef);

  const resultId = newId('res');
  await db.insertResult(env, {
    id: resultId,
    jobId: message.id,
    summary: summary.output.summary,
    keyPoints: summary.output.keyPoints,
    model: summary.model,
    sourceType: message.sourceType,
    sourceRef,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
  });
  await db.completeJob(env, message.id, resultId);
  await db.insertUsageEvent(env, {
    id: newId('use'),
    jobId: message.id,
    keyId: message.keyId,
    model: summary.model,
    cache: summary.cache,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    attempts: summary.attempts,
  });

  if (message.callbackUrl) {
    try {
      const ok = await deliverCallback(
        message.callbackUrl,
        message.callbackSecret,
        {
          id: message.id,
          status: 'completed',
          result: {
            summary: summary.output.summary,
            key_points: summary.output.keyPoints,
          },
          error: null,
          updated_at: new Date().toISOString(),
        },
        Number(env.REQUEST_TIMEOUT_MS ?? 20_000),
      );
      if (!ok) console.warn(`[callback] delivery failed for job ${message.id}`);
    } catch (error) {
      console.warn(`[callback] error for job ${message.id}: ${String(error)}`);
    }
  }

  return {
    action: 'completed',
    cache: summary.cache,
    model: summary.model,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
  };
}
