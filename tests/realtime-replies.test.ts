import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionCoordinator } from '../src/main/questionCoordinator';
import { ReplyCoordinator } from '../src/main/llm/replyCoordinator';
import {
  defaultSettings,
  type Question,
  type Reply,
  type Transcript,
} from '../src/shared/contracts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function transcript(text: string, id: string, isFinal = true, start = 0): Transcript {
  return {
    sessionId: 's',
    role: 'interviewer',
    utteranceId: id,
    generation: 1,
    text,
    isFinal,
    audioStartMs: start,
    receivedAt: Date.now(),
  };
}
function question(text: string, id = 'q1'): Question {
  return {
    sessionId: 's',
    questionId: id,
    revision: 1,
    text,
    utteranceIds: [id],
    provisional: false,
  };
}
function response(text = 'Redis Lua 脚本执行期间不会穿插其他命令。', done = true) {
  const events = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('');
  return new Response(events + (done ? 'data: [DONE]\n\n' : ''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('continuous interviewer questions', () => {
  it('submits every finalized technical topic despite continuous loopback noise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn(),
      draft = vi.fn();
    const coordinator = new QuestionCoordinator('s', ready, draft);
    const topics = [
      'Redis 缓存穿透',
      'HashMap',
      'JVM 垃圾回收',
      'Spring 事务',
      '数据库索引',
      '线程池参数',
      'TCP 三次握手',
      'RabbitMQ 消息幂等',
    ];
    topics.forEach((topic, index) => {
      coordinator.voice('interviewer');
      coordinator.transcript(transcript(topic, `u${index}`, true, index * 2000));
      expect(draft).toHaveBeenLastCalledWith(topic);
      for (let i = 0; i < 11; i++) {
        coordinator.voice('interviewer');
        vi.advanceTimersByTime(100);
      }
      expect(ready).toHaveBeenCalledTimes(index + 1);
      expect(ready.mock.calls[index][0].text).toBe(topic);
    });
    expect(new Set(ready.mock.calls.map(([q]) => q.questionId)).size).toBe(topics.length);
    coordinator.stop();
  });

  it('uses stable interim text when noise prevents silence and avoids an identical final restart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const coordinator = new QuestionCoordinator('s', ready);
    coordinator.voice('interviewer');
    coordinator.transcript(transcript('讲一下线程池', 'u1', false));
    for (let i = 0; i < 17; i++) {
      coordinator.voice('interviewer');
      vi.advanceTimersByTime(100);
    }
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].provisional).toBe(true);
    coordinator.transcript(transcript('讲一下线程池。', 'u1'));
    expect(ready).toHaveBeenCalledTimes(1);
    coordinator.stop();
  });

  it('keeps a new pending question when an earlier provisional question receives a late correction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const coordinator = new QuestionCoordinator('s', ready);
    coordinator.voice('interviewer');
    coordinator.transcript(transcript('Redis 原理', 'u1', false));
    vi.advanceTimersByTime(900);
    coordinator.voice('interviewer');
    coordinator.transcript(transcript('HashMap 线程安全吗？', 'u2', true, 2000));
    coordinator.transcript(transcript('Redis 数据结构原理', 'u1'));
    vi.advanceTimersByTime(600);
    expect(ready.mock.calls.map(([q]) => q.text)).toEqual([
      'Redis 原理',
      'Redis 数据结构原理',
      'HashMap 线程安全吗？',
    ]);
    coordinator.stop();
  });

  it('can immediately answer a draft and retry it without a duplicate automatic request', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const ready = vi.fn();
    const coordinator = new QuestionCoordinator('s', ready);
    coordinator.voice('interviewer');
    coordinator.transcript(transcript('请结合上一段展开', 'u1', false));
    expect(coordinator.answerLatest()).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(coordinator.answerLatest()).toBe(true);
    expect(ready.mock.calls[1][0].revision).toBe(2);
    coordinator.clear(3000);
    expect(coordinator.answerLatest()).toBe(false);
    coordinator.stop();
  });
});

describe('model answering and recovery', () => {
  it('answers technical questions with the model even when the knowledge base is empty', async () => {
    const events: Reply[] = [];
    const network = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal('fetch', network);
    const replies = new ReplyCoordinator(
      async () => [],
      (event) => events.push(event),
    );
    await replies.generate(
      question('Redis Lua 为什么是原子的？'),
      1,
      defaultSettings,
      'test-key',
      '',
    );
    const payload = JSON.parse(String(network.mock.calls[0][1]?.body));
    expect(payload.messages[0].content).toContain('未命中也必须正常回答');
    expect(payload.max_tokens).toBeLessThanOrEqual(500);
    expect(events.some((e) => e.type === 'progress' && e.source === 'llm')).toBe(true);
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
  });

  it('continues through eight model answers without depending on a local hit', async () => {
    const events: Reply[] = [];
    const network = vi.fn<typeof fetch>(async () => response());
    vi.stubGlobal('fetch', network);
    const replies = new ReplyCoordinator(
      async () => [],
      (event) => events.push(event),
    );
    for (let i = 0; i < 8; i++)
      await replies.generate(question(`技术题 ${i}`, `q${i}`), 1, defaultSettings, 'test-key', '');
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(8);
    expect(replies.history).toHaveLength(8);
    const payload = JSON.parse(String(network.mock.calls.at(-1)![1]?.body));
    expect(payload.messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(
      3,
    );
  });

  it('does not let a broken or indefinitely pending local lookup block DeepSeek', async () => {
    vi.useFakeTimers();
    const events: Reply[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response()),
    );
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const replies = new ReplyCoordinator(lookup, (event) => events.push(event));
    await replies.generate(question('线程池参数'), 1, defaultSettings, 'test-key', '');
    const pending = replies.generate(question('HashMap', 'q2'), 1, defaultSettings, 'test-key', '');
    await vi.advanceTimersByTimeAsync(1200);
    await pending;
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(2);
  });

  it('times out a stuck request and can immediately answer the next question', async () => {
    vi.useFakeTimers();
    const events: Reply[] = [];
    const network = vi
      .fn()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      )
      .mockImplementationOnce(async () => response());
    vi.stubGlobal('fetch', network);
    const replies = new ReplyCoordinator(
      async () => [],
      (event) => events.push(event),
    );
    const pending = replies.generate(question('索引原理'), 1, defaultSettings, 'test-key', '');
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(events.at(-1)?.message).toContain('首字等待超时');
    await replies.generate(question('Redis Lua', 'q2'), 1, defaultSettings, 'test-key', '');
    expect(events.at(-1)?.type).toBe('complete');
    expect(events.at(-1)?.questionId).toBe('q2');
  });

  it('prioritizes the newest question and ignores a late response from the cancelled one', async () => {
    const events: Reply[] = [];
    let release!: (response: Response) => void;
    const network = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementationOnce(async () => response('新问题的答案'));
    vi.stubGlobal('fetch', network);
    const replies = new ReplyCoordinator(
      async () => [],
      (event) => events.push(event),
    );
    const old = replies.generate(question('旧问题'), 1, defaultSettings, 'test-key', '');
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(1));
    await replies.generate(question('新问题', 'q2'), 1, defaultSettings, 'test-key', '');
    release(response('旧答案'));
    await old;
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual(['新问题的答案']);
    expect(events.some((e) => e.type === 'cancelled' && e.questionId === 'q1')).toBe(true);
  });

  it('accepts a complete stop event when the stream closes without a DONE marker', async () => {
    const events: Reply[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('完整答案', false)),
    );
    const replies = new ReplyCoordinator(
      async () => [],
      (event) => events.push(event),
    );
    await replies.generate(question('索引原理'), 1, defaultSettings, 'test-key', '');
    expect(events.at(-1)?.type).toBe('complete');
  });
});
