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
 * Parses a WAV file header from an ArrayBuffer.
 */
export function parseWavHeader(buffer: ArrayBuffer): WavHeader | null {
  const view = new DataView(buffer);
  
  if (view.byteLength < 44) return null;
  
  // Check "RIFF"
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') return null;
  
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
  
  // Scan chunks
  while (offset + 8 <= view.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const chunkSize = view.getUint32(offset + 4, true);
    
    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  
  if (sampleRate === 0 || channels === 0) return null;
  
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

      const parsed = parseWavHeader(combined.buffer.slice(combined.byteOffset, combined.byteOffset + Math.min(2048, combined.length)));
      if (!parsed) {
        // Not a valid WAV or need more header data
        if (combined.length > 2048) {
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

/**
 * Creates a WAV file Blob in memory from Float32 PCM channel buffers.
 */
export function createWavBlob(channelsData: Float32Array[], sampleRate: number): Blob {
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
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
