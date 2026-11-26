import { describe, expect, it } from 'vitest';
import {
  FACTORY_PRESETS,
  findFactoryPreset,
  parsePresetDocument,
  parsePresetFile,
  sanitizeEffectConfig,
  sanitizePreset,
  serializePresetDocument,
  serializePresetFile
} from './presets';
import { isDryConfig } from './effects';

describe('Factory Presets', () => {
  it('ships Horn Ensemble and Rock Band, both non-dry', () => {
    expect(findFactoryPreset('Horn Ensemble')).toBeDefined();
    expect(findFactoryPreset('rock band')).toBeDefined();
    for (const preset of FACTORY_PRESETS) {
      expect(isDryConfig(preset.config)).toBe(false);
    }
  });
});

describe('sanitizeEffectConfig', () => {
  it('clamps out-of-range values and defaults missing fields', () => {
    const config = sanitizeEffectConfig({
      eq: { enabled: true, lowGainDb: 999, midFrequencyHz: -5 },
      compressor: { ratio: 'bad' },
      reverb: { wet: 5 }
    });
    expect(config.eq.lowGainDb).toBe(12);
    expect(config.eq.midFrequencyHz).toBeGreaterThanOrEqual(40);
    expect(config.compressor.ratio).toBeGreaterThanOrEqual(1);
    expect(config.reverb.wet).toBe(1);
    expect(config.noiseReduction.enabled).toBe(false);
  });

  it('returns a dry config for garbage', () => {
    expect(isDryConfig(sanitizeEffectConfig(null))).toBe(true);
    expect(isDryConfig(sanitizeEffectConfig('nope'))).toBe(true);
  });
});

describe('Preset serialization', () => {
  it('round-trips a preset file', () => {
    const preset = sanitizePreset({ name: 'My Sound', config: FACTORY_PRESETS[0].config })!;
    const parsed = parsePresetFile(serializePresetFile(preset));
    expect(parsed?.name).toBe('My Sound');
    expect(parsed?.config.reverb.wet).toBe(preset.config.reverb.wet);
  });

  it('rejects bad version and bad json', () => {
    expect(parsePresetFile('{"version":99,"preset":{"name":"x"}}')).toBeNull();
    expect(parsePresetFile('not json')).toBeNull();
    expect(parsePresetFile('{"version":1}')).toBeNull();
  });

  it('round-trips a preset document and drops invalid entries', () => {
    const presets = [
      sanitizePreset({ name: 'A', config: {} })!,
      sanitizePreset({ name: 'B', config: FACTORY_PRESETS[1].config })!
    ];
    const json = serializePresetDocument(presets);
    const parsed = parsePresetDocument(json);
    expect(parsed.map(p => p.name)).toEqual(['A', 'B']);

    const mixed = JSON.stringify({ version: 1, presets: [{ name: 'ok' }, { nope: true }, null] });
    expect(parsePresetDocument(mixed).map(p => p.name)).toEqual(['ok']);
    expect(parsePresetDocument(null)).toEqual([]);
    expect(parsePresetDocument('{"version":2,"presets":[]}')).toEqual([]);
  });
});