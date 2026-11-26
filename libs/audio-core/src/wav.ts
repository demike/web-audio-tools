/**
 * Audio helper functions for WAV streaming, parsing, writing, and volume analysis.
 */

export interface WavHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  audioFormat: number;
  dataOffset: number;
  dataSize: number;
}

/**
 * Upper bound on how many leading bytes are scanned for the RIFF/RF64 header.
 * Recorders (e.g. Zoom) embed BEXT/iXML metadata chunks before `data`, so the
 * header can be well past the canonical 44 bytes. RF64 (2 GB splits) adds a
 * ds64 chunk. 1 MiB comfortably covers real-world metadata while still bounding
 * the scan for a file that is not a WAV at all.
 */
export const MAX_WAV_HEADER_BYTES = 1024 * 1024;

const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Parses a WAV file header from an ArrayBuffer. Handles canonical RIFF PCM,
 * RF64 (Zoom 2 GB splits: `RF64` magic + a `ds64` chunk carrying the real data
 * size), and WAVE_FORMAT_EXTENSIBLE (format code lives in the SubFormat GUID).
 */
export function parseWavHeader(buffer: ArrayBuffer): WavHeader | null {
  const view = new DataView(buffer);

  if (view.byteLength < 44) return null;

  // Check "RIFF" or "RF64" (RF64 is used for files > 2 GB).
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'RIFF' && magic !== 'RF64') return null;

  // Check "WAVE"
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (wave !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataSize = 0;
  let dataOffset = 0;
  let ds64DataSize: number | null = null;

  // Scan chunks
  while (offset + 8 <= view.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'ds64') {
      // ds64 data: riffSize(8), dataSize(8), sampleCount(8), tableLength(4)...
      if (offset + 8 + 16 <= view.byteLength) {
        ds64DataSize = Number(view.getBigUint64(offset + 8 + 8, true));
      }
    } else if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format code is the first 2 bytes of
      // the SubFormat GUID (fmt data offset 24 → file offset + 8 + 24).
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && chunkSize >= 40 && offset + 8 + 24 + 2 <= view.byteLength) {
        audioFormat = view.getUint16(offset + 8 + 24, true);
      }
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      // RF64 stores 0xFFFFFFFF here and the true size in ds64.
      dataSize = chunkSize === 0xffffffff && ds64DataSize !== null ? ds64DataSize : chunkSize;
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (sampleRate === 0 || channels === 0 || dataOffset === 0) return null;

  return {
    sampleRate,
    channels,
    bitsPerSample,
    audioFormat,
    dataOffset,
    dataSize
  };
}

/**
 * Helper class to parse a WAV stream chunk-by-chunk.
 * Handles boundary issues where chunks are split across sample or header boundaries.
 */
export class WavStreamParser {
  private headerParsed = false;
  public header: WavHeader | null = null;
  private leftoverBytes = new Uint8Array(0);
  private bytesProcessed = 0;
  private dataBytesRead = 0;

  /**
   * Processes a new Uint8Array chunk from the stream.
   * Returns an array of Float32Array (one per channel) containing the newly decoded samples.
   */
  public feed(chunk: Uint8Array): Float32Array[] | null {
    // Combine leftover bytes from previous feed
    const combined = new Uint8Array(this.leftoverBytes.length + chunk.length);
    combined.set(this.leftoverBytes);
    combined.set(chunk, this.leftoverBytes.length);

    let offset = 0;

    // 1. Parse header if not yet parsed
    if (!this.headerParsed) {
      if (combined.length < 44) {
        this.leftoverBytes = combined;
        return null;
      }

      const parsed = parseWavHeader(combined.buffer.slice(combined.byteOffset, combined.byteOffset + Math.min(MAX_WAV_HEADER_BYTES, combined.length)));
      if (!parsed) {
        // Not a valid WAV or need more header data
        if (combined.length > MAX_WAV_HEADER_BYTES) {
          throw new Error('Invalid WAV file header format.');
        }
        this.leftoverBytes = combined;
        return null;
      }

      this.header = parsed;
      this.headerParsed = true;
      offset = parsed.dataOffset;
      this.bytesProcessed = offset;
    } else {
      // If header is already parsed, we are in the data chunk.
      // But we must align with the bytesProcessed.
      offset = 0;
    }

    const header = this.header;
    if (!header) {
      return null;
    }

    const bytesLeft = combined.length - offset;
    const bytesPerSample = (header.bitsPerSample / 8) * header.channels;
    
    if (bytesLeft < bytesPerSample) {
      this.leftoverBytes = combined.subarray(offset);
      return null;
    }

    // Determine how many complete samples we can read
    const numCompleteSamples = Math.floor(bytesLeft / bytesPerSample);
    const bytesToRead = numCompleteSamples * bytesPerSample;
    const activeSlice = combined.subarray(offset, offset + bytesToRead);
    
    // Save remaining bytes for next feed
    this.leftoverBytes = combined.subarray(offset + bytesToRead);
    this.bytesProcessed += bytesToRead;
    this.dataBytesRead += bytesToRead;

    // Decode PCM to Float32 channel buffers
    return this.decodePCM(activeSlice, header);
  }

  /**
   * Flushes any remaining bytes.
   */
  public flush(): Float32Array[] | null {
    if (this.leftoverBytes.length === 0 || !this.header) return null;
    
    const bytesPerSample = (this.header.bitsPerSample / 8) * this.header.channels;
    const numCompleteSamples = Math.floor(this.leftoverBytes.length / bytesPerSample);
    if (numCompleteSamples === 0) return null;
    
    const bytesToRead = numCompleteSamples * bytesPerSample;
    const activeSlice = this.leftoverBytes.subarray(0, bytesToRead);
    return this.decodePCM(activeSlice, this.header);
  }

  private decodePCM(bytes: Uint8Array, header: WavHeader): Float32Array[] {
    return decodeWavPcm(bytes, header);
  }
}

/**
 * Decodes a frame-aligned block of PCM bytes to Float32 channel buffers.
 * `bytes.length` must be a whole multiple of the frame size. Shared by the
 * stream parser and the region reader.
 */
export function decodeWavPcm(bytes: Uint8Array, header: WavHeader): Float32Array[] {
    const numChannels = header.channels;
    const bitsPerSample = header.bitsPerSample;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    
    const totalSamples = bytes.length / (bitsPerSample / 8);
    const samplesPerChannel = totalSamples / numChannels;
    
    const channelsData: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channelsData.push(new Float32Array(samplesPerChannel));
    }
    
    let sampleIdx = 0;
    let byteOffset = 0;

    if (bitsPerSample === 16) {
      while (byteOffset < bytes.length) {
        for (let c = 0; c < numChannels; c++) {
          const val = view.getInt16(byteOffset, true);
          channelsData[c][sampleIdx] = val / 32768.0;
          byteOffset += 2;
        }
        sampleIdx++;
      }
    } else if (bitsPerSample === 24) {
      while (byteOffset < bytes.length) {
        for (let c = 0; c < numChannels; c++) {
          // Read 3 bytes signed integer (little endian)
          const b0 = view.getUint8(byteOffset);
          const b1 = view.getUint8(byteOffset + 1);
          const b2 = view.getUint8(byteOffset + 2);
          
          let val = b0 | (b1 << 8) | (b2 << 16);
          // Sign extend if 24th bit is set
          if (val & 0x800000) {
            val |= 0xff000000;
          }
          
          channelsData[c][sampleIdx] = val / 8388608.0;
          byteOffset += 3;
        }
        sampleIdx++;
      }
    } else if (bitsPerSample === 32) {
      if (header.audioFormat === 3) {
        // IEEE Float
        while (byteOffset < bytes.length) {
          for (let c = 0; c < numChannels; c++) {
            channelsData[c][sampleIdx] = view.getFloat32(byteOffset, true);
            byteOffset += 4;
          }
          sampleIdx++;
        }
      } else {
        // 32-bit PCM Integer
        while (byteOffset < bytes.length) {
          for (let c = 0; c < numChannels; c++) {
            const val = view.getInt32(byteOffset, true);
            channelsData[c][sampleIdx] = val / 2147483648.0;
            byteOffset += 4;
          }
          sampleIdx++;
        }
      }
    } else {
      throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
    }

    return channelsData;
}

/**
 * Calculates the RMS (Root Mean Square) volume of a buffer of float samples.
 * Returns value between 0.0 and 1.0.
 */
export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Converts RMS to Decibels (dB). 0 dB is max volume, -100 dB is silence.
 */
export function rmsToDb(rms: number): number {
  if (rms <= 0) return -100;
  return 20 * Math.log10(rms);
}

export interface PreparedSpeechAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SpeechAudioOptions {
  /** Target sample rate for speech recognition. Never upsamples. Defaults to 16000. */
  targetSampleRate?: number;
  /** RMS threshold used to trim leading/trailing silence. Defaults to -60 dB. */
  trimThresholdDb?: number;
  /** Maximum duration sent for transcription; only the tail is kept when exceeded. Defaults to 360 s. */
  maxDurationSec?: number;
  /** Internal silence runs longer than this are compressed. Defaults to 1 s. */
  maxInternalSilenceSec?: number;
  /** How much of each long internal silence run is kept. Defaults to 0.5 s. */
  keptInternalSilenceSec?: number;
  /** Peak level after normalization (0..1). Defaults to ~-3 dBFS. */
  targetPeak?: number;
}

/**
 * Prepares buffered rehearsal gap audio for speech transcription:
 * downmixes to mono, resamples to a speech-friendly rate, trims dead air,
 * compresses long internal pauses (tuning, discussion) while keeping all
 * speech, and peak-normalizes quiet speech so the transcriber hears it at a
 * usable level. Announcements can happen well before the piece starts, so
 * speech anywhere in the gap is preserved.
 *
 * Returns null when the gap contains no audible content.
 */
export function prepareSpeechAudio(
  channelsData: Float32Array[],
  sampleRate: number,
  options: SpeechAudioOptions = {}
): PreparedSpeechAudio | null {
  const targetSampleRate = options.targetSampleRate ?? 16000;
  const trimThresholdDb = options.trimThresholdDb ?? -60;
  const maxDurationSec = options.maxDurationSec ?? 360;
  const maxInternalSilenceSec = options.maxInternalSilenceSec ?? 1.0;
  const keptInternalSilenceSec = options.keptInternalSilenceSec ?? 0.5;
  const targetPeak = options.targetPeak ?? 0.707;

  const sampleCount = channelsData[0]?.length ?? 0;
  if (sampleCount === 0 || sampleRate <= 0) {
    return null;
  }

  // 1. Downmix to mono.
  let mono: Float32Array;
  if (channelsData.length === 1) {
    mono = channelsData[0];
  } else {
    mono = new Float32Array(sampleCount);
    for (const channel of channelsData) {
      for (let i = 0; i < sampleCount; i++) {
        mono[i] += channel[i];
      }
    }
    for (let i = 0; i < sampleCount; i++) {
      mono[i] /= channelsData.length;
    }
  }

  // 2. Resample (linear interpolation) to the speech target rate; never upsample.
  const outputRate = Math.min(sampleRate, targetSampleRate);
  if (outputRate !== sampleRate) {
    const ratio = sampleRate / outputRate;
    const outputLength = Math.floor(sampleCount / ratio);
    const resampled = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = mono[index];
      const b = mono[Math.min(index + 1, sampleCount - 1)];
      resampled[i] = a + (b - a) * fraction;
    }
    mono = resampled;
  }

  // 3. Trim leading/trailing silence with a generous threshold and small padding.
  const trimWindowSize = Math.max(1, Math.round(outputRate * 0.02)); // 20 ms windows
  const trimThresholdRms = Math.pow(10, trimThresholdDb / 20);
  let firstActiveWindow = -1;
  let lastActiveWindow = -1;
  const windowCount = Math.ceil(mono.length / trimWindowSize);

  for (let w = 0; w < windowCount; w++) {
    const start = w * trimWindowSize;
    const end = Math.min(start + trimWindowSize, mono.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += mono[i] * mono[i];
    }
    if (Math.sqrt(sum / (end - start)) > trimThresholdRms) {
      if (firstActiveWindow === -1) {
        firstActiveWindow = w;
      }
      lastActiveWindow = w;
    }
  }

  if (firstActiveWindow === -1) {
    return null;
  }

  const paddingSamples = Math.round(outputRate * 0.1); // keep 100 ms around speech
  const trimStart = Math.max(0, firstActiveWindow * trimWindowSize - paddingSamples);
  const trimEnd = Math.min(mono.length, (lastActiveWindow + 1) * trimWindowSize + paddingSamples);
  let trimmed = mono.subarray(trimStart, trimEnd);

  // 4. Compress long internal pauses (tuning, discussion between the
  // announcement and the piece) while keeping every speech region intact.
  const silenceRunLimit = Math.round(maxInternalSilenceSec * outputRate);
  const silenceKeep = Math.round(keptInternalSilenceSec * outputRate);
  const pieces: Float32Array[] = [];
  let pendingSilence: Float32Array[] = [];
  let pendingSilenceSamples = 0;

  const flushSilenceRun = (): void => {
    if (pendingSilenceSamples === 0) {
      return;
    }

    if (pendingSilenceSamples <= silenceRunLimit) {
      pieces.push(...pendingSilence);
    } else {
      let kept = 0;
      for (const piece of pendingSilence) {
        if (kept >= silenceKeep) {
          break;
        }
        const take = Math.min(piece.length, silenceKeep - kept);
        pieces.push(piece.subarray(0, take));
        kept += take;
      }
    }

    pendingSilence = [];
    pendingSilenceSamples = 0;
  };

  for (let i = 0; i < trimmed.length; i += trimWindowSize) {
    const end = Math.min(i + trimWindowSize, trimmed.length);
    let sum = 0;
    for (let j = i; j < end; j++) {
      sum += trimmed[j] * trimmed[j];
    }
    const isActive = Math.sqrt(sum / (end - i)) > trimThresholdRms;

    if (isActive) {
      flushSilenceRun();
      pieces.push(trimmed.subarray(i, end));
    } else {
      pendingSilence.push(trimmed.subarray(i, end));
      pendingSilenceSamples += end - i;
    }
  }
  flushSilenceRun();

  const compressedLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
  let compressed = new Float32Array(compressedLength);
  let offset = 0;
  for (const piece of pieces) {
    compressed.set(piece, offset);
    offset += piece.length;
  }

  // 5. Safety cap for extremely long gaps; keep the tail when exceeded.
  const maxSamples = Math.round(maxDurationSec * outputRate);
  if (compressed.length > maxSamples) {
    compressed = compressed.subarray(compressed.length - maxSamples);
  }
  trimmed = compressed;

  // 6. Peak-normalize so faint speech reaches a usable level.
  let peak = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const magnitude = Math.abs(trimmed[i]);
    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  if (peak <= 0) {
    return null;
  }

  const gain = targetPeak / peak;
  const normalized = new Float32Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i++) {
    normalized[i] = Math.max(-1, Math.min(1, trimmed[i] * gain));
  }

  return { samples: normalized, sampleRate: outputRate };
}

/**
 * Creates a 16-bit PCM WAV byte stream from Float32 channel buffers.
 * Platform-agnostic: returns bytes, not a Blob, so Node/Bun can write it to disk.
 */
export function createWavBytes(channelsData: Float32Array[], sampleRate: number): Uint8Array {
  const numChannels = channelsData.length;
  const numSamples = channelsData[0].length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;
  
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);
  
  // 1. RIFF Header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  
  // 2. "fmt " Subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk size (16 for PCM)
  view.setUint16(20, 1, true); // Audio format (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // Byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  
  // 3. "data" Subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  
  // Write PCM Samples
  let byteOffset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = channelsData[c][i];
      // Convert float to Int16
      const intSample = Math.max(-32768, Math.min(32767, sample < 0 ? sample * 0x8000 : sample * 0x7fff));
      view.setInt16(byteOffset, intSample, true);
      byteOffset += 2;
    }
  }
  
  return new Uint8Array(arrayBuffer);
}

/**
 * Convenience wrapper for platforms with a Blob global (browser, Node 18+, Bun).
 */
export function createWavBlob(channelsData: Float32Array[], sampleRate: number): Blob {
  return bytesToBlob(createWavBytes(channelsData, sampleRate), 'audio/wav');
}

/**
 * Wraps bytes in a Blob. The cast isolates the TS 5.7+ Uint8Array<ArrayBufferLike>
 * vs BlobPart mismatch in one place; our arrays are always ArrayBuffer-backed.
 */
export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as unknown as BlobPart], { type });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
