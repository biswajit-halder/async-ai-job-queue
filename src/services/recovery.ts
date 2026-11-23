import * as db from '../db/queries';
import type { Env } from '../types';

/**
 * Requeue jobs that failed only because the free quota ran out. This runs after
 * a new submission, so recovery needs no cron trigger — useful on free accounts
 * that have already reached the 5-cron-trigger limit.
 */
export async function recoverQuotaFailures(env: Env, limit = 5): Promise<number> {
  const jobs = await db.listQuotaFailures(env, limit);
  let requeued = 0;

  for (const job of jobs) {
    await db.requeueJob(env, job.id);
    try {
      await env.JOBS.send(db.toJobMessage(job));
      requeued += 1;
    } catch (error) {
      console.error(`[recovery] could not requeue ${job.id}: ${String(error)}`);
    }
  }
  return requeued;
}
