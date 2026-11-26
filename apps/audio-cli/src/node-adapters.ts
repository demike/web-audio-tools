/**
 * Node/Bun adapters for the core seams: filesystem audio input and output.
 * These live in the CLI app, not the core, so the core stays platform-agnostic.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { compareNaturally, type AudioInput, type RecordingChunk } from '@web-audio-tools/audio-core';

export async function* fileAudioInput(path: string): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    yield new Uint8Array(chunk as Buffer);
  }
}

/** Byte-range read (Node's createReadStream seeks natively; end is inclusive). */
export async function* fileRangeInput(path: string, startByte: number, endByte: number): AsyncGenerator<Uint8Array> {
  if (endByte <= startByte) {
    return;
  }
  const stream = createReadStream(path, { start: startByte, end: endByte - 1 });
  for await (const chunk of stream) {
    yield new Uint8Array(chunk as Buffer);
  }
}

export async function readTextFile(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

export async function getFileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes);
}

export function fileAudioInputFactory(path: string): AudioInput {
  return fileAudioInput(path);
}

export function isWavFile(name: string): boolean {
  return name.toLowerCase().endsWith('.wav');
}

/** Minimal glob: `*` and `?` only, case-insensitive, matched against the file name. */
export function matchesGlob(name: string, pattern: string): boolean {
  if (!pattern) {
    return true;
  }
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

/** Card directories that never hold source recordings (Zoom TRASH/Export). */
const SKIPPED_DIRECTORIES = new Set(['trash', 'export']);

/** Recursively collects WAV files under a directory, natural-sorted by path. */
export async function scanWavFiles(dir: string, match: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
          await walk(fullPath);
        }
      } else if (entry.isFile() && isWavFile(entry.name) && matchesGlob(entry.name, match)) {
        found.push(fullPath);
      }
    }
  };
  await walk(dir);
  return found.sort(compareNaturally);
}

/**
 * Resolves positional inputs to an ordered list of WAV paths. Files are kept
 * exactly as given (never filtered); directories expand in place to their WAV
 * files (filtered by `match`). A directory with no matching WAVs is an error.
 */
export async function expandInputPaths(inputs: string[], match: string): Promise<string[]> {
  const paths: string[] = [];
  for (const input of inputs) {
    const info = await stat(input);
    if (info.isDirectory()) {
      const found = await scanWavFiles(input, match);
      if (found.length === 0) {
        throw new Error(`No WAV files${match ? ` matching "${match}"` : ''} found in directory "${input}".`);
      }
      paths.push(...found);
    } else if (info.isFile()) {
      paths.push(input);
    } else {
      throw new Error(`Input "${input}" is neither a file nor a directory.`);
    }
  }
  return paths;
}

/** A RecordingChunk backed by a filesystem path. */
export async function pathRecordingChunk(path: string): Promise<RecordingChunk> {
  return {
    name: basename(path),
    sizeBytes: await getFileSize(path),
    open: () => fileAudioInput(path),
    openRange: (startByte, endByte) => fileRangeInput(path, startByte, endByte)
  };
}