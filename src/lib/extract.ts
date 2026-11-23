import { InvalidContentError } from './errors';
import { normalizeText } from './hash';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity.toLowerCase().startsWith('#x');
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? '';
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|nav|header|footer|aside|form|svg|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  );
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

function decodePdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_m, char: string) => {
      const map: Record<string, string> = {
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\',
      };
      return map[char] ?? char;
    })
    .replace(/\\([0-7]{1,3})/g, (_m, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
}

/**
 * Lightweight PDF text extraction: reads the literal strings inside BT/ET text
 * blocks, which covers simple, text-based PDFs. Image-only or heavily compressed
 * PDFs need a real parser and are documented as a limitation.
 */
export function pdfToText(bytes: Uint8Array): string {
  const raw = latin1(bytes);
  const chunks: string[] = [];
  const blocks = raw.match(/BT[\s\S]*?ET/g) ?? [];
  for (const block of blocks) {
    for (const match of block.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      const value = decodePdfString(match[0].slice(1, -1));
      if (value.trim().length > 1) chunks.push(value);
    }
  }

  // Fallback for PDFs whose text is stored outside BT/ET blocks.
  if (chunks.length === 0) {
    for (const match of raw.matchAll(/\((?:\\.|[^\\)]){8,}\)/g)) {
      const value = decodePdfString(match[0].slice(1, -1));
      if (/[A-Za-z]{3}/.test(value)) chunks.push(value);
    }
  }
  return chunks.join(' ');
}

export function extractText(
  bytes: Uint8Array,
  contentType: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  let raw: string;
  if (contentType.includes('html') || contentType.includes('xhtml')) {
    raw = htmlToText(new TextDecoder('utf-8').decode(bytes));
  } else if (contentType === 'application/pdf') {
    raw = pdfToText(bytes);
  } else if (contentType.startsWith('text/') || contentType === 'application/octet-stream') {
    raw = new TextDecoder('utf-8').decode(bytes);
  } else {
    throw new InvalidContentError(`Unsupported content type: ${contentType || 'unknown'}`);
  }

  const text = normalizeText(raw);
  if (text.length < 40) throw new InvalidContentError('The source has too little usable text');

  return {
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
