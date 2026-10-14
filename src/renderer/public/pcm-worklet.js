import { PcmResampler } from './resampler.js';
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new PcmResampler(sampleRate);
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels?.length && channels[0]?.length) {
      const mono = new Float32Array(channels[0].length);
      for (const channel of channels)
        for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
      this.resampler.push(mono, (buffer) => this.port.postMessage(buffer, [buffer]));
    }
    for (const channel of outputs[0] ?? []) channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
