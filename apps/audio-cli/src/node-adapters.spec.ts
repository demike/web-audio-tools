import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDir, fileAudioInput, getFileSize, writeBytes } from './node-adapters';

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