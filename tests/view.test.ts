import { afterEach, expect, it, vi } from 'vitest';
import { useSessionStore } from '../src/renderer/src/store/useSessionStore';
import type { Reply } from '../src/shared/contracts';
afterEach(() => vi.useRealTimers());
it('ignores status and transcript events queued before clear', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const state = useSessionStore.getState();
  state.event({
    type: 'status',
    status: 'listening',
    sessionId: 's1',
    epoch: 1,
    message: '双路监听中',
  });
  state.clear(2);
  state.event({
    type: 'status',
    status: 'listening',
    sessionId: 's1',
    epoch: 1,
    message: '旧状态',
  });
  state.event({
    type: 'transcript',
    data: {
      sessionId: 's1',
      role: 'interviewer',
      generation: 1,
      utteranceId: 'old',
      text: '旧问题',
      isFinal: true,
      audioStartMs: 0,
      receivedAt: 9999,
    },
  });
  expect(useSessionStore.getState().epoch).toBe(2);
  expect(useSessionStore.getState().transcripts.interviewer).toHaveLength(0);
  state.event({
    type: 'reply',
    data: {
      sessionId: 's1',
      epoch: 1,
      requestId: 'old',
      questionId: 'q1',
      revision: 1,
      type: 'start',
    },
  });
  expect(useSessionStore.getState().answers).toHaveLength(0);
});

it('shows live question tracking and model progress, replacing revisions of the same question', () => {
  useSessionStore.setState({
    sessionId: 's1',
    epoch: 10,
    answers: [],
    questions: [],
    questionDraft: '',
  });
  const state = useSessionStore.getState();
  state.event({ type: 'question-draft', sessionId: 's1', epoch: 10, text: 'HashMap 的原理' });
  expect(useSessionStore.getState().questionDraft).toBe('HashMap 的原理');
  const reply = (data: Partial<Reply>) =>
    state.event({
      type: 'reply',
      data: {
        sessionId: 's1',
        epoch: 10,
        requestId: 'r1',
        questionId: 'q1',
        revision: 1,
        type: 'start',
        ...data,
      },
    });
  reply({ message: '正在检索本地题库' });
  reply({ type: 'progress', source: 'llm', message: '正在请求 DeepSeek' });
  expect(useSessionStore.getState().answers[0].progress).toBe('正在请求 DeepSeek');
  expect(useSessionStore.getState().answers[0].message).toBeUndefined();
  reply({ type: 'delta', text: '旧正文' });
  reply({ type: 'cancelled' });
  reply({ type: 'start', requestId: 'r2', revision: 2 });
  reply({ type: 'delta', requestId: 'r2', revision: 2, text: '修订答案' });
  reply({ type: 'delta', text: '迟到旧正文' });
  expect(useSessionStore.getState().answers).toHaveLength(1);
  expect(useSessionStore.getState().answers[0].text).toBe('修订答案');
  state.clear(11);
  state.event({ type: 'question-draft', sessionId: 's1', epoch: 10, text: '旧提问' });
  expect(useSessionStore.getState().questionDraft).toBe('');
});
