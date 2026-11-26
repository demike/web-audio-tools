import { describe, expect, it } from 'vitest';
import {
  Compressor,
  DRY_EFFECT_CONFIG,
  Equalizer,
  NoiseProfiler,
  NoiseReducer,
  Normalizer,
  Reverb,
  cloneEffectConfig,
  createEffectChain,
  fft,
  isDryConfig
} from './effects';
import { SAMPLE_RATE, concat, peak, silence, tone } from './test-helpers';

function whiteNoise(seconds: number, amp: number, seed = 1): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amp * ((s / 0x7fffffff) * 2 - 1);
  }
  return out;
}

function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
  }
  return Math.sqrt(sum / x.length);
}

describe('fft', () => {
  it('transforms a sine to a peak at the expected bin', () => {
    const n = 1024;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const bin = 10;
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(2 * Math.PI * bin * i / n);
    }
    fft(re, im);
    let maxBin = 0;
    let maxMag = 0;
    for (let k = 0; k < n / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      if (mag > maxMag) {
        maxMag = mag;
        maxBin = k;
      }
    }
    expect(maxBin).toBe(bin);
  });

  it('round-trips through inverse', () => {
    const n = 256;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.1) + 0.3 * Math.cos(i * 0.7);
    }
    const original = Array.from(re);
    fft(re, im);
    fft(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(original[i], 4);
    }
  });
});

describe('NoiseReducer', () => {
  it('passes audio through unchanged with a zero profile (no latency)', () => {
    const input = tone(1.0, 0.5, 440);
    const reference = new Float32Array(input);
    const nr = new NoiseReducer(new Float32Array(513), 0.3, SAMPLE_RATE);
    const out = nr.process([input])[0];
    expect(out.length).toBe(reference.length);
    let err = 0;
    for (let i = 2000; i < reference.length; i += 7) {
      err += Math.abs(out[i] - reference[i]);
    }
    expect(err / reference.length).toBeLessThan(0.001);
  });

  it('attenuates noise that matches the estimated profile', () => {
    const noise = whiteNoise(1.5, 0.05, 7);
    const inputRms = rms(noise);
    const profiler = new NoiseProfiler();
    profiler.feed(noise);
    const profile = profiler.profile();
    const nr = new NoiseReducer(profile, 0.8, SAMPLE_RATE);
    const out = nr.process([noise])[0];
    const tail = out.subarray(Math.round(0.5 * SAMPLE_RATE));
    expect(rms(tail)).toBeLessThan(inputRms * 0.8);
  });

  it('preserves sustained tonal music (no noise-only gaps) instead of subtracting it', () => {
    // A steady horn-like chord plus low hiss. Music above the noise floor must
    // pass through untouched (the old spectral subtractor gutted it to ~27%).
    const n = Math.round(2.5 * SAMPLE_RATE);
    const input = new Float32Array(n);
    const freqs = [220, 277.18, 329.63, 440];
    let s = 999;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const f of freqs) {
        v += 0.15 * Math.sin(2 * Math.PI * f * i / SAMPLE_RATE);
      }
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      input[i] = v + 0.01 * ((s / 0x7fffffff) * 2 - 1);
    }
    const profiler = new NoiseProfiler();
    profiler.feed(input);
    const a = Math.round(1.0 * SAMPLE_RATE);
    const b = Math.round(2.0 * SAMPLE_RATE);
    const inRms = rms(input.subarray(a, b));
    const nr = new NoiseReducer(profiler.profile(), 0.3, SAMPLE_RATE);
    const out = nr.process([input])[0];
    const outRms = rms(out.subarray(a, b));
    expect(outRms).toBeGreaterThan(inRms * 0.9);
  });
});

describe('Equalizer', () => {
  it('boosts low frequencies with a positive low shelf', () => {
    const low = tone(0.5, 0.4, 80);
    const reference = new Float32Array(low);
    const eq = new Equalizer({ enabled: true, lowGainDb: 8, midGainDb: 0, midFrequencyHz: 1000, highGainDb: 0 }, SAMPLE_RATE, 1);
    const out = eq.process([low])[0];
    const steadyIn = rms(reference.subarray(Math.round(0.2 * SAMPLE_RATE)));
    const steadyOut = rms(out.subarray(Math.round(0.2 * SAMPLE_RATE)));
    expect(steadyOut).toBeGreaterThan(steadyIn * 1.8);
  });
});

describe('Compressor', () => {
  it('reduces peaks above the threshold', () => {
    const input = tone(0.5, 0.9, 440);
    const comp = new Compressor({ enabled: true, thresholdDb: -20, ratio: 8, attackMs: 1, releaseMs: 50, makeupDb: 0 }, SAMPLE_RATE);
    const out = comp.process([input])[0];
    const steady = out.subarray(Math.round(0.2 * SAMPLE_RATE));
    expect(peak(steady)).toBeLessThan(0.5);
  });
});

describe('Reverb', () => {
  it('produces a decaying tail after an impulse', () => {
    const input = new Float32Array(SAMPLE_RATE);
    input[0] = 1;
    const reverb = new Reverb({ enabled: true, roomSize: 0.7, damping: 0.3, wet: 0.5, dry: 0 }, SAMPLE_RATE, 1);
    const out = reverb.process([input])[0];
    const early = rms(out.subarray(Math.round(0.05 * SAMPLE_RATE), Math.round(0.15 * SAMPLE_RATE)));
    const late = rms(out.subarray(Math.round(0.5 * SAMPLE_RATE), Math.round(0.7 * SAMPLE_RATE)));
    expect(early).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThan(0);
  });
});

describe('Normalizer', () => {
  it('raises peak to the target', () => {
    const input = tone(0.2, 0.1, 440);
    const norm = new Normalizer(0.1, -1);
    const out = norm.process([input])[0];
    expect(peak(out)).toBeCloseTo(Math.pow(10, -1 / 20), 2);
  });

  it('leaves digital silence alone', () => {
    const input = silence(0.1);
    const norm = new Normalizer(0, -1);
    const out = norm.process([input])[0];
    expect(peak(out)).toBe(0);
  });
});

describe('createEffectChain', () => {
  it('dry config is a passthrough with no tail', () => {
    expect(isDryConfig(DRY_EFFECT_CONFIG)).toBe(true);
    const chain = createEffectChain(DRY_EFFECT_CONFIG, SAMPLE_RATE, 1, { peak: 0.5, noiseProfile: null });
    const input = tone(0.1, 0.5);
    const out = chain.process([input])[0];
    expect(Array.from(out)).toEqual(Array.from(input));
    expect(Array.from(chain.flush(44100, -60))).toHaveLength(0);
  });

  it('reverb chain emits a ring-out tail on flush', () => {
    const config = cloneEffectConfig(DRY_EFFECT_CONFIG);
    config.reverb = { enabled: true, roomSize: 0.8, damping: 0.2, wet: 0.6, dry: 0.5 };
    const chain = createEffectChain(config, SAMPLE_RATE, 1, { peak: 0.5, noiseProfile: null });
    chain.process([tone(0.2, 0.5)]);
    const tailBlocks = Array.from(chain.flush(SAMPLE_RATE * 4, -60));
    const tailSamples = tailBlocks.reduce((sum, b) => sum + b[0].length, 0);
    expect(tailSamples).toBeGreaterThan(0);
    const last = tailBlocks[tailBlocks.length - 1][0];
    expect(rms(last)).toBeLessThan(0.001);
  });
});