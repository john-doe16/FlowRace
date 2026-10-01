/**
 * Small synthesized sound effects: no audio files to load, nothing to lag.
 * Browsers only allow audio after a user gesture, so call unlock() from one.
 */
export class Sound {
  muted: boolean;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  constructor(muted: boolean) {
    this.muted = muted;
  }

  unlock(): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  /** A pipe connected. Pitch climbs with each flow done on this board. */
  connect(flowsDone: number): void {
    const f = 520 * 2 ** (Math.min(flowsDone, 14) / 12);
    this.tone(f, 0, 0.09, 'triangle', 0.22);
    this.tone(f * 1.5, 0.03, 0.08, 'sine', 0.08);
  }

  /** Board solved: quick rising arpeggio. */
  solve(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.045, 0.14, 'triangle', 0.2));
  }

  skip(): void {
    this.tone(220, 0, 0.18, 'sawtooth', 0.08, 110);
  }

  countdown(go: boolean): void {
    if (go) this.tone(880, 0, 0.3, 'square', 0.1);
    else this.tone(440, 0, 0.12, 'square', 0.08);
  }

  /** Last-seconds clock tick. */
  tick(): void {
    this.tone(1400, 0, 0.03, 'sine', 0.06);
  }

  /** An opponent scored. Soft, so it informs without distracting. */
  rival(): void {
    this.tone(330, 0, 0.07, 'sine', 0.07, 300);
  }

  win(): void {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, i * 0.09, 0.3, 'triangle', 0.18));
  }

  lose(): void {
    [392, 330, 262].forEach((f, i) => this.tone(f, i * 0.14, 0.32, 'triangle', 0.15));
  }

  private tone(freq: number, delay: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
    if (this.muted || !this.ctx || !this.master || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    // Fast attack, exponential release: clicks-free and snappy.
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}
