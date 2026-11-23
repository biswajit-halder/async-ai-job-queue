import type { MiddlewareHandler } from 'hono';
import {
  createRateCounter,
  getRateCounter,
  incrementRateCounter,
  resetRateCounter,
} from '../db/queries';
import { RateLimitedError } from '../lib/errors';
import type { AppEnv } from '../types';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** D1-backed sliding windows with one atomic conditional UPDATE per request. */
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { keyId, dailyLimit, perMinuteLimit } = c.get('auth');
  const now = Date.now();
  const minuteStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;

  let remainingMinute: number;
  let remainingDay: number;

  const row = await getRateCounter(c.env, keyId);
  if (!row) {
    await createRateCounter(c.env, keyId, minuteStart, dayStart);
    remainingMinute = perMinuteLimit - 1;
    remainingDay = dailyLimit - 1;
  } else if (row.minute_start !== minuteStart || row.day_start !== dayStart) {
    await resetRateCounter(c.env, keyId, minuteStart, dayStart);
    remainingMinute = perMinuteLimit - 1;
    remainingDay = dailyLimit - 1;
  } else {
    const result = await incrementRateCounter(c.env, keyId, {
      perMinute: perMinuteLimit,
      daily: dailyLimit,
    });
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((minuteStart + MINUTE_MS - now) / 1000));
      throw new RateLimitedError('Rate limit exceeded for this API key', retryAfter);
    }
    remainingMinute = result.minuteRemaining;
    remainingDay = result.dayRemaining;
  }

  c.header('X-RateLimit-Limit', String(perMinuteLimit));
  c.header('X-RateLimit-Remaining', String(Math.max(0, remainingMinute)));
  c.header('X-RateLimit-Daily-Remaining', String(Math.max(0, remainingDay)));
  await next();
};
