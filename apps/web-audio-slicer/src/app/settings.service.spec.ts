import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ConfigStore } from '@web-audio-tools/audio-core';
import { CONFIG_STORE } from './config-store';
import { DEFAULT_SETTINGS, SettingsService } from './settings.service';

const SETTINGS_KEY = 'web_audio_slicer_settings';
const LEGACY_LANGUAGE_KEY = 'web_audio_slicer_transcription_language';
const API_KEY_STORAGE_KEY = 'web_audio_slicer_gemini_key';

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

function seedDocument(store: MemoryConfigStore, values: Record<string, unknown>, version = 1): void {
  store.set(SETTINGS_KEY, JSON.stringify({ version, values }));
}

function setup(store: MemoryConfigStore): SettingsService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: CONFIG_STORE, useValue: store }]
  });
  return TestBed.inject(SettingsService);
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('SettingsService', () => {
  it('loads Defaults when nothing is stored', () => {
    const service = setup(new MemoryConfigStore());
    expect(service.settings()).toEqual(DEFAULT_SETTINGS);
    expect(service.apiKey()).toBe('');
    expect(service.anyModified()).toBe(false);
  });

  it('round-trips Settings through the persisted document', () => {
    const store = new MemoryConfigStore();
    const first = setup(store);
    first.update({ thresholdDb: -50, minSilenceDuration: 3, transcriptionLanguage: 'de', transcribeSpeechGapsOnStart: false });

    const second = setup(store);
    expect(second.settings()).toEqual({
      ...DEFAULT_SETTINGS,
      thresholdDb: -50,
      minSilenceDuration: 3,
      transcriptionLanguage: 'de',
      transcribeSpeechGapsOnStart: false
    });
  });

  it('falls back to Defaults per invalid field, keeping valid ones', () => {
    const store = new MemoryConfigStore();
    seedDocument(store, {
      thresholdDb: 'loud',          // wrong type
      minSilenceDuration: 999,      // out of range
      minSongDuration: 12,          // valid
      mp3Bitrate: 123,              // not an offered bitrate
      preRollSec: 0.5,              // valid
      postRollSec: Number.NaN,      // not finite (serializes to null)
      transcriptionLanguage: 'xx',  // unknown language
      transcribeSpeechGapsOnStart: 'yes' // wrong type
    });
    const service = setup(store);
    expect(service.settings()).toEqual({
      ...DEFAULT_SETTINGS,
      minSongDuration: 12,
      preRollSec: 0.5
    });
  });

  it('discards an unparseable document and uses Defaults', () => {
    const store = new MemoryConfigStore();
    store.set(SETTINGS_KEY, '{not json');
    expect(setup(store).settings()).toEqual(DEFAULT_SETTINGS);
  });

  it('discards a document with a newer unknown version', () => {
    const store = new MemoryConfigStore();
    seedDocument(store, { thresholdDb: -50 }, 2);
    expect(setup(store).settings()).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates the legacy language key into the document and deletes it', () => {
    const store = new MemoryConfigStore();
    store.set(LEGACY_LANGUAGE_KEY, 'de');
    const service = setup(store);
    expect(service.settings().transcriptionLanguage).toBe('de');
    expect(store.get(LEGACY_LANGUAGE_KEY)).toBeNull();
    expect(JSON.parse(store.get(SETTINGS_KEY) ?? '{}').values.transcriptionLanguage).toBe('de');
  });

  it('ignores an invalid legacy language value but still deletes the key', () => {
    const store = new MemoryConfigStore();
    store.set(LEGACY_LANGUAGE_KEY, 'xx');
    const service = setup(store);
    expect(service.settings().transcriptionLanguage).toBe('auto');
    expect(store.get(LEGACY_LANGUAGE_KEY)).toBeNull();
  });

  it('prefers the document language over the legacy key', () => {
    const store = new MemoryConfigStore();
    seedDocument(store, { transcriptionLanguage: 'en' });
    store.set(LEGACY_LANGUAGE_KEY, 'de');
    const service = setup(store);
    expect(service.settings().transcriptionLanguage).toBe('en');
    expect(store.get(LEGACY_LANGUAGE_KEY)).toBeNull();
  });

  it('auto-saves valid updates and flags them as modified', () => {
    const store = new MemoryConfigStore();
    const service = setup(store);
    service.update({ thresholdDb: -50 });
    expect(service.settings().thresholdDb).toBe(-50);
    expect(service.modified().thresholdDb).toBe(true);
    expect(service.modified().minSilenceDuration).toBe(false);
    expect(service.anyModified()).toBe(true);
    expect(JSON.parse(store.get(SETTINGS_KEY) ?? '{}').values.thresholdDb).toBe(-50);
  });

  it('ignores invalid updates, keeping the last valid value unpersisted-over', () => {
    const store = new MemoryConfigStore();
    const service = setup(store);
    service.update({
      minSilenceDuration: Number.NaN,
      minSongDuration: 999,
      mp3Bitrate: 100,
      preRollSec: -1,
      transcriptionLanguage: 'xx' as never,
      transcribeSpeechGapsOnStart: null as never
    });
    expect(service.settings()).toEqual(DEFAULT_SETTINGS);
    expect(store.get(SETTINGS_KEY)).toBeNull();
    expect(service.anyModified()).toBe(false);
  });

  it('exposes exactly the six slicer parameters for the engine', () => {
    const service = setup(new MemoryConfigStore());
    service.update({ thresholdDb: -40 });
    expect(service.slicerParameters()).toEqual({
      thresholdDb: -40,
      minSilenceDuration: 2,
      minSongDuration: 8,
      mp3Bitrate: 192,
      preRollSec: 0.3,
      postRollSec: 0.5
    });
  });

  it('reset restores Defaults, clears the document, and keeps the apiKey', () => {
    const store = new MemoryConfigStore();
    const service = setup(store);
    service.update({ thresholdDb: -50, transcriptionLanguage: 'de' });
    service.setApiKey('my-key');

    service.resetToDefaults();

    expect(service.settings()).toEqual(DEFAULT_SETTINGS);
    expect(service.anyModified()).toBe(false);
    expect(store.get(SETTINGS_KEY)).toBeNull();
    expect(service.apiKey()).toBe('my-key');
    expect(store.get(API_KEY_STORAGE_KEY)).toBe('my-key');
  });

  it('persists the apiKey under its own legacy key and reloads it', () => {
    const store = new MemoryConfigStore();
    setup(store).setApiKey('my-key');
    expect(store.get(API_KEY_STORAGE_KEY)).toBe('my-key');
    expect(setup(store).apiKey()).toBe('my-key');
  });
});