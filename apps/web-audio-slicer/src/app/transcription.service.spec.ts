import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MusicBrainzClient, type ConfigStore } from '@web-audio-tools/audio-core';
import { CONFIG_STORE } from './config-store';
import { SettingsService } from './settings.service';
import { TranscriptionService } from './transcription.service';

class MemoryConfigStore implements ConfigStore {
  public readonly data = new Map<string, string>();
  public get(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  public set(key: string, value: string): void {
    this.data.set(key, value);
  }
  public remove(key: string): void {
    this.data.delete(key);
  }
}

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

let settings: SettingsService;

function createService(): TranscriptionService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: CONFIG_STORE, useValue: new MemoryConfigStore() }]
  });
  settings = TestBed.inject(SettingsService);
  return TestBed.inject(TranscriptionService);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('TranscriptionService settings delegation', () => {
  it('reads the API key and language from the SettingsService', () => {
    const service = createService();
    expect(service.getApiKey()).toBe('');
    expect(service.getTranscriptionLanguage()).toBe('auto');

    settings.setApiKey('test-key');
    settings.update({ transcriptionLanguage: 'de' });
    expect(service.getApiKey()).toBe('test-key');
    expect(service.getTranscriptionLanguage()).toBe('de');
  });
});

describe('TranscriptionService provider detection', () => {
  it('reports a provider when an API key is configured', async () => {
    const service = createService();
    settings.setApiKey('test-key');
    expect(await service.hasProvider()).toBe(true);
  });

  it('reports no provider without a key or Prompt API', async () => {
    const service = createService();
    expect(await service.hasProvider()).toBe(false);
  });

  it('explains the secure-context requirement when insecure', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    try {
      const service = createService();
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
    const service = createService();
    settings.setApiKey('test-key');
    const text = await service.transcribeAudio(new Uint8Array([1, 2, 3]), 16000);
    expect(text).toBe('Okay everyone, lets play the Beethoven.');
  });

  it('filters meta-responses to an empty transcript', async () => {
    stubFetch('There is no speech in this audio.');
    const service = createService();
    settings.setApiKey('test-key');
    const text = await service.transcribeAudio(new Uint8Array([1, 2, 3]), 16000);
    expect(text).toBe('');
  });

  it('extracts a title candidate via Gemini', async () => {
    stubFetch('Beethoven - String Quartet Op. 131');
    // Mock the MusicBrainz collaborator so the test doesn't wait on its
    // per-request rate limiting across no-match queries.
    vi.spyOn(MusicBrainzClient.prototype, 'findTitle').mockResolvedValue(null);
    const service = createService();
    settings.setApiKey('test-key');
    const result = await service.extractSongTitle('beethoven quartet opus 131');
    expect(result).toEqual({ title: 'Beethoven - String Quartet Op. 131', source: 'transcription' });
  });

  it('returns null without a provider', async () => {
    const service = createService();
    expect(await service.transcribeAudio(new Uint8Array([1]), 16000)).toBeNull();
  });
});