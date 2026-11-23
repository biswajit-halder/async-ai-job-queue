import { describe, expect, it } from 'vitest';
import { createJobSchema } from '../src/lib/validate';

const TEXT = 'A'.repeat(60);

describe('createJobSchema', () => {
  it('accepts a text job and defaults the kind to summary', () => {
    const parsed = createJobSchema.parse({ text: TEXT });
    expect(parsed.kind).toBe('summary');
    expect(parsed.text).toBe(TEXT);
  });

  it('accepts a URL job with a signed callback', () => {
    const parsed = createJobSchema.parse({
      url: 'https://example.com/article',
      callback_url: 'https://example.com/hook',
      callback_secret: 'a-long-shared-secret',
    });
    expect(parsed.url).toBe('https://example.com/article');
  });

  it('rejects both and neither source', () => {
    expect(createJobSchema.safeParse({ text: TEXT, url: 'https://example.com' }).success).toBe(
      false,
    );
    expect(createJobSchema.safeParse({}).success).toBe(false);
  });

  it('rejects short text, non-http schemes, URLs with credentials and orphan secrets', () => {
    expect(createJobSchema.safeParse({ text: 'too short' }).success).toBe(false);
    expect(createJobSchema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(createJobSchema.safeParse({ url: 'https://user:pass@example.com' }).success).toBe(false);
    expect(
      createJobSchema.safeParse({ text: TEXT, callback_secret: 'a-long-shared-secret' }).success,
    ).toBe(false);
  });

  it('rejects unsupported job kinds', () => {
    expect(createJobSchema.safeParse({ text: TEXT, kind: 'translate' }).success).toBe(false);
  });
});
