import { describe, expect, it } from 'vitest';
import { extractText, htmlToText, pdfToText } from '../src/lib/extract';
import { InvalidContentError } from '../src/lib/errors';

const encoder = new TextEncoder();

describe('extractText', () => {
  it('strips HTML boilerplate and decodes entities', () => {
    const html =
      '<html><head><script>alert(1)</script><style>.x{}</style></head>' +
      '<body><nav>Menu</nav><h1>Hello &amp; welcome</h1>' +
      '<p>A CDN serves &#x63;ontent from the edge.</p><footer>Bye</footer></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Hello & welcome');
    expect(text).toContain('A CDN serves content from the edge.');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('Menu');
    expect(text).not.toContain('Bye');
  });

  it('extracts text from a simple PDF content stream', () => {
    const pdf =
      'BT /F1 12 Tf 72 720 Td (A content delivery network is a distributed proxy layer.) Tj ET\n' +
      'BT 72 700 Td (It caches content close to users and reduces latency.) Tj ET';
    const text = pdfToText(encoder.encode(pdf));
    expect(text).toContain('distributed proxy layer');
    expect(text).toContain('reduces latency');
  });

  it('returns cleaned text and a truncation flag', () => {
    const long = `A CDN reduces latency for users. ${'More detail here. '.repeat(30)}`;
    const result = extractText(encoder.encode(long), 'text/plain', 80);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
  });

  it('rejects unsupported content types and text that is too short', () => {
    expect(() => extractText(encoder.encode('hi'), 'image/png', 100)).toThrow(InvalidContentError);
    expect(() => extractText(encoder.encode('hi'), 'text/plain', 100)).toThrow(InvalidContentError);
  });
});
