import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWavBytes, serializePresetFile, type Preset } from '@web-audio-tools/audio-core';
import { formatTime, parseArgs, resolvePreset, runCli, sanitizeFileName } from './cli';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('applies defaults', () => {
    const options = parseArgs(['rehearsal.wav']);
    expect(options).not.toBeNull();
    expect(options!.thresholdDb).toBe(-45);
    expect(options!.mp3Bitrate).toBe(192);
    expect(options!.language).toBe('auto');
    expect(options!.transcribe).toBe(true);
    expect(options!.trackStartIndex).toBe(1);
    expect(options!.geminiKey).toBe('');
    expect(options!.inputs).toHaveLength(1);
    expect(options!.inputs[0].endsWith('rehearsal.wav')).toBe(true);
    expect(options!.match).toBe('');
  });

  it('collects multiple positional inputs in order and parses --match', () => {
    const options = parseArgs(['a.wav', 'dir', 'b.wav', '--match', '*_TrMic.WAV']);
    expect(options!.inputs).toHaveLength(3);
    expect(options!.inputs[0].endsWith('a.wav')).toBe(true);
    expect(options!.inputs[1].endsWith('dir')).toBe(true);
    expect(options!.inputs[2].endsWith('b.wav')).toBe(true);
    expect(options!.match).toBe('*_TrMic.WAV');
  });

  it('parses flags', () => {
    const options = parseArgs([
      'in.wav', '--out', '/tmp/out', '--threshold', '-50', '--min-silence', '1.5',
      '--min-song', '5', '--bitrate', '320', '--pre-roll', '0.5', '--post-roll', '1',
      '--lang', 'de', '--start-index', '5', '--no-transcribe', '--gemini-key', 'abc', '--preset', 'Rock Band'
    ]);
    expect(options!.thresholdDb).toBe(-50);
    expect(options!.minSilenceDuration).toBe(1.5);
    expect(options!.minSongDuration).toBe(5);
    expect(options!.mp3Bitrate).toBe(320);
    expect(options!.preRollSec).toBe(0.5);
    expect(options!.postRollSec).toBe(1);
    expect(options!.language).toBe('de');
    expect(options!.trackStartIndex).toBe(5);
    expect(options!.transcribe).toBe(false);
    expect(options!.geminiKey).toBe('abc');
    expect(options!.preset).toBe('Rock Band');
  });

  it('reads the API key from the environment', () => {
    expect(parseArgs(['in.wav'], { GEMINI_API_KEY: 'env-key' })!.geminiKey).toBe('env-key');
  });

  it('ignores unknown language codes', () => {
    expect(parseArgs(['in.wav', '--lang', 'klingon'])!.language).toBe('auto');
  });

  it('returns null for help and for missing input', () => {
    expect(parseArgs(['--help'])).toBeNull();
    expect(parseArgs([])).toBeNull();
  });
});

describe('sanitizeFileName', () => {
  it('strips filesystem-reserved characters', () => {
    expect(sanitizeFileName('A/B\\C:D*E?F"G<H>I|J', 'fb')).toBe('ABCDEFGHIJ');
  });

  it('falls back when empty', () => {
    expect(sanitizeFileName('   ', 'Track 1')).toBe('Track 1');
    expect(sanitizeFileName('???', 'Track 2')).toBe('Track 2');
  });
});

describe('formatTime', () => {
  it('formats mm:ss', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(65)).toBe('01:05');
    expect(formatTime(125.9)).toBe('02:05');
  });
});

describe('runCli integration', () => {
  it('slices a WAV to MP3 files and a manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cli-test-'));
    try {
      const sr = 44100;
      const tone = (sec: number, amp: number) => {
        const n = Math.round(sec * sr);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = amp * Math.sin(2 * Math.PI * 440 * i / sr);
        }
        return out;
      };
      const silence = (sec: number) => new Float32Array(Math.round(sec * sr));
      const parts = [silence(2), tone(10, 0.5), silence(3), tone(10, 0.5), silence(2)];
      const total = parts.reduce((s, p) => s + p.length, 0);
      const signal = new Float32Array(total);
      let offset = 0;
      for (const p of parts) {
        signal.set(p, offset);
        offset += p.length;
      }
      const wavPath = join(dir, 'rehearsal.wav');
      await writeFile(wavPath, createWavBytes([signal, signal], sr));

      const outDir = join(dir, 'tracks');
      await runCli([wavPath, '--out', outDir, '--no-transcribe'], {});

      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
      expect(manifest.tracks).toHaveLength(2);
      expect(manifest.source).toBe('rehearsal.wav');
      expect(manifest.chunks).toHaveLength(1);
      expect(manifest.chunks[0].file).toBe('rehearsal.wav');
      expect(manifest.chunks[0].startTimeSeconds).toBe(0);
      for (const track of manifest.tracks) {
        const mp3 = await readFile(join(outDir, track.file));
        expect(mp3.length).toBeGreaterThan(0);
        expect(mp3[0]).toBe(0xff);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('joins chunks into one timeline: a piece spanning the split stays one track', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cli-test-'));
    try {
      const sr = 44100;
      const tone = (sec: number, amp: number) => {
        const n = Math.round(sec * sr);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = amp * Math.sin(2 * Math.PI * 440 * i / sr);
        }
        return out;
      };
      const silence = (sec: number) => new Float32Array(Math.round(sec * sr));
      // The split lands inside the first piece (2s silence + 10s tone, cut at 6s).
      const first = concatParts([silence(2), tone(4, 0.5)]);
      const second = concatParts([tone(6, 0.5), silence(3), tone(10, 0.5), silence(2)]);
      await writeFile(join(dir, 'part1.wav'), createWavBytes([first, first], sr));
      await writeFile(join(dir, 'part2.wav'), createWavBytes([second, second], sr));

      const outDir = join(dir, 'tracks');
      await runCli([join(dir, 'part1.wav'), join(dir, 'part2.wav'), '--out', outDir, '--no-transcribe'], {});

      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
      expect(manifest.tracks).toHaveLength(2);
      expect(manifest.chunks).toHaveLength(2);
      expect(manifest.chunks[0].file).toBe('part1.wav');
      expect(manifest.chunks[1].file).toBe('part2.wav');
      expect(manifest.chunks[1].startTimeSeconds).toBeCloseTo(first.length / sr, 3);
      // The piece that spans the boundary starts in chunk 1 and ends in chunk 2.
      expect(manifest.tracks[0].startTimeSeconds).toBeLessThan(manifest.chunks[1].startTimeSeconds);
      expect(manifest.tracks[0].endTimeSeconds).toBeGreaterThan(manifest.chunks[1].startTimeSeconds);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails before slicing when chunk formats differ', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cli-test-'));
    try {
      const sr = 44100;
      const signal = new Float32Array(sr); // 1s of silence
      await writeFile(join(dir, 'a.wav'), createWavBytes([signal, signal], sr));
      await writeFile(join(dir, 'b.wav'), createWavBytes([signal, signal], 48000));
      const outDir = join(dir, 'tracks');
      await expect(runCli([join(dir, 'a.wav'), join(dir, 'b.wav'), '--out', outDir, '--no-transcribe'], {}))
        .rejects.toThrow(/does not match/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolvePreset', () => {
  it('returns null for dry (empty)', async () => {
    expect(await resolvePreset('')).toBeNull();
    expect(await resolvePreset('   ')).toBeNull();
  });

  it('resolves a Factory Preset by name (case-insensitive)', async () => {
    const preset = await resolvePreset('horn ensemble');
    expect(preset?.name).toBe('Horn Ensemble');
  });

  it('throws on an unknown name', async () => {
    await expect(resolvePreset('Polka')).rejects.toThrow(/Unknown Preset/);
  });

  it('reads a versioned Preset JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preset-test-'));
    try {
      const preset: Preset = { name: 'Custom', config: (await resolvePreset('Rock Band'))!.config };
      const path = join(dir, 'custom.json');
      await writeFile(path, serializePresetFile(preset));
      const resolved = await resolvePreset(path);
      expect(resolved?.name).toBe('Custom');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runCli with a Preset', () => {
  it('records the preset snapshot and processed duration in the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cli-preset-'));
    try {
      const sr = 44100;
      const tone = (sec: number, amp: number) => {
        const n = Math.round(sec * sr);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          out[i] = amp * Math.sin(2 * Math.PI * 440 * i / sr);
        }
        return out;
      };
      const silence = (sec: number) => new Float32Array(Math.round(sec * sr));
      const signal = concatParts([silence(2), tone(10, 0.5), silence(3), tone(10, 0.5), silence(2)]);
      const wavPath = join(dir, 'rehearsal.wav');
      await writeFile(wavPath, createWavBytes([signal, signal], sr));

      const outDir = join(dir, 'tracks');
      await runCli([wavPath, '--out', outDir, '--no-transcribe', '--preset', 'Horn Ensemble'], {});

      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
      expect(manifest.preset.name).toBe('Horn Ensemble');
      expect(manifest.preset.config.reverb.enabled).toBe(true);
      expect(manifest.tracks).toHaveLength(2);
      for (const track of manifest.tracks) {
        expect(track.processedDurationSeconds).toBeGreaterThan(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('defaults to dry (preset null) when no --preset is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-cli-dry-'));
    try {
      const sr = 44100;
      const signal = new Float32Array(sr * 12);
      for (let i = 0; i < signal.length; i++) {
        signal[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
      }
      const wavPath = join(dir, 'tone.wav');
      await writeFile(wavPath, createWavBytes([signal, signal], sr));
      const outDir = join(dir, 'tracks');
      await runCli([wavPath, '--out', outDir, '--no-transcribe'], {});
      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
      expect(manifest.preset).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function concatParts(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}