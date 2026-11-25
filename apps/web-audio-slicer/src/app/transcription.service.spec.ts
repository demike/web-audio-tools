import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicBrainzClient } from '@web-audio-tools/audio-core';
import { TranscriptionService } from './transcription.service';

function stubFetch(geminiText: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('generativelanguage')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: geminiText }] } }] })
      };
    }
    // MusicBrainz: no matches.
    return { ok: true, status: 200, json: async () => ({ works: [], recordings: [] }) };
  }));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TranscriptionService settings', () => {
  it('persists the Gemini API key', () => {
    const service = new TranscriptionService();
    expect(service.getApiKey()).toBe('');
    service.saveApiKey('test-key');
    expect(service.getApiKey()).toBe('test-key');
  });

  it('persists a valid language and rejects unknown codes', () => {
    const service = new TranscriptionService();
    service.saveTranscriptionLanguage('de');
    expect(service.getTranscriptionLanguage()).toBe('de');
    localStorage.setItem('web_audio_slicer_transcription_language', 'klingon');
    expect(service.getTranscriptionLanguage()).toBe('auto');
  });
});

describe('TranscriptionService provider detection', () => {
  it('reports a provider when an API key is configured', async () => {
    const service = new TranscriptionService();
    service.saveApiKey('test-key');
    expect(await service.hasProvider()).toBe(true);
  });

  it('reports no provider without a key or Prompt API', async () => {
    const service = new TranscriptionService();
    expect(await service.hasProvider()).toBe(false);
  });

  it('explains the secure-context requirement when insecure', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    try {
      const service = new TranscriptionService();
      const diagnostics = await service.refreshPromptApiDiagnostics();
      expect(diagnostics.status).toBe('unsupported');
      expect(diagnostics.detail).toContain('secure context');
    } finally {
      if (original) {
        Object.defineProperty(window, 'isSecureContext', original);
      }
    }
  });
});

describe('TranscriptionService Gemini fallback', () => {
  it('transcribes via Gemini and normalizes the result', async () => {
    stubFetch('  "Okay everyone, lets play the Beethoven."  ');
    const service = new TranscriptionService();
    service.saveApiKey('test-key');
    const text = await service.transcribeAudio(new Uint8Array([1, 2, 3]), 16000);
    expect(text).toBe('Okay everyone, lets play the Beethoven.');
  });

  it('filters meta-responses to an empty transcript', async () => {
    stubFetch('There is no speech in this audio.');
    const service = new TranscriptionService();
    service.saveApiKey('test-key');
    const text = await service.transcribeAudio(new Uint8Array([1, 2, 3]), 16000);
    expect(text).toBe('');
  });

  it('extracts a title candidate via Gemini', async () => {
    stubFetch('Beethoven - String Quartet Op. 131');
    // Mock the MusicBrainz collaborator so the test doesn't wait on its
    // per-request rate limiting across no-match queries.
    vi.spyOn(MusicBrainzClient.prototype, 'findTitle').mockResolvedValue(null);
    const service = new TranscriptionService();
    service.saveApiKey('test-key');
    const result = await service.extractSongTitle('beethoven quartet opus 131');
    expect(result).toEqual({ title: 'Beethoven - String Quartet Op. 131', source: 'transcription' });
  });

  it('returns null without a provider', async () => {
    const service = new TranscriptionService();
    expect(await service.transcribeAudio(new Uint8Array([1]), 16000)).toBeNull();
  });
});