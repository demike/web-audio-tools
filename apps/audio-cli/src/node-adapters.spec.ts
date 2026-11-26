import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWavBytes } from '@web-audio-tools/audio-core';
import { ensureDir, expandInputPaths, fileAudioInput, getFileSize, matchesGlob, scanWavFiles, writeBytes } from './node-adapters';

describe('node adapters', () => {
  it('writes bytes, reports size, and streams them back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-adapters-test-'));
    try {
      const nested = join(dir, 'a', 'b');
      await ensureDir(nested);
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const path = join(nested, 'data.bin');
      await writeBytes(path, bytes);

      expect(await getFileSize(path)).toBe(bytes.length);
      expect(new Uint8Array(await readFile(path))).toEqual(bytes);

      const collected: number[] = [];
      for await (const chunk of fileAudioInput(path)) {
        collected.push(...chunk);
      }
      expect(new Uint8Array(collected)).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('matchesGlob', () => {
  it('matches * and ? case-insensitively against the file name', () => {
    expect(matchesGlob('240101_000000_TrMic.WAV', '*_TrMic.WAV')).toBe(true);
    expect(matchesGlob('240101_000000_trmic.wav', '*_TrMic.WAV')).toBe(true);
    expect(matchesGlob('240101_000000_TrLR.WAV', '*_TrMic.WAV')).toBe(false);
    expect(matchesGlob('a.wav', '?.wav')).toBe(true);
    expect(matchesGlob('ab.wav', '?.wav')).toBe(false);
    expect(matchesGlob('anything.wav', '')).toBe(true);
  });
});

describe('expandInputPaths', () => {
  const wav = () => createWavBytes([new Float32Array(100), new Float32Array(100)], 44100);

  it('expands Zoom-style date folders, filters to the mic file, skips TRASH/Export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-expand-test-'));
    try {
      // Two continuation folders, each with a mic file and an unwanted mix,
      // plus card housekeeping folders that must never be ingested.
      for (const folder of ['240101_010000', '240101_000000']) {
        await mkdir(join(dir, folder));
        await writeFile(join(dir, folder, `${folder}_TrMic.WAV`), wav());
        await writeFile(join(dir, folder, `${folder}_TrLR.WAV`), wav());
      }
      await mkdir(join(dir, 'TRASH'));
      await writeFile(join(dir, 'TRASH', '240101_000000_TrMic.WAV'), wav());
      await mkdir(join(dir, 'Export', 'sub'), { recursive: true });
      await writeFile(join(dir, 'Export', 'sub', 'exported.wav'), wav());

      const paths = await expandInputPaths([dir], '*_TrMic.WAV');
      expect(paths.map(p => p.split('/').slice(-2).join('/'))).toEqual([
        '240101_000000/240101_000000_TrMic.WAV',
        '240101_010000/240101_010000_TrMic.WAV'
      ]);

      // Without a filter, both files per folder are collected (sorted by path).
      const all = await scanWavFiles(dir, '');
      expect(all).toHaveLength(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps explicit files unfiltered and preserves argument order when mixing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-expand-test-'));
    try {
      await mkdir(join(dir, 'folder'));
      await writeFile(join(dir, 'folder', 'b_TrMic.WAV'), wav());
      await writeFile(join(dir, 'folder', 'a_TrMic.WAV'), wav());
      await writeFile(join(dir, 'explicit_TrLR.WAV'), wav());

      const paths = await expandInputPaths(
        [join(dir, 'explicit_TrLR.WAV'), join(dir, 'folder'), join(dir, 'explicit_TrLR.WAV')],
        '*_TrMic.WAV'
      );
      expect(paths.map(p => p.split('/').pop())).toEqual([
        'explicit_TrLR.WAV',
        'a_TrMic.WAV',
        'b_TrMic.WAV',
        'explicit_TrLR.WAV'
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('errors on a directory with no matching WAVs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-expand-test-'));
    try {
      await writeFile(join(dir, 'notes.txt'), 'not audio');
      await expect(expandInputPaths([dir], '')).rejects.toThrow(/No WAV files/);
      await expect(expandInputPaths([dir], '*.wav')).rejects.toThrow(/matching "\*\.wav"/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sorts digit runs naturally (ZOOM0002 before ZOOM0010)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audio-expand-test-'));
    try {
      for (const name of ['ZOOM0010.WAV', 'ZOOM0002.WAV', 'ZOOM0001.WAV']) {
        await writeFile(join(dir, name), wav());
      }
      const paths = await expandInputPaths([dir], '');
      expect(paths.map(p => p.split('/').pop())).toEqual(['ZOOM0001.WAV', 'ZOOM0002.WAV', 'ZOOM0010.WAV']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});