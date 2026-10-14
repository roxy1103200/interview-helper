import { afterEach, describe, expect, it, vi } from 'vitest';
import { sseData } from '../src/main/llm/sseParser';
import { QuestionCoordinator } from '../src/main/questionCoordinator';
import { PcmResampler } from '../src/renderer/public/resampler.js';
import { Store } from '../src/main/storage/store';
import { parseLegacy, tokens } from '../src/shared/text';
import { ReplyCoordinator } from '../src/main/llm/replyCoordinator';
import {
  defaultSettings,
  type Knowledge,
  type Question,
  type Reply,
  type Transcript,
} from '../src/shared/contracts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function stream(parts: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      parts.forEach((p) => c.enqueue(p));
      c.close();
    },
  });
}
async function collect(s: ReadableStream<Uint8Array>) {
  const output = [];
  for await (const data of sseData(s)) output.push(data);
  return output;
}
const transcript = (text: string, id = 'u1', isFinal = true, start = 0): Transcript => ({
  sessionId: 's1',
  role: 'interviewer',
  utteranceId: id,
  generation: 1,
  text,
  isFinal,
  audioStartMs: start,
  receivedAt: Date.now(),
});
describe('SSE framing', () => {
  it('preserves Chinese UTF-8 and CRLF split at every byte', async () => {
    const source = ':heartbeat\r\ndata: {"text":"中文回答"}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(source);
    expect(await collect(stream([...bytes].map((b) => new Uint8Array([b]))))).toEqual([
      '{"text":"中文回答"}',
      '[DONE]',
    ]);
  });
  it('joins data fields and ignores comments', async () => {
    expect(
      await collect(stream([new TextEncoder().encode(':hi\ndata: one\ndata: two\n\n')])),
    ).toEqual(['one\ntwo']);
  });
  it('rejects unfinished events instead of silently dropping bytes', async () => {
    await expect(collect(stream([new TextEncoder().encode('data: {"partial":')]))).rejects.toThrow(
      '完整',
    );
  });
});
describe('question coordination', () => {
  it('requires actual audio silence, ignores repeated final events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const q = new QuestionCoordinator('s1', ready);
    q.voice('interviewer');
    q.transcript(transcript('如何保证缓存一致性？'));
    vi.advanceTimersByTime(400);
    q.voice('interviewer');
    vi.advanceTimersByTime(599);
    expect(ready).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ready).toHaveBeenCalledTimes(1);
    q.transcript(transcript('如何保证缓存一致性？'));
    vi.advanceTimersByTime(2000);
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it('filters filler and candidate speech but accepts short followups', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const q = new QuestionCoordinator('s1', ready);
    q.voice('interviewer');
    q.transcript(transcript('嗯，好的。'));
    vi.advanceTimersByTime(700);
    expect(ready).not.toHaveBeenCalled();
    q.transcript({ ...transcript('什么？', 'candidate'), role: 'candidate' });
    vi.advanceTimersByTime(700);
    expect(ready).not.toHaveBeenCalled();
    q.voice('interviewer');
    q.transcript(transcript('什么？', 'u2'));
    vi.advanceTimersByTime(600);
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it('merges continuation while preserving earlier pieces on final correction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const q = new QuestionCoordinator('s1', ready);
    q.voice('interviewer');
    q.transcript(transcript('如何设计缓存？'));
    vi.advanceTimersByTime(600);
    q.voice('interviewer');
    q.transcript(transcript('在锁失效时', 'u2', false, 1000));
    vi.advanceTimersByTime(900);
    const second = ready.mock.calls[1][0] as Question;
    expect(second.text).toContain('如何设计缓存');
    expect(second.revision).toBe(2);
    q.transcript(transcript('在锁失效的时候？', 'u2', true, 1000));
    expect((ready.mock.calls[2][0] as Question).text).toBe('如何设计缓存？在锁失效的时候？');
  });
  it('does not regenerate for identical finalization of interim', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const q = new QuestionCoordinator('s1', ready);
    q.voice('interviewer');
    q.transcript(transcript('什么？', 'u1', false));
    vi.advanceTimersByTime(900);
    q.transcript(transcript('什么？'));
    expect(ready).toHaveBeenCalledTimes(1);
  });
  it('clear discards late finals from before the view boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const q = new QuestionCoordinator('s1', ready);
    q.clear(500);
    q.transcript(transcript('什么？', 'old', true, 100));
    vi.advanceTimersByTime(1000);
    expect(ready).not.toHaveBeenCalled();
  });
  it('candidate speaking separates repeated questions into new rounds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const q = new QuestionCoordinator('s1', ready);
    q.voice('interviewer');
    q.transcript(transcript('什么？'));
    vi.advanceTimersByTime(600);
    q.voice('candidate');
    q.voice('interviewer');
    q.transcript(transcript('什么？', 'u2', true, 1000));
    vi.advanceTimersByTime(600);
    expect(ready.mock.calls[0][0].questionId).not.toBe(ready.mock.calls[1][0].questionId);
  });
});
describe('continuous PCM resampling', () => {
  for (const rate of [44100, 48000])
    it(`preserves timing across 128-sample blocks at ${rate} Hz`, () => {
      const resampler = new PcmResampler(rate, 1);
      let samples = 0;
      for (let i = 0; i < rate * 2; i += 128)
        resampler.push(new Float32Array(Math.min(128, rate * 2 - i)), () => samples++);
      expect(Math.abs(samples - 32000)).toBeLessThan(12);
    });
  it('filters frequencies above the new Nyquist limit', () => {
    function energy(hz: number) {
      const r = new PcmResampler(48000, 1600);
      let p = 0,
        n = 0;
      for (let i = 0; i < 48000; i += 128) {
        const chunk = Float32Array.from(
          { length: Math.min(128, 48000 - i) },
          (_, j) => Math.sin((2 * Math.PI * hz * (i + j)) / 48000) * 0.5,
        );
        r.push(chunk, (b: ArrayBuffer) => {
          const v = new Int16Array(b);
          for (const x of v) {
            p += x * x;
            n++;
          }
        });
      }
      return p / n;
    }
    expect(energy(11000) / energy(1000)).toBeLessThan(0.02);
  });
});
describe('knowledge storage', () => {
  const entry: Knowledge = {
    id: 'redis',
    title: '缓存一致性',
    category: '技术题',
    keywords: ['Redis', '缓存一致性'],
    answer: '第一行\n第二行 :: 保留',
    enabled: true,
  };
  it('retrieves Chinese queries and keeps multiline answers intact', () => {
    const db = new Store(':memory:');
    try {
      db.upsert([entry]);
      expect(db.search('Redis 的缓存一致性怎么保证？')[0].answer).toBe(entry.answer);
      expect(db.search('一致性')[0].id).toBe('redis');
      db.remove('redis');
      expect(db.search('Redis')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('keeps disabled entries out of both search routes', () => {
    const db = new Store(':memory:');
    try {
      db.upsert([{ ...entry, enabled: false }]);
      expect(db.search('Redis')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('preserves legacy multiline answers and reports invalid leading lines', () => {
    expect(parseLegacy('Redis|缓存 :: 第一行\n第二行')[0].answer).toBe('第一行\n第二行');
    expect(() => parseLegacy('没有分隔符')).toThrow('第 1 行');
    expect(tokens('缓存一致性')).toContain('一致');
  });
});
describe('reply cancellation', () => {
  const question = (id: string): Question => ({
    sessionId: 's1',
    questionId: id,
    revision: 1,
    text: '如何设计缓存？',
    utteranceIds: ['u'],
    provisional: false,
  });
  it('does not start a network request after cancellation during retrieval', async () => {
    let resolve!: (value: any[]) => void;
    const events: Reply[] = [];
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const r = new ReplyCoordinator(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      (e) => events.push(e),
    );
    const pending = r.generate(question('q1'), 1, defaultSettings, 'key', '');
    r.cancel();
    resolve([]);
    await pending;
    expect(network).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('cancelled');
  });
  it('does not invent an answer when neither model nor knowledge is available', async () => {
    const events: Reply[] = [];
    const r = new ReplyCoordinator(
      async () => [],
      (e) => events.push(e),
    );
    await r.generate(question('q1'), 1, defaultSettings, '', '');
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some((e) => e.type === 'delta')).toBe(false);
  });
});
