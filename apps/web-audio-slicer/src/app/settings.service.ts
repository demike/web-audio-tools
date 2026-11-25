import { Injectable, computed, inject, signal } from '@angular/core';
import {
  DEFAULT_SLICER_PARAMETERS,
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  type SlicerParameters,
  type TranscriptionLanguageCode
} from '@web-audio-tools/audio-core';
import { CONFIG_STORE } from './config-store';

/** Persisted user preferences. The apiKey is stored alongside but is not a Setting. */
export interface Settings extends SlicerParameters {
  transcriptionLanguage: TranscriptionLanguageCode;
  transcribeSpeechGapsOnStart: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_SLICER_PARAMETERS,
  transcriptionLanguage: 'auto',
  transcribeSpeechGapsOnStart: true
};

const SETTINGS_KEY = 'web_audio_slicer_settings';
const SETTINGS_VERSION = 1;
/** Pre-settings-document key; migrated into the document on first load. */
const LEGACY_LANGUAGE_KEY = 'web_audio_slicer_transcription_language';
/** The apiKey keeps its own pre-existing key: a credential, not a preference. */
const API_KEY_STORAGE_KEY = 'web_audio_slicer_gemini_key';

const MP3_BITRATES: ReadonlyArray<number> = [96, 128, 192, 320];

/** Valid ranges mirror the settings drawer's input constraints. */
const NUMERIC_BOUNDS: Record<keyof SlicerParameters, { min: number; max: number }> = {
  thresholdDb: { min: -60, max: -25 },
  minSilenceDuration: { min: 0.5, max: 10 },
  minSongDuration: { min: 2, max: 60 },
  mp3Bitrate: { min: 96, max: 320 },
  preRollSec: { min: 0, max: 2 },
  postRollSec: { min: 0, max: 3 }
};

function isValidSetting(key: keyof Settings, value: unknown): boolean {
  switch (key) {
    case 'transcriptionLanguage':
      return TRANSCRIPTION_LANGUAGE_OPTIONS.some(option => option.value === value);
    case 'transcribeSpeechGapsOnStart':
      return typeof value === 'boolean';
    case 'mp3Bitrate':
      return typeof value === 'number' && MP3_BITRATES.includes(value);
    default: {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const { min, max } = NUMERIC_BOUNDS[key];
      return value >= min && value <= max;
    }
  }
}

interface SettingsDocument {
  version: number;
  values: Partial<Settings>;
}

function parseDocument(raw: string | null): SettingsDocument | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' && parsed !== null
      && (parsed as { version?: unknown }).version === SETTINGS_VERSION
      && typeof (parsed as { values?: unknown }).values === 'object'
      && (parsed as { values?: unknown }).values !== null
    ) {
      return parsed as SettingsDocument;
    }
  } catch {
    // Unparseable document: fall through to defaults.
  }
  return null;
}

/**
 * Single source of truth for Settings. Loads and validates the persisted
 * document, auto-saves every valid change, and exposes per-field "modified"
 * flags comparing against Defaults. Reset restores Defaults and discards the
 * persisted document; the apiKey survives it.
 */
@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly store = inject(CONFIG_STORE);

  private readonly settingsSignal = signal<Settings>(this.load());
  private readonly apiKeySignal = signal<string>(this.store.get(API_KEY_STORAGE_KEY) ?? '');

  public readonly settings = this.settingsSignal.asReadonly();
  public readonly apiKey = this.apiKeySignal.asReadonly();

  /** Per-field flags: true when the Setting differs from its Default. */
  public readonly modified = computed<Record<keyof Settings, boolean>>(() => {
    const current = this.settingsSignal();
    const flags = {} as Record<keyof Settings, boolean>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      flags[key] = current[key] !== DEFAULT_SETTINGS[key];
    }
    return flags;
  });

  public readonly anyModified = computed(() => Object.values(this.modified()).some(Boolean));

  public readonly slicerParameters = computed<SlicerParameters>(() => {
    const { thresholdDb, minSilenceDuration, minSongDuration, mp3Bitrate, preRollSec, postRollSec } = this.settingsSignal();
    return { thresholdDb, minSilenceDuration, minSongDuration, mp3Bitrate, preRollSec, postRollSec };
  });

  /** Applies and persists every valid field in the patch; invalid fields are ignored. */
  public update(patch: Partial<Settings>): void {
    const current = this.settingsSignal();
    const next = { ...current };
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof Settings>) {
      const value = patch[key];
      if (value !== undefined && isValidSetting(key, value) && value !== current[key]) {
        Object.assign(next, { [key]: value });
        changed = true;
      }
    }
    if (!changed) return;
    this.settingsSignal.set(next);
    this.persist(next);
  }

  public setApiKey(key: string): void {
    this.apiKeySignal.set(key);
    this.store.set(API_KEY_STORAGE_KEY, key);
  }

  /** Restores Defaults and clears the persisted document. The apiKey is kept. */
  public resetToDefaults(): void {
    this.settingsSignal.set({ ...DEFAULT_SETTINGS });
    this.store.remove(SETTINGS_KEY);
  }

  private load(): Settings {
    const settings = { ...DEFAULT_SETTINGS };
    const document = parseDocument(this.store.get(SETTINGS_KEY));
    let documentProvidedLanguage = false;

    if (document) {
      for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
        const value = document.values[key];
        if (isValidSetting(key, value)) {
          Object.assign(settings, { [key]: value });
          if (key === 'transcriptionLanguage') documentProvidedLanguage = true;
        }
      }
    }

    const legacyLanguage = this.store.get(LEGACY_LANGUAGE_KEY);
    if (legacyLanguage !== null) {
      if (!documentProvidedLanguage && isValidSetting('transcriptionLanguage', legacyLanguage)) {
        settings.transcriptionLanguage = legacyLanguage as TranscriptionLanguageCode;
      }
      this.store.remove(LEGACY_LANGUAGE_KEY);
      // Persist the migrated state so it survives the legacy key's removal.
      this.persist(settings);
    }

    return settings;
  }

  private persist(settings: Settings): void {
    this.store.set(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, values: settings }));
  }
}