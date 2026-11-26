import { Injectable, computed, inject, signal } from '@angular/core';
import {
  DRY_EFFECT_CONFIG,
  FACTORY_PRESETS,
  cloneEffectConfig,
  parsePresetDocument,
  parsePresetFile,
  sanitizePreset,
  serializePresetDocument,
  serializePresetFile,
  type EffectChainConfig,
  type Preset
} from '@web-audio-tools/audio-core';
import { CONFIG_STORE } from './config-store';

const PRESETS_KEY = 'web_audio_slicer_presets';

/**
 * Presets are not Settings: the user-Preset library persists in its own
 * versioned document (surviving Reset to Defaults), while the *selection* is a
 * Run Option held in memory — every run starts dry. `workingConfig` is the
 * editable copy of the selected Preset; tweaking it makes it "modified", and it
 * can be saved as a new user Preset. Factory Presets are core constants.
 */
@Injectable({ providedIn: 'root' })
export class PresetService {
  private readonly store = inject(CONFIG_STORE);

  private readonly userPresetsSignal = signal<Preset[]>(this.load());
  /** Run Option: the selected Preset name, or null for dry. Not persisted. */
  private readonly selectedNameSignal = signal<string | null>(null);
  private readonly workingConfigSignal = signal<EffectChainConfig>(cloneEffectConfig(DRY_EFFECT_CONFIG));

  public readonly userPresets = this.userPresetsSignal.asReadonly();
  public readonly selectedName = this.selectedNameSignal.asReadonly();
  public readonly workingConfig = this.workingConfigSignal.asReadonly();

  public readonly allPresets = computed<Preset[]>(() => [...FACTORY_PRESETS, ...this.userPresetsSignal()]);

  public readonly selectedPreset = computed<Preset | null>(() => {
    const name = this.selectedNameSignal();
    if (!name) {
      return null;
    }
    return this.allPresets().find(p => p.name === name) ?? null;
  });

  /** True when the working config differs from the selected Preset (or dry). */
  public readonly modified = computed<boolean>(() => {
    const base = this.selectedPreset()?.config ?? DRY_EFFECT_CONFIG;
    return JSON.stringify(base) !== JSON.stringify(this.workingConfigSignal());
  });

  public isFactory(name: string): boolean {
    return FACTORY_PRESETS.some(p => p.name === name);
  }

  /** Selects a Preset by name (or null for dry) and resets the working copy. */
  public select(name: string | null): void {
    this.selectedNameSignal.set(name);
    const preset = name ? this.allPresets().find(p => p.name === name) ?? null : null;
    this.workingConfigSignal.set(cloneEffectConfig(preset ? preset.config : DRY_EFFECT_CONFIG));
  }

  /** Replaces one effect section in the working config (marks it modified). */
  public updateSection<K extends keyof EffectChainConfig>(kind: K, patch: Partial<EffectChainConfig[K]>): void {
    const current = this.workingConfigSignal();
    this.workingConfigSignal.set({
      ...current,
      [kind]: { ...current[kind], ...patch }
    });
  }

  public replaceWorkingConfig(config: EffectChainConfig): void {
    this.workingConfigSignal.set(cloneEffectConfig(config));
  }

  /** Saves the working config as a user Preset (replacing any same-named one). */
  public saveAsNew(name: string): Preset | null {
    const preset = sanitizePreset({ name, config: this.workingConfigSignal() });
    if (!preset) {
      return null;
    }
    const next = [...this.userPresetsSignal().filter(p => p.name !== preset.name), preset];
    this.userPresetsSignal.set(next);
    this.persist(next);
    this.selectedNameSignal.set(preset.name);
    return preset;
  }

  public deleteUserPreset(name: string): void {
    const next = this.userPresetsSignal().filter(p => p.name !== name);
    this.userPresetsSignal.set(next);
    this.persist(next);
    if (this.selectedNameSignal() === name) {
      this.select(null);
    }
  }

  /** Imports a versioned Preset JSON file body into the user library. */
  public importFromJson(json: string): Preset | null {
    const preset = parsePresetFile(json);
    if (!preset) {
      return null;
    }
    const next = [...this.userPresetsSignal().filter(p => p.name !== preset.name), preset];
    this.userPresetsSignal.set(next);
    this.persist(next);
    return preset;
  }

  public exportJson(preset: Preset): string {
    return serializePresetFile(preset);
  }

  private load(): Preset[] {
    return parsePresetDocument(this.store.get(PRESETS_KEY));
  }

  private persist(presets: Preset[]): void {
    this.store.set(PRESETS_KEY, serializePresetDocument(presets));
  }
}