/**
 * Presets: named, reusable effect configurations. Factory Presets ship as
 * constants in the core (shared by browser + CLI); user Presets persist through
 * the ConfigStore port and travel between platforms as JSON. Selecting a Preset
 * is a Run Option; a Preset is not a Setting.
 */
import {
  DRY_EFFECT_CONFIG,
  cloneEffectConfig,
  type EffectChainConfig
} from './effects';

export interface Preset {
  name: string;
  config: EffectChainConfig;
}

/** Versioned envelope for a single exported Preset (import/export + CLI files). */
export interface PresetFile {
  version: 1;
  preset: Preset;
}

/** Versioned envelope for the persisted user-Preset library. */
export interface PresetDocument {
  version: 1;
  presets: Preset[];
}

export const PRESET_FILE_VERSION = 1;
export const PRESET_DOCUMENT_VERSION = 1;

export const FACTORY_PRESETS: ReadonlyArray<Preset> = [
  {
    name: 'Horn Ensemble',
    config: {
      noiseReduction: { enabled: true, strength: 0.3 },
      eq: { enabled: true, lowGainDb: 1, midGainDb: 1.5, midFrequencyHz: 1200, highGainDb: 2 },
      compressor: { enabled: true, thresholdDb: -18, ratio: 2, attackMs: 10, releaseMs: 150, makeupDb: 2 },
      reverb: { enabled: true, roomSize: 0.6, damping: 0.4, wet: 0.25, dry: 0.85 },
      normalize: { enabled: true, targetPeakDb: -1 }
    }
  },
  {
    name: 'Rock Band',
    config: {
      noiseReduction: { enabled: true, strength: 0.2 },
      eq: { enabled: true, lowGainDb: 1.5, midGainDb: -1, midFrequencyHz: 800, highGainDb: 2.5 },
      compressor: { enabled: true, thresholdDb: -14, ratio: 4, attackMs: 5, releaseMs: 100, makeupDb: 3 },
      reverb: { enabled: true, roomSize: 0.35, damping: 0.6, wet: 0.12, dry: 0.95 },
      normalize: { enabled: true, targetPeakDb: -1 }
    }
  }
];

export function findFactoryPreset(name: string): Preset | undefined {
  return FACTORY_PRESETS.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Validates an untrusted config object against the dry defaults, field by field. */
export function sanitizeEffectConfig(raw: unknown): EffectChainConfig {
  const base = cloneEffectConfig(DRY_EFFECT_CONFIG);
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const r = raw as Record<string, unknown>;
  const section = (key: string): Record<string, unknown> =>
    (r[key] && typeof r[key] === 'object' ? r[key] as Record<string, unknown> : {});

  const nr = section('noiseReduction');
  base.noiseReduction = {
    enabled: bool(nr['enabled'], base.noiseReduction.enabled),
    strength: num(nr['strength'], base.noiseReduction.strength, 0, 1)
  };
  const eq = section('eq');
  base.eq = {
    enabled: bool(eq['enabled'], base.eq.enabled),
    lowGainDb: num(eq['lowGainDb'], base.eq.lowGainDb, -12, 12),
    midGainDb: num(eq['midGainDb'], base.eq.midGainDb, -12, 12),
    midFrequencyHz: num(eq['midFrequencyHz'], base.eq.midFrequencyHz, 40, 12000),
    highGainDb: num(eq['highGainDb'], base.eq.highGainDb, -12, 12)
  };
  const comp = section('compressor');
  base.compressor = {
    enabled: bool(comp['enabled'], base.compressor.enabled),
    thresholdDb: num(comp['thresholdDb'], base.compressor.thresholdDb, -60, 0),
    ratio: num(comp['ratio'], base.compressor.ratio, 1, 20),
    attackMs: num(comp['attackMs'], base.compressor.attackMs, 0.1, 200),
    releaseMs: num(comp['releaseMs'], base.compressor.releaseMs, 1, 2000),
    makeupDb: num(comp['makeupDb'], base.compressor.makeupDb, 0, 24)
  };
  const rev = section('reverb');
  base.reverb = {
    enabled: bool(rev['enabled'], base.reverb.enabled),
    roomSize: num(rev['roomSize'], base.reverb.roomSize, 0, 1),
    damping: num(rev['damping'], base.reverb.damping, 0, 1),
    wet: num(rev['wet'], base.reverb.wet, 0, 1),
    dry: num(rev['dry'], base.reverb.dry, 0, 1)
  };
  const norm = section('normalize');
  base.normalize = {
    enabled: bool(norm['enabled'], base.normalize.enabled),
    targetPeakDb: num(norm['targetPeakDb'], base.normalize.targetPeakDb, -24, 0)
  };
  return base;
}

export function sanitizePreset(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
  if (!name) {
    return null;
  }
  return { name, config: sanitizeEffectConfig(r['config']) };
}

/** Serializes a Preset to a versioned JSON file body (export / CLI). */
export function serializePresetFile(preset: Preset): string {
  const file: PresetFile = { version: PRESET_FILE_VERSION, preset };
  return JSON.stringify(file, null, 2);
}

/** Parses a versioned Preset file; returns null on bad shape or unknown version. */
export function parsePresetFile(json: string): Preset | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const r = parsed as Record<string, unknown>;
  if (r['version'] !== PRESET_FILE_VERSION) {
    return null;
  }
  return sanitizePreset(r['preset']);
}

export function serializePresetDocument(presets: Preset[]): string {
  const doc: PresetDocument = { version: PRESET_DOCUMENT_VERSION, presets };
  return JSON.stringify(doc, null, 2);
}

/** Parses the persisted user-Preset library; invalid entries are dropped. */
export function parsePresetDocument(json: string | null): Preset[] {
  if (!json) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const r = parsed as Record<string, unknown>;
  if (r['version'] !== PRESET_DOCUMENT_VERSION || !Array.isArray(r['presets'])) {
    return [];
  }
  const out: Preset[] = [];
  for (const entry of r['presets']) {
    const preset = sanitizePreset(entry);
    if (preset) {
      out.push(preset);
    }
  }
  return out;
}