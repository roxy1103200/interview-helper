// Continuous windowed-sinc low-pass resampler. Fractional phase survives render quanta.
export class PcmResampler {
  constructor(inputRate, frameSize = 1600) {
    this.ratio = inputRate / 16000;
    this.cutoff = Math.min(1, 16000 / inputRate) * 0.9;
    this.radius = 16;
    this.samples = new Array(this.radius).fill(0);
    this.position = this.radius;
    this.frame = new Int16Array(frameSize);
    this.written = 0;
  }
  push(input, emit) {
    for (const sample of input) this.samples.push(sample);
    while (this.position + this.radius < this.samples.length) {
      const center = Math.floor(this.position);
      let sum = 0,
        weights = 0;
      for (let i = center - this.radius + 1; i <= center + this.radius; i++) {
        const distance = i - this.position;
        const x = Math.PI * distance * this.cutoff;
        const sinc = Math.abs(x) < 1e-8 ? 1 : Math.sin(x) / x;
        const window = 0.5 * (1 + Math.cos((Math.PI * distance) / this.radius));
        const weight = this.cutoff * sinc * window;
        sum += (this.samples[i] ?? 0) * weight;
        weights += weight;
      }
      const sample = Math.max(-1, Math.min(1, sum / weights));
      this.frame[this.written++] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
      if (this.written === this.frame.length) {
        const bytes = new ArrayBuffer(this.frame.length * 2);
        const view = new DataView(bytes);
        this.frame.forEach((v, i) => view.setInt16(i * 2, v, true));
        emit(bytes);
        this.written = 0;
      }
      this.position += this.ratio;
    }
    const trim = Math.max(0, Math.floor(this.position) - this.radius);
    if (trim) {
      this.samples.splice(0, trim);
      this.position -= trim;
    }
  }
}
