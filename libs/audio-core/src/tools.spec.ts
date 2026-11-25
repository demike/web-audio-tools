import { describe, expect, it } from 'vitest';
import { createSlicerTools, type ToolDefinition } from './tools';
import { Slicer } from './slicer';
import { LameMp3Encoder } from './mp3';
import { concat, silence, tone, wavBytes } from './test-helpers';

function buildTools() {
  const signal = concat(silence(1), tone(2, 0.005, 300), silence(1), tone(10, 0.5), silence(3), tone(10, 0.5), silence(2));
  const bytes = wavBytes([signal, signal]);
  const slicer = new Slicer({ encoderFactory: () => new LameMp3Encoder(), transcription: null });

  const tools = createSlicerTools({
    slicer,
    resolveInput: async () => chunks(bytes),
    fileSize: async () => bytes.length
  });
  const byName = new Map<string, ToolDefinition>(tools.map(t => [t.name, t]));

  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`unknown tool ${name}`);
    }
    const response = await tool.execute(params);
    return response.content[0].text;
  };
  const callJson = async (name: string, params: Record<string, unknown> = {}) => JSON.parse(await call(name, params));

  return { slicer, call, callJson };
}

describe('createSlicerTools', () => {
  it('exposes the expected tool set', () => {
    const { slicer } = buildTools();
    const names = createSlicerTools({ slicer, resolveInput: async () => chunks(new Uint8Array(0)) }).map(t => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_slicer_state', 'get_tracks', 'get_silence_segments', 'get_gap_audio',
      'slice_wav', 'set_track_title', 'remove_track', 'export_tracks'
    ]));
  });

  it('supports the calling-model workflow: slice, fetch gap, name, export', async () => {
    const { call, callJson } = buildTools();

    const sliced = await callJson('slice_wav', { source: 'rehearsal.wav' });
    expect(sliced.tracks).toHaveLength(2);
    const speechGap = sliced.segments.find((s: { hasSpeechAudio: boolean }) => s.hasSpeechAudio);
    expect(speechGap).toBeDefined();
    expect(speechGap.status).toBe('idle');

    const gap = await callJson('get_gap_audio', { segmentId: speechGap.id });
    expect(gap.sampleRate).toBe(16000);
    expect(gap.speechWavBase64.length).toBeGreaterThan(100);

    const setResult = await call('set_track_title', { trackId: 1, title: 'Beethoven - Quartet Op. 131' });
    expect(setResult).toContain('Beethoven - Quartet Op. 131');

    const tracks = await callJson('get_tracks');
    expect(tracks.find((t: { id: number }) => t.id === 1).title).toBe('Beethoven - Quartet Op. 131');

    const exported = await callJson('export_tracks');
    expect(exported).toHaveLength(2);
    expect(exported.every((t: { mp3Base64: string }) => t.mp3Base64.length > 100)).toBe(true);
  });

  it('removes a track via remove_track', async () => {
    const { call, callJson } = buildTools();
    await callJson('slice_wav', { source: 'rehearsal.wav' });

    const message = await call('remove_track', { trackId: 1 });
    expect(message).toContain('removed');

    const tracks = await callJson('get_tracks');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe(2);
  });

  it('reports missing gap audio and unknown tracks gracefully', async () => {
    const { call, callJson } = buildTools();
    await callJson('slice_wav', { source: 'rehearsal.wav' });

    expect(await call('get_gap_audio', { segmentId: 999 })).toContain('No prepared speech audio');
    expect(await call('set_track_title', { trackId: 999, title: 'x' })).toContain('not found');
    expect(await call('remove_track', { trackId: 999 })).toContain('not found');
  });
});

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += 8192) {
    yield bytes.subarray(i, Math.min(i + 8192, bytes.length));
  }
}