// AudioWorklet 쪽 껍데기. 실제 합성은 dsp.js 가 한다.
import { EngineDSP } from './dsp.js';

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new EngineDSP(sampleRate, (Math.random() * 1e9) | 0);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'preset') this.dsp.setPreset(m.preset);
      else if (m.type === 'params') this.dsp.setParams(m.p);
      else if (m.type === 'event') this.dsp.trigger(m.name);
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    this.dsp.process(out[0], out[1], out[0].length);
    return true;
  }
}

registerProcessor('engine-sound', EngineProcessor);
