/**
 * Pure-JS effect DSP shared by audition and Export (browser + Node/Bun).
 * One implementation, one signal flow: noise reduction → EQ → compressor →
 * reverb → normalize/peak-limit. Nothing here references Angular, DOM, Worker,
 * or Node APIs. Effects are streaming block processors so a multi-GB Recording
 * is never loaded — only window-sized buffers and per-effect state.
 */

export type EffectKind = 'noiseReduction' | 'eq' | 'compressor' | 'reverb' | 'normalize';

export interface NoiseReductionParams {
  enabled: boolean;
  /** 0..1 — maps to over-subtraction and spectral floor. */
  strength: number;
}

export interface EqParams {
  enabled: boolean;
  lowGainDb: number;
  midGainDb: number;
  midFrequencyHz: number;
  highGainDb: number;
}

export interface CompressorParams {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface ReverbParams {
  enabled: boolean;
  /** 0..1 — maps to comb feedback (room size). */
  roomSize: number;
  /** 0..1 — high-frequency damping in the feedback path. */
  damping: number;
  wet: number;
  dry: number;
}

export interface NormalizeParams {
  enabled: boolean;
  targetPeakDb: number;
}

export interface EffectChainConfig {
  noiseReduction: NoiseReductionParams;
  eq: EqParams;
  compressor: CompressorParams;
  reverb: ReverbParams;
  normalize: NormalizeParams;
}

/** A dry chain: every effect disabled. Selecting no Preset is this. */
export const DRY_EFFECT_CONFIG: EffectChainConfig = {
  noiseReduction: { enabled: false, strength: 0.3 },
  eq: { enabled: false, lowGainDb: 0, midGainDb: 0, midFrequencyHz: 1000, highGainDb: 0 },
  compressor: { enabled: false, thresholdDb: -18, ratio: 2, attackMs: 10, releaseMs: 150, makeupDb: 0 },
  reverb: { enabled: false, roomSize: 0.5, damping: 0.5, wet: 0.2, dry: 0.9 },
  normalize: { enabled: false, targetPeakDb: -1 }
};

export function cloneEffectConfig(config: EffectChainConfig): EffectChainConfig {
  return {
    noiseReduction: { ...config.noiseReduction },
    eq: { ...config.eq },
    compressor: { ...config.compressor },
    reverb: { ...config.reverb },
    normalize: { ...config.normalize }
  };
}

export function isDryConfig(config: EffectChainConfig): boolean {
  return !config.noiseReduction.enabled && !config.eq.enabled && !config.compressor.enabled
    && !config.reverb.enabled && !config.normalize.enabled;
}

// --- FFT (iterative radix-2, in-place) ---

export function fft(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const vr = re[b] * curR - im[b] * curI;
        const vi = re[b] * curI + im[b] * curR;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
  }
  return w;
}

const FRAME_SIZE = 1024;
const HOP_SIZE = 256;
const BINS = FRAME_SIZE / 2 + 1;

// --- Noise reduction (smooth broadband downward expander) ---

/**
 * Artifact-free noise reduction for music. Spectral subtraction modulates
 * per-bin gains frame-to-frame ("musical noise" / warbling), which is audible
 * even when overall level is preserved. Instead this is a gentle broadband
 * downward expander: a smooth, soft-knee gain keyed on the overall level vs an
 * estimated noise floor. Quiet passages (hiss/room tone) are pulled down;
 * sustained music above the floor passes untouched. No per-bin modulation, so
 * no musical noise. Channel-linked to avoid stereo image shift.
 */
export class NoiseReducer {
  private envelope = 0;
  private gain = 1;
  private readonly thresholdDb: number;
  private readonly invRatio: number;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;
  private readonly gainCoeff: number;
  private readonly maxReductionDb: number;
  private readonly knee = 3;

  constructor(profile: Float32Array, strength: number, sampleRate: number) {
    const s = Math.max(0, Math.min(1, strength));
    let floor = 0;
    for (let k = 0; k < profile.length; k++) {
      floor += profile[k];
    }
    floor /= Math.max(1, profile.length);
    const floorDb = 20 * Math.log10(Math.max(floor, 1e-6));
    this.thresholdDb = floorDb + 6 + s * 8;
    this.invRatio = 1 - 1 / (1 + s * 3);
    this.maxReductionDb = 6 + s * 20;
    this.attackCoeff = 1 - Math.exp(-1 / (0.002 * sampleRate));
    this.releaseCoeff = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.gainCoeff = 1 - Math.exp(-1 / (0.005 * sampleRate));
  }

  /** Processes a multi-channel block in place; returns it. Unity above the floor. */
  public process(channels: Float32Array[]): Float32Array[] {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      let detector = 0;
      for (const ch of channels) {
        const a = Math.abs(ch[i]);
        if (a > detector) {
          detector = a;
        }
      }
      const coeff = detector > this.envelope ? this.attackCoeff : this.releaseCoeff;
      this.envelope += coeff * (detector - this.envelope);
      const levelDb = 20 * Math.log10(Math.max(this.envelope, 1e-7));
      const x = levelDb - this.thresholdDb;
      // Smoothed negative part (soft knee): ≈ min(x, 0) without a hard corner.
      const neg = (x - Math.sqrt(x * x + this.knee * this.knee)) / 2;
      let gainDb = this.invRatio * neg;
      if (gainDb < -this.maxReductionDb) {
        gainDb = -this.maxReductionDb;
      }
      const target = Math.pow(10, gainDb / 20);
      this.gain += this.gainCoeff * (target - this.gain);
      for (const ch of channels) {
        ch[i] *= this.gain;
      }
    }
    return channels;
  }
}

/** Estimates a per-bin noise profile (minimum statistics) and peak from a region. */
export class NoiseProfiler {
  private readonly window = hannWindow(FRAME_SIZE);
  private readonly re = new Float32Array(FRAME_SIZE);
  private readonly im = new Float32Array(FRAME_SIZE);
  private readonly ring = new Float32Array(FRAME_SIZE);
  private write = 0;
  private filled = 0;
  private sinceFrame = 0;
  private readonly minMag = new Float32Array(BINS).fill(Infinity);
  public peak = 0;

  public feed(block: Float32Array): void {
    for (let i = 0; i < block.length; i++) {
      const x = block[i];
      const a = Math.abs(x);
      if (a > this.peak) {
        this.peak = a;
      }
      this.ring[this.write] = x;
      this.write = (this.write + 1) % FRAME_SIZE;
      if (this.filled < FRAME_SIZE) {
        this.filled++;
      }
      this.sinceFrame++;
      if (this.filled === FRAME_SIZE && this.sinceFrame >= HOP_SIZE) {
        this.sinceFrame = 0;
        this.analyzeFrame();
      }
    }
  }

  private analyzeFrame(): void {
    for (let i = 0; i < FRAME_SIZE; i++) {
      this.re[i] = this.ring[(this.write + i) % FRAME_SIZE] * this.window[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    for (let k = 0; k < BINS; k++) {
      const mag = Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]);
      if (mag < this.minMag[k]) {
        this.minMag[k] = mag;
      }
    }
  }

  /**
   * Broadband noise floor estimate. A per-bin minimum across time alone would
   * track sustained tonal music (no noise-only gaps) and subtract the music
   * itself. Instead we take a low percentile ACROSS bins of those minima: most
   * bins lie between harmonics and are noise-only, so this captures the true
   * hiss/room-tone floor while strong tonal bins stay far above it. The profile
   * is flat (broadband noise), which preserves tonal content under subtraction.
   */
  public profile(): Float32Array {
    const minima: number[] = [];
    for (let k = 0; k < BINS; k++) {
      minima.push(Number.isFinite(this.minMag[k]) ? this.minMag[k] : 0);
    }
    minima.sort((a, b) => a - b);
    const idx = Math.min(minima.length - 1, Math.floor(minima.length * 0.3));
    const floor = minima[idx] * 2;
    const out = new Float32Array(BINS);
    out.fill(floor);
    return out;
  }
}

// --- EQ (three RBJ biquads: low shelf, peaking mid, high shelf) ---

interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number; }
interface BiquadState { x1: number; x2: number; y1: number; y2: number; }

function lowShelf(freq: number, gainDb: number, rate: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * freq / rate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / 2 * Math.sqrt(2);
  const b0 = A * ((A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
  const b1 = 2 * A * ((A - 1) - (A + 1) * cw);
  const b2 = A * ((A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
  const a0 = (A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
  const a1 = -2 * ((A - 1) + (A + 1) * cw);
  const a2 = (A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function highShelf(freq: number, gainDb: number, rate: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * freq / rate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / 2 * Math.sqrt(2);
  const b0 = A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cw);
  const b2 = A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
  const a0 = (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cw);
  const a2 = (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function peaking(freq: number, gainDb: number, q: number, rate: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * freq / rate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cw;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cw;
  const a2 = 1 - alpha / A;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export class Equalizer {
  private readonly coeffs: BiquadCoeffs[];
  private readonly states: BiquadState[][];

  constructor(params: EqParams, sampleRate: number, channels: number) {
    const nyquist = sampleRate / 2;
    const low = Math.min(200, nyquist * 0.4);
    const mid = Math.max(40, Math.min(params.midFrequencyHz, nyquist * 0.9));
    const high = Math.min(4500, nyquist * 0.9);
    this.coeffs = [
      lowShelf(low, params.lowGainDb, sampleRate),
      peaking(mid, params.midGainDb, 1.0, sampleRate),
      highShelf(high, params.highGainDb, sampleRate)
    ];
    this.states = Array.from({ length: channels }, () =>
      this.coeffs.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 })));
  }

  public process(channels: Float32Array[]): Float32Array[] {
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      const states = this.states[c];
      for (let i = 0; i < data.length; i++) {
        let x = data[i];
        for (let f = 0; f < this.coeffs.length; f++) {
          const co = this.coeffs[f];
          const st = states[f];
          const y = co.b0 * x + co.b1 * st.x1 + co.b2 * st.x2 - co.a1 * st.y1 - co.a2 * st.y2;
          st.x2 = st.x1;
          st.x1 = x;
          st.y2 = st.y1;
          st.y1 = y;
          x = y;
        }
        data[i] = x;
      }
    }
    return channels;
  }
}

// --- Compressor (feed-forward, channel-linked, smoothed envelope) ---

export class Compressor {
  private envelope = 0;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;
  private readonly threshold: number;
  private readonly ratio: number;
  private readonly makeup: number;

  constructor(params: CompressorParams, sampleRate: number) {
    this.attackCoeff = 1 - Math.exp(-1 / (Math.max(0.1, params.attackMs) * 0.001 * sampleRate));
    this.releaseCoeff = 1 - Math.exp(-1 / (Math.max(1, params.releaseMs) * 0.001 * sampleRate));
    this.threshold = Math.pow(10, params.thresholdDb / 20);
    this.ratio = Math.max(1, params.ratio);
    this.makeup = Math.pow(10, params.makeupDb / 20);
  }

  public process(channels: Float32Array[]): Float32Array[] {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      let detector = 0;
      for (const ch of channels) {
        const a = Math.abs(ch[i]);
        if (a > detector) {
          detector = a;
        }
      }
      const coeff = detector > this.envelope ? this.attackCoeff : this.releaseCoeff;
      this.envelope += coeff * (detector - this.envelope);
      let gain = 1;
      if (this.envelope > this.threshold && this.threshold > 0) {
        const overDb = 20 * Math.log10(this.envelope / this.threshold);
        const reductionDb = overDb * (1 - 1 / this.ratio);
        gain = Math.pow(10, -reductionDb / 20);
      }
      gain *= this.makeup;
      for (const ch of channels) {
        ch[i] *= gain;
      }
    }
    return channels;
  }
}

// --- Reverb (Freeverb-style: parallel damped combs + series allpasses) ---

const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNINGS = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

class Comb {
  private readonly buffer: Float32Array;
  private index = 0;
  private filterStore = 0;
  constructor(size: number, private readonly feedback: number, private readonly damp: number) {
    this.buffer = new Float32Array(Math.max(1, size));
  }
  public process(input: number): number {
    const output = this.buffer[this.index];
    this.filterStore = output * (1 - this.damp) + this.filterStore * this.damp;
    this.buffer[this.index] = input + this.filterStore * this.feedback;
    this.index = (this.index + 1) % this.buffer.length;
    return output;
  }
}

class Allpass {
  private readonly buffer: Float32Array;
  private index = 0;
  constructor(size: number, private readonly feedback: number) {
    this.buffer = new Float32Array(Math.max(1, size));
  }
  public process(input: number): number {
    const buffered = this.buffer[this.index];
    const output = -input + buffered;
    this.buffer[this.index] = input + buffered * this.feedback;
    this.index = (this.index + 1) % this.buffer.length;
    return output;
  }
}

export class Reverb {
  private readonly combs: Comb[][];
  private readonly allpasses: Allpass[][];
  private readonly wet: number;
  private readonly dry: number;

  constructor(params: ReverbParams, sampleRate: number, channels: number) {
    const scale = sampleRate / 44100;
    const feedback = 0.7 + Math.max(0, Math.min(1, params.roomSize)) * 0.28;
    const damp = Math.max(0, Math.min(1, params.damping)) * 0.4;
    this.wet = params.wet;
    this.dry = params.dry;
    this.combs = [];
    this.allpasses = [];
    for (let c = 0; c < channels; c++) {
      const spread = c * STEREO_SPREAD;
      this.combs.push(COMB_TUNINGS.map(t => new Comb(Math.round((t + spread) * scale), feedback, damp)));
      this.allpasses.push(ALLPASS_TUNINGS.map(t => new Allpass(Math.round((t + spread) * scale), 0.5)));
    }
  }

  public process(channels: Float32Array[]): Float32Array[] {
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c];
      const combs = this.combs[c];
      const allpasses = this.allpasses[c];
      for (let i = 0; i < data.length; i++) {
        const input = data[i] * 0.015;
        let acc = 0;
        for (const comb of combs) {
          acc += comb.process(input);
        }
        for (const ap of allpasses) {
          acc = ap.process(acc);
        }
        data[i] = data[i] * this.dry + acc * this.wet;
      }
    }
    return channels;
  }
}

// --- Normalize (gain to target peak from analysis, then peak clamp) ---

export class Normalizer {
  private readonly gain: number;
  constructor(peak: number, targetPeakDb: number) {
    const target = Math.pow(10, targetPeakDb / 20);
    if (peak <= 1e-6) {
      this.gain = 1;
    } else {
      this.gain = Math.min(target / peak, Math.pow(10, 24 / 20));
    }
  }
  public process(channels: Float32Array[]): Float32Array[] {
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        ch[i] = Math.max(-1, Math.min(1, ch[i] * this.gain));
      }
    }
    return channels;
  }
}

// --- The fixed-order chain ---

export interface ChainAnalysis {
  peak: number;
  noiseProfile: Float32Array | null;
}

export interface EffectChain {
  /** Processes one block (mutates and returns it). Output length == input length. */
  process(block: Float32Array[]): Float32Array[];
  /**
   * Drains internal latency and the reverb tail by feeding silence. Yields
   * output blocks until the tail decays below the cutoff or maxTailSamples is
   * reached. Returns the number of tail samples emitted.
   */
  flush(maxTailSamples: number, tailCutoffDb: number): Generator<Float32Array[]>;
  /** Fixed processing latency in samples (noise reduction STFT). */
  readonly latencySamples: number;
}

export function createEffectChain(
  config: EffectChainConfig,
  sampleRate: number,
  channels: number,
  analysis: ChainAnalysis
): EffectChain {
  const nr = config.noiseReduction.enabled && analysis.noiseProfile
    ? new NoiseReducer(analysis.noiseProfile, config.noiseReduction.strength, sampleRate)
    : null;
  const eq = config.eq.enabled ? new Equalizer(config.eq, sampleRate, channels) : null;
  const comp = config.compressor.enabled ? new Compressor(config.compressor, sampleRate) : null;
  const reverb = config.reverb.enabled ? new Reverb(config.reverb, sampleRate, channels) : null;
  const norm = config.normalize.enabled ? new Normalizer(analysis.peak, config.normalize.targetPeakDb) : null;
  const latencySamples = 0;

  const process = (block: Float32Array[]): Float32Array[] => {
    let out = block;
    if (nr) {
      out = nr.process(out);
    }
    if (eq) {
      out = eq.process(out);
    }
    if (comp) {
      out = comp.process(out);
    }
    if (reverb) {
      out = reverb.process(out);
    }
    if (norm) {
      out = norm.process(out);
    }
    return out;
  };

  function* flush(maxTailSamples: number, tailCutoffDb: number): Generator<Float32Array[]> {
    if (!nr && !reverb) {
      return;
    }
    const cutoff = Math.pow(10, tailCutoffDb / 20);
    const blockSize = 4096;
    let emitted = 0;
    let quietBlocks = 0;
    const minDrain = latencySamples;
    while (emitted < maxTailSamples) {
      const take = Math.min(blockSize, maxTailSamples - emitted);
      const silence = Array.from({ length: channels }, () => new Float32Array(take));
      const out = process(silence);
      emitted += take;
      let rms = 0;
      for (const ch of out) {
        for (let i = 0; i < ch.length; i++) {
          rms += ch[i] * ch[i];
        }
      }
      rms = Math.sqrt(rms / (take * channels));
      yield out;
      if (emitted >= minDrain && rms < cutoff) {
        quietBlocks++;
        if (quietBlocks >= 2) {
          return;
        }
      } else {
        quietBlocks = 0;
      }
    }
  }

  return { process, flush, latencySamples };
}

export const NR_FRAME_SIZE = FRAME_SIZE;
export const NR_BINS = BINS;