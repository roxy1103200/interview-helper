import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ParaformerAdapter } from '../src/main/asr/paraformerAdapter';
import { defaultSettings, type Transcript } from '../src/shared/contracts';

it('streams separate PCM, normalizes transcripts and drains final text before shutdown', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('No server');
  let taskId = '';
  let receivedBytes = 0;
  server.on('connection', (socket) =>
    socket.on('message', (bytes, binary) => {
      if (binary) {
        receivedBytes += Array.isArray(bytes)
          ? bytes.reduce((sum, b) => sum + b.byteLength, 0)
          : bytes.byteLength;
        return;
      }
      const request = JSON.parse(bytes.toString());
      taskId = request.header.task_id;
      const send = (event: string, payload = {}) =>
        socket.send(JSON.stringify({ header: { task_id: taskId, event }, payload }));
      if (request.header.action === 'run-task') {
        expect(request.payload.parameters.sample_rate).toBe(16000);
        send('task-started');
        send('result-generated', {
          output: { sentence: { begin_time: 120, text: '如何保证缓存', sentence_end: false } },
        });
      }
      if (request.header.action === 'finish-task') {
        send('result-generated', {
          output: {
            sentence: {
              begin_time: 120,
              end_time: 1000,
              text: '如何保证缓存一致性？',
              sentence_end: true,
            },
          },
        });
        send('task-finished');
      }
    }),
  );
  const texts: Transcript[] = [];
  const adapter = new ParaformerAdapter(
    'session',
    'interviewer',
    { ...defaultSettings, asrEndpoint: `ws://127.0.0.1:${address.port}` },
    'test-key',
    () => 500,
    (t) => texts.push(t),
    () => {},
  );
  try {
    await adapter.connect();
    adapter.send(new Uint8Array(3200));
    await adapter.finish();
    expect(receivedBytes).toBe(3200);
    expect(texts.at(-1)?.text).toBe('如何保证缓存一致性？');
    expect(texts.at(-1)?.isFinal).toBe(true);
    expect(texts[0].utteranceId).toBe(texts[1].utteranceId);
    expect(texts[1].audioStartMs).toBe(520);
    expect(texts.every((t) => t.role === 'interviewer')).toBe(true);
  } finally {
    adapter.stop();
    server.clients.forEach((s) => s.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
