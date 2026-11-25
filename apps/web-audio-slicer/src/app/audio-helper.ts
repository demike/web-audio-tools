/**
 * Compatibility shim. The WAV/DSP helpers now live in the platform-agnostic
 * core library; this module re-exports them for any existing browser imports.
 */
export {
  parseWavHeader,
  WavStreamParser,
  calculateRms,
  rmsToDb,
  prepareSpeechAudio,
  createWavBytes,
  createWavBlob,
  type WavHeader,
  type PreparedSpeechAudio,
  type SpeechAudioOptions
} from '@web-audio-tools/audio-core';