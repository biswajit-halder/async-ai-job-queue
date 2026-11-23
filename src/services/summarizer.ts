import { InvalidContentError } from '../lib/errors';
import { z } from 'zod';
import type { Env, LlmResult, SourceType, SummaryOutput } from '../types';
import { getCachedSummary, setCachedSummary } from './cache';
import { callLlm } from './llm';
import type { ChatMessage } from './llm';

export const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A concise 2-4 sentence summary of the source.' },
    key_points: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to six short bullet points capturing the main ideas.',
    },
  },
  required: ['summary', 'key_points'],
  additionalProperties: false,
};

const OutputSchema = z.object({
  summary: z.string().min(1),
  key_points: z.array(z.string().min(1)).max(8),
});

const SYSTEM_PROMPT = [
  'You summarize text faithfully for a technical portfolio demo.',
  'Return only the requested JSON object. Never invent facts that are not in the source.',
  'Keep the summary between 2 and 4 sentences and the key points short.',
].join(' ');

function parseOutput(raw: string): SummaryOutput {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new InvalidContentError('The model returned invalid JSON');
  }

  const result = OutputSchema.safeParse(parsed);
  if (!result.success) throw new InvalidContentError('The model output did not match the schema');
  return { summary: result.data.summary, keyPoints: result.data.key_points };
}

function repairMessages(badRaw: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'The previous response was not a valid JSON object matching the schema. ' +
        'Return a corrected JSON object now. Do not explain the error.',
    },
    { role: 'assistant', content: badRaw },
  ];
}

export interface SummarizeResult {
  output: SummaryOutput;
  cache: 'HIT' | 'MISS';
  model: string;
  promptTokens: number;
  completionTokens: number;
  attempts: number;
}

/** Cache first so identical content never costs an OpenRouter request. */
export async function summarize(
  env: Env,
  contentKey: string,
  text: string,
  sourceType: SourceType,
  sourceRef: string,
): Promise<SummarizeResult> {
  const cached = await getCachedSummary(env, contentKey);
  if (cached) {
    return {
      output: { summary: cached.summary, keyPoints: cached.keyPoints },
      cache: 'HIT',
      model: cached.model,
      promptTokens: 0,
      completionTokens: 0,
      attempts: 0,
    };
  }

  const baseRequest = {
    env,
    schemaName: 'job_summary',
    jsonSchema: SUMMARY_SCHEMA,
  };

  let llm: LlmResult = await callLlm({
    ...baseRequest,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Source type: ${sourceType}\nSource: ${sourceRef}\n\n---\n${text}\n---`,
  });

  let output: SummaryOutput;
  try {
    output = parseOutput(llm.raw);
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    const repair = await callLlm({
      ...baseRequest,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: '',
      messages: repairMessages(llm.raw),
    });
    llm = {
      ...repair,
      promptTokens: llm.promptTokens + repair.promptTokens,
      completionTokens: llm.completionTokens + repair.completionTokens,
      attempts: llm.attempts + repair.attempts,
    };
    output = parseOutput(llm.raw);
  }

  await setCachedSummary(env, contentKey, {
    ...output,
    model: llm.model,
    createdAt: new Date().toISOString(),
  });

  return {
    output,
    cache: 'MISS',
    model: llm.model,
    promptTokens: llm.promptTokens,
    completionTokens: llm.completionTokens,
    attempts: llm.attempts,
  };
}
