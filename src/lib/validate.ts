import { z } from 'zod';

const urlString = z
  .string()
  .min(8)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, 'Must be an absolute http(s) URL without credentials');

export const createJobSchema = z
  .object({
    kind: z.literal('summary').default('summary'),
    url: urlString.optional(),
    text: z
      .string()
      .min(40, 'text must contain at least 40 characters')
      .max(200_000, 'text is too large')
      .optional(),
    callback_url: urlString.optional(),
    callback_secret: z.string().min(8).max(128).optional(),
  })
  .refine((data) => (data.url ? 1 : 0) + (data.text ? 1 : 0) === 1, {
    message: 'Provide exactly one of "url" or "text"',
  })
  .refine((data) => !data.callback_secret || Boolean(data.callback_url), {
    message: 'callback_secret requires callback_url',
    path: ['callback_secret'],
  });

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const listJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
