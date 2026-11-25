/**
 * Node/Bun adapters for the core seams: filesystem audio input and output.
 * These live in the CLI app, not the core, so the core stays platform-agnostic.
 */
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import type { AudioInput } from '@web-audio-tools/audio-core';

export async function* fileAudioInput(path: string): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    yield new Uint8Array(chunk as Buffer);
  }
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