import { beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FACTORY_PRESETS, serializePresetFile, type ConfigStore } from '@web-audio-tools/audio-core';
import { PresetService } from './preset.service';
import { CONFIG_STORE } from './config-store';

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

let service: PresetService;
let store: MemoryConfigStore;

beforeEach(() => {
  store = new MemoryConfigStore();
  TestBed.configureTestingModule({
    providers: [PresetService, { provide: CONFIG_STORE, useValue: store }]
  });
  service = TestBed.inject(PresetService);
});

describe('PresetService', () => {
  it('starts dry with factory presets available', () => {
    expect(service.selectedName()).toBeNull();
    expect(service.modified()).toBe(false);
    expect(service.allPresets().map(p => p.name)).toContain('Horn Ensemble');
    expect(service.isFactory('Rock Band')).toBe(true);
  });

  it('selecting a factory preset loads its config and is not modified', () => {
    service.select('Horn Ensemble');
    expect(service.selectedPreset()?.name).toBe('Horn Ensemble');
    expect(service.workingConfig().reverb.wet).toBe(FACTORY_PRESETS[0].config.reverb.wet);
    expect(service.modified()).toBe(false);
  });

  it('tweaking the working config marks it modified', () => {
    service.select('Horn Ensemble');
    service.updateSection('reverb', { wet: 0.9 });
    expect(service.modified()).toBe(true);
    expect(service.workingConfig().reverb.wet).toBe(0.9);
  });

  it('saveAsNew persists a user preset and selects it', () => {
    service.select('Rock Band');
    service.updateSection('eq', { highGainDb: 6 });
    const saved = service.saveAsNew('My Rock');
    expect(saved?.name).toBe('My Rock');
    expect(service.selectedName()).toBe('My Rock');
    expect(service.modified()).toBe(false);
    expect(service.isFactory('My Rock')).toBe(false);

    // The user preset is persisted in its own versioned document.
    expect(store.get('web_audio_slicer_presets')).toContain('My Rock');
  });

  it('imports and exports a preset JSON file', () => {
    const json = serializePresetFile(FACTORY_PRESETS[0]);
    const imported = service.importFromJson(json);
    expect(imported?.name).toBe('Horn Ensemble');
    expect(service.exportJson(imported!)).toContain('"version": 1');
    expect(service.importFromJson('garbage')).toBeNull();
  });

  it('deleting the selected user preset returns to dry', () => {
    service.saveAsNew('Temp');
    expect(service.selectedName()).toBe('Temp');
    service.deleteUserPreset('Temp');
    expect(service.selectedName()).toBeNull();
    expect(service.userPresets()).toHaveLength(0);
  });
});