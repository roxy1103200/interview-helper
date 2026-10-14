import type { AudioRole, Frame } from '../../../shared/contracts';
export class DualAudioEngine {
  private streams: Partial<Record<AudioRole, MediaStream>> = {};
  private contexts: Partial<Record<AudioRole, AudioContext>> = {};
  private sequences = { candidate: 0, interviewer: 0 };
  private generation = 0;
  private onEnded: (role: AudioRole, reason: string) => void;
  constructor(onEnded: (role: AudioRole, reason: string) => void) {
    this.onEnded = onEnded;
  }
  async capture(deviceId: string) {
    const generation = ++this.generation;
    const remember = (role: AudioRole) => (stream: MediaStream) => {
      if (this.generation !== generation) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('采集已取消');
      }
      this.streams[role] = stream;
      if (!stream.getAudioTracks().length)
        throw new Error(
          role === 'interviewer'
            ? '系统捕获没有音频轨道，请检查 Windows 输出设备'
            : '麦克风没有音频轨道',
        );
      stream.getAudioTracks().forEach((track) =>
        track.addEventListener('ended', () => {
          if (generation === this.generation)
            this.onEnded(role, '音频设备已断开，请停止后重新开始');
        }),
      );
    };
    // These calls happen synchronously inside the button's user gesture, before any IPC/network await.
    const system = navigator.mediaDevices
      .getDisplayMedia({ video: { width: 1, height: 1, frameRate: 1 }, audio: true })
      .then(remember('interviewer'));
    const microphone = navigator.mediaDevices
      .getUserMedia({
        video: false,
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
      .then(remember('candidate'));
    const results = await Promise.allSettled([system, microphone]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected') {
      await this.stop();
      throw failed.reason;
    }
  }
  async mount(sessionId: string, onFrame: (frame: Frame) => void) {
    const generation = this.generation;
    await Promise.all(
      (['candidate', 'interviewer'] as const).map(async (role) => {
        const stream = this.streams[role];
        if (!stream) throw new Error('音频源未准备完成');
        const context = new AudioContext();
        this.contexts[role] = context;
        await context.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).href);
        if (generation !== this.generation) {
          await context.close();
          return;
        }
        const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const worklet = new AudioWorkletNode(context, 'pcm-processor');
        const silent = context.createGain();
        silent.gain.value = 0;
        worklet.port.onmessage = (event) => {
          if (generation === this.generation && event.data instanceof ArrayBuffer)
            onFrame({
              sessionId,
              role,
              sequence: this.sequences[role]++,
              pcm: new Uint8Array(event.data),
            });
        };
        source.connect(worklet);
        worklet.connect(silent);
        silent.connect(context.destination);
        await context.resume();
        // Keep the accompanying video track alive: stopping it can end loopback on some Chromium/device combinations.
      }),
    );
  }
  pauseMicrophone() {
    this.streams.candidate?.getAudioTracks().forEach((t) => t.stop());
    this.onEnded('candidate', '本机麦克风已暂停，可验证系统声道独立性；重新开始恢复');
  }
  async stop() {
    this.generation++;
    for (const stream of Object.values(this.streams)) stream.getTracks().forEach((t) => t.stop());
    await Promise.all(
      Object.values(this.contexts).map((context) => context.close().catch(() => {})),
    );
    this.streams = {};
    this.contexts = {};
    this.sequences = { candidate: 0, interviewer: 0 };
  }
}
