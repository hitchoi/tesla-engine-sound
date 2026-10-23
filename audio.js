// Web Audio 연결. AudioWorklet 이 있으면 쓰고, 없으면 ScriptProcessor 로 같은 합성기를 돌린다.
import { EngineDSP } from './dsp.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.mode = '';
    this.level = 0;
  }

  // 반드시 터치(사용자 동작) 안에서 부른다
  async start() {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    // 아이폰 무음 스위치가 켜져 있어도 소리가 나게(사파리 16.4+)
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const resumed = ctx.resume();
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    // 스피커 보호용 리미터
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 6;
    comp.ratio.value = 10;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    let src;
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('no worklet');
      await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
      src = new AudioWorkletNode(ctx, 'engine-sound', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      this.post = (m) => src.port.postMessage(m);
      this.mode = 'AudioWorklet';
    } catch (e) {
      const dsp = new EngineDSP(ctx.sampleRate, (Math.random() * 1e9) | 0);
      src = ctx.createScriptProcessor(1024, 1, 2);
      src.onaudioprocess = (ev) => {
        const ob = ev.outputBuffer;
        dsp.process(ob.getChannelData(0), ob.getChannelData(1), ob.length);
      };
      this.post = (m) => {
        if (m.type === 'preset') dsp.setPreset(m.preset);
        else if (m.type === 'params') dsp.setParams(m.p);
        else if (m.type === 'event') dsp.trigger(m.name);
      };
      this.mode = 'ScriptProcessor';
    }
    this.node = src;
    src.connect(this.gain);
    this.gain.connect(comp);
    comp.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    await resumed;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setPreset(p) {
    if (this.post) this.post({ type: 'preset', preset: p });
  }
  setParams(p) {
    if (this.post) this.post({ type: 'params', p });
  }
  trigger(name) {
    if (this.post) this.post({ type: 'event', name });
  }
  // 슬라이더 0~1 → 귀에 맞게 제곱
  setVolume(v) {
    if (this.gain) this.gain.gain.setTargetAtTime(v * v * 1.4, this.ctx.currentTime, 0.05);
  }
  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume();
  }
  measure() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let q = 0;
    for (const x of this.buf) q += x * x;
    this.level = Math.sqrt(q / this.buf.length);
    return this.level;
  }
}
