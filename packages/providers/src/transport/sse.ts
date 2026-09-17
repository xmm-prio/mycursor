/**
 * Server-sent event parsing.
 *
 * All three providers stream with SSE, so the framing lives here once and only
 * the event payloads differ.
 */

export interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Splits an SSE byte stream into events.
 *
 * Chunk boundaries never align with event boundaries, so incomplete text is
 * carried over. `data:` lines accumulate, per the specification.
 */
export async function* parseSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    for (;;) {
      const boundary = findBoundary(buffer);
      if (boundary === -1) break;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + boundaryLength(buffer, boundary));
      const event = parseBlock(raw);
      if (event) yield event;
    }
  }

  const tail = parseBlock(buffer);
  if (tail) yield tail;
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function boundaryLength(buffer: string, index: number): number {
  return buffer.startsWith('\r\n\r\n', index) ? 4 : 2;
}

function parseBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && event === null) return null;
  return { event, data: data.join('\n') };
}
