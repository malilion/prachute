// Procedural audio: wind from filtered noise, plus small synth cues.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04; // brownish
      d[i] = last * 4 + w * 0.15;
    }
    this.noiseBuffer = buf;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 300;
    this.windFilter.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();

    // plane drone
    this.engine = ctx.createOscillator();
    this.engine.type = 'sawtooth';
    this.engine.frequency.value = 86;
    const ef = ctx.createBiquadFilter();
    ef.type = 'lowpass';
    ef.frequency.value = 260;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engine.connect(ef).connect(this.engineGain).connect(this.master);
    this.engine.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
  }

  update(speed, inCloud, planeDistance) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(speed / 85, 1);
    this.windGain.gain.setTargetAtTime(0.03 + s * s * 0.75, t, 0.12);
    this.windFilter.frequency.setTargetAtTime((240 + s * 1500) * (1 - 0.45 * inCloud), t, 0.12);
    const e = Math.max(0, 1 - planeDistance / 260);
    this.engineGain.gain.setTargetAtTime(e * e * 0.22, t, 0.2);
  }

  blip(freq, when = 0, dur = 0.22, type = 'sine', vol = 0.22) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  ring(combo) {
    const base = 660 * Math.pow(2, Math.min(combo - 1, 7) / 12);
    this.blip(base, 0, 0.25);
    this.blip(base * 1.5, 0.07, 0.3);
  }

  miss() {
    this.blip(180, 0, 0.25, 'triangle', 0.15);
  }

  whump() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 0.9);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(1.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 1.2);
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((fq, i) => this.blip(fq, i * 0.11, 0.4, 'triangle', 0.2));
  }
}
