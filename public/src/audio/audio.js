// Procedural sound effects via WebAudio. Synthesised rather than streamed so the
// game keeps working with no network and no asset licensing to worry about.

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.35;
    this._last = new Map();
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  /** Rate-limits repeated sounds so a battle does not turn into white noise. */
  _throttle(name, ms) {
    const now = performance.now();
    const t = this._last.get(name) || 0;
    if (now - t < ms) return false;
    this._last.set(name, now);
    return true;
  }

  _tone({ freq = 440, type = 'square', dur = 0.12, gain = 0.3, sweep = 0, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + sweep), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  _noise({ dur = 0.2, gain = 0.25, filter = 1200, delay = 0 }) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = filter;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t0);
  }

  click() { this._tone({ freq: 620, type: 'square', dur: 0.05, gain: 0.12 }); }
  select() { this._tone({ freq: 880, type: 'triangle', dur: 0.07, gain: 0.14, sweep: 180 }); }
  command() { this._tone({ freq: 520, type: 'triangle', dur: 0.09, gain: 0.14, sweep: 240 }); }

  bowShot() {
    if (!this._throttle('bow', 70)) return;
    this._noise({ dur: 0.08, gain: 0.10, filter: 2800 });
  }
  gunShot() {
    if (!this._throttle('gun', 90)) return;
    this._noise({ dur: 0.22, gain: 0.30, filter: 900 });
    this._tone({ freq: 120, type: 'square', dur: 0.10, gain: 0.20, sweep: -70 });
  }
  meleeHit() {
    if (!this._throttle('melee', 80)) return;
    this._noise({ dur: 0.07, gain: 0.16, filter: 1800 });
    this._tone({ freq: 220, type: 'square', dur: 0.05, gain: 0.10, sweep: -90 });
  }
  explosion() {
    if (!this._throttle('boom', 120)) return;
    this._noise({ dur: 0.5, gain: 0.35, filter: 620 });
    this._tone({ freq: 90, type: 'sawtooth', dur: 0.34, gain: 0.22, sweep: -60 });
  }
  death() {
    if (!this._throttle('death', 150)) return;
    this._tone({ freq: 300, type: 'square', dur: 0.18, gain: 0.10, sweep: -190 });
  }
  build() {
    if (!this._throttle('build', 200)) return;
    this._noise({ dur: 0.10, gain: 0.12, filter: 2200 });
  }
  complete() {
    this._tone({ freq: 523, type: 'triangle', dur: 0.14, gain: 0.16 });
    this._tone({ freq: 784, type: 'triangle', dur: 0.18, gain: 0.14, delay: 0.10 });
  }
  research() {
    this._tone({ freq: 392, type: 'triangle', dur: 0.13, gain: 0.14 });
    this._tone({ freq: 587, type: 'triangle', dur: 0.13, gain: 0.13, delay: 0.10 });
    this._tone({ freq: 784, type: 'triangle', dur: 0.22, gain: 0.13, delay: 0.20 });
  }
  age() {
    const notes = [392, 523, 659, 784];
    notes.forEach((f, i) => this._tone({ freq: f, type: 'triangle', dur: 0.30, gain: 0.16, delay: i * 0.16 }));
  }
  error() { this._tone({ freq: 160, type: 'square', dur: 0.14, gain: 0.14, sweep: -50 }); }
  victory() {
    [523, 659, 784, 1047].forEach((f, i) =>
      this._tone({ freq: f, type: 'triangle', dur: 0.45, gain: 0.20, delay: i * 0.22 }));
  }
  defeat() {
    [440, 392, 330, 262].forEach((f, i) =>
      this._tone({ freq: f, type: 'sawtooth', dur: 0.5, gain: 0.16, delay: i * 0.26 }));
  }

  /** Drives sound from the simulation's per-tick effect list. */
  playEffects(effects, seen) {
    for (const fx of effects) {
      if (fx._played) continue;
      fx._played = true;
      switch (fx.type) {
        case 'shoot': this.bowShot(); break;
        case 'melee': this.meleeHit(); break;
        case 'explosion': this.explosion(); break;
        case 'death': this.death(); break;
        case 'built': this.complete(); break;
        default: break;
      }
    }
    void seen;
  }
}
