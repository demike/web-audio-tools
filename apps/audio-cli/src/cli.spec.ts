import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWavBytes } from '@web-audio-tools/audio-core';
import { formatTime, parseArgs, runCli, sanitizeFileName } from './cli';

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
    expect(options!.input.endsWith('rehearsal.wav')).toBe(true);
  });

  it('parses flags', () => {
    const options = parseArgs([
      'in.wav', '--out', '/tmp/out', '--threshold', '-50', '--min-silence', '1.5',
      '--min-song', '5', '--bitrate', '320', '--pre-roll', '0.5', '--post-roll', '1',
      '--lang', 'de', '--start-index', '5', '--no-transcribe', '--gemini-key', 'abc'
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
      for (const track of manifest.tracks) {
        const mp3 = await readFile(join(outDir, track.file));
        expect(mp3.length).toBeGreaterThan(0);
        expect(mp3[0]).toBe(0xff);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});