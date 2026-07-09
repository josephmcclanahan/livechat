// AudioWorklet processor for the live voice path: captures mic audio at the context's
// native rate, resamples it to a fixed low rate, and posts fixed-size Int16 PCM frames
// to the main thread. Raw PCM frames need no container, so — unlike MediaRecorder
// output — they can be relayed and played mid-stream on every browser, including iOS.

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.frameSize = opts.frameSize || 960;
    this.baseStep = sampleRate / this.targetRate; // input samples per output sample
    this.step = this.baseStep;
    // Main thread measures real throughput and corrects the step — the context's global
    // sampleRate can misstate the mic feed's true rate (iOS changes the hardware rate
    // when the mic session starts, after this context's rate was locked).
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'stepScale' && e.data.value > 0) {
        this.step = this.baseStep * e.data.value;
      }
    };
    this.raw = new Float32Array(8192);        // unconsumed input samples
    this.rawLen = 0;
    this.readPos = 0;                         // fractional resample cursor into `raw`
    this.frame = new Int16Array(this.frameSize);
    this.frameLen = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || !input.length) return true;

    // Append this 128-sample block to the pending input.
    if (this.rawLen + input.length > this.raw.length) {
      const grown = new Float32Array(Math.max(this.raw.length * 2, this.rawLen + input.length));
      grown.set(this.raw.subarray(0, this.rawLen));
      this.raw = grown;
    }
    this.raw.set(input, this.rawLen);
    this.rawLen += input.length;

    // Resample by linear interpolation; ship each frame as soon as it fills.
    while (this.readPos + 1 < this.rawLen) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const s = this.raw[i] + (this.raw[i + 1] - this.raw[i]) * frac;
      this.frame[this.frameLen++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.frameLen === this.frameSize) {
        const out = this.frame;
        this.port.postMessage(out, [out.buffer]);
        this.frame = new Int16Array(this.frameSize);
        this.frameLen = 0;
      }
      this.readPos += this.step;
    }

    // Drop consumed input, keeping the sample the cursor sits in for interpolation.
    // The cursor's final increment can overshoot rawLen (it then points into samples
    // that haven't arrived yet), so clamp — otherwise rawLen goes negative.
    const keepFrom = Math.min(Math.floor(this.readPos), this.rawLen);
    if (keepFrom > 0) {
      this.raw.copyWithin(0, keepFrom, this.rawLen);
      this.rawLen -= keepFrom;
      this.readPos -= keepFrom;
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
