/** Incremental UTF-8 + SSE parser. Network chunks are never message boundaries. */
export async function* sseData(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fields: string[] = [];
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  function consume(line: string): string | undefined {
    if (!line) {
      const result = fields.length ? fields.join('\n') : undefined;
      fields = [];
      return result;
    }
    if (line.startsWith('data:')) fields.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  }
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const data = consume(buffer.slice(0, at).replace(/\r$/, ''));
        buffer = buffer.slice(at + 1);
        if (data !== undefined) yield data;
      }
      if (buffer.length > 2_000_000) throw new Error('模型事件超过长度限制');
      if (done) {
        if (buffer || fields.length) throw new Error('模型事件未完整结束');
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
