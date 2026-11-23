import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/db/queries';
import { recoverQuotaFailures } from '../src/services/recovery';
import { jobMessage, jobRow, makeEnv } from './helpers';

vi.mock('../src/db/queries', () => ({
  listQuotaFailures: vi.fn(),
  requeueJob: vi.fn(),
  toJobMessage: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(db.listQuotaFailures).mockResolvedValue([]);
  vi.mocked(db.requeueJob).mockResolvedValue(undefined);
  vi.mocked(db.toJobMessage).mockReturnValue(jobMessage());
});

describe('quota recovery', () => {
  it('requeues stale quota failures without a cron trigger', async () => {
    const env = makeEnv();
    const stale = jobRow({ status: 'failed', error: 'QUOTA_EXCEEDED: no credits' });
    vi.mocked(db.listQuotaFailures).mockResolvedValue([stale]);

    const count = await recoverQuotaFailures(env, 5);

    expect(count).toBe(1);
    expect(db.listQuotaFailures).toHaveBeenCalledWith(env, 5);
    expect(db.requeueJob).toHaveBeenCalledWith(env, stale.id);
    expect(env.JOBS.send).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no stale failures', async () => {
    const env = makeEnv();
    expect(await recoverQuotaFailures(env)).toBe(0);
    expect(db.requeueJob).not.toHaveBeenCalled();
    expect(env.JOBS.send).not.toHaveBeenCalled();
  });
});
