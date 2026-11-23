import { contentHash } from '../lib/hash';
import type { Env } from '../types';
import { setCachedSummary } from '../services/cache';

export interface DemoExample {
  label: string;
  text: string;
  summary: string;
  keyPoints: string[];
}

/** Canned answers used by /admin/seed and the public demo — zero LLM calls. */
export const DEMO_EXAMPLES: DemoExample[] = [
  {
    label: 'CDNs',
    text: [
      'A content delivery network is a distributed group of proxy servers placed in many ' +
        'geographic locations. Its purpose is to serve content to end users with high ' +
        'availability and low latency by keeping copies close to the people requesting them.',
      'When a user requests a file, the CDN routes the request to a nearby edge server. ' +
        'If the edge has a cached copy, it responds immediately. Otherwise it fetches the ' +
        'object from the origin server, stores a copy, and then serves it.',
      'CDNs reduce bandwidth costs, absorb traffic spikes, and can terminate TLS closer to ' +
        'the user. They also improve resilience because traffic can be rerouted around a ' +
        'failing edge or a network outage.',
    ].join('\n\n'),
    summary:
      'A CDN is a distributed set of proxy servers that serves content from locations close to users, improving latency and availability. Requests hit a nearby edge, which either returns a cached copy or fetches from the origin. CDNs also reduce bandwidth costs, absorb traffic spikes, and improve resilience.',
    keyPoints: [
      'Edge servers cache content geographically close to users.',
      'Cache misses are fetched from the origin and then stored at the edge.',
      'CDNs lower bandwidth costs and absorb traffic spikes.',
      'Traffic can be rerouted around failing edges or network outages.',
    ],
  },
  {
    label: 'Message queues',
    text: [
      'A message queue is an asynchronous communication mechanism where producers publish ' +
        'messages and consumers process them independently. The producer does not wait for ' +
        'the consumer to finish, which decouples the two sides of a workflow.',
      'Queues provide buffering during traffic bursts and allow each component to scale ' +
        'separately. If a consumer fails, the message can be retried or moved to a dead ' +
        'letter queue for inspection instead of being silently lost.',
      'Most queue systems offer at-least-once delivery, so consumers should be idempotent. ' +
        'A common pattern is to record a job id or content hash and skip work that has ' +
        'already been completed.',
    ].join('\n\n'),
    summary:
      'Message queues decouple producers from consumers by letting work be published and processed asynchronously. They smooth traffic bursts, enable independent scaling, and support retries through dead letter queues. Because delivery is usually at-least-once, consumers should use idempotency keys such as job ids or content hashes.',
    keyPoints: [
      'Producers publish work without waiting for consumers.',
      'Queues buffer bursts and let components scale independently.',
      'Failed messages can be retried or moved to a dead letter queue.',
      'At-least-once delivery makes idempotent consumers important.',
    ],
  },
  {
    label: 'Caching',
    text: [
      'Caching stores the result of an expensive operation so a future identical request can ' +
        'be served faster and cheaper. In API design, a cache key should include every input ' +
        'that can change the answer, otherwise a caller may receive a stale or incorrect ' +
        'response.',
      'When the upstream service has a strict rate limit, caching is often the difference ' +
        'between a working demo and a broken one. A content hash of the normalized input ' +
        'makes a stable key, and a time to live bounds how long a value can remain stale.',
      'Cache hits should be observable. Recording hits and misses in a usage table makes it ' +
        'possible to prove that a service stayed within its request budget rather than just ' +
        'claiming it did.',
    ].join('\n\n'),
    summary:
      'Caching avoids repeating expensive operations by serving stored results for identical requests. A good cache key includes every input that affects the answer, and a TTL limits staleness. For rate-limited APIs, content-hash keys plus recorded hit and miss metrics make request-budget savings measurable.',
    keyPoints: [
      'Cache keys must include every input that affects the result.',
      'Hashing normalized content produces a stable key.',
      'A TTL bounds how long a cached value can be stale.',
      'Logging hits and misses makes quota savings provable.',
    ],
  },
];

/** Pre-warm KV with all demo answers. No OpenRouter requests are made. */
export async function seedDemoCache(env: Env): Promise<number> {
  for (const example of DEMO_EXAMPLES) {
    const hash = await contentHash('summary', 'text', example.text);
    await setCachedSummary(env, hash, {
      summary: example.summary,
      keyPoints: example.keyPoints,
      model: 'fixture:demo',
      createdAt: new Date().toISOString(),
    });
  }
  return DEMO_EXAMPLES.length;
}
