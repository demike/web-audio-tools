/* global lamejs */

try {
  importScripts('/lame.min.js');
} catch (primaryError) {
  try {
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js');
  } catch (fallbackError) {
    postMessage({
      event: 'error',
      error: `init: Failed to load lamejs (${String(primaryError)} / ${String(fallbackError)})`
    });
  }
}

let mp3Encoder = null;
let mp3Data = [];

self.addEventListener('message', ({ data }) => {
  try {
    const { command, payload } = data;

    if (command === 'init') {
      if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
        throw new Error('lamejs.Mp3Encoder is unavailable');
      }

      const { channels, sampleRate, bitrate } = payload;
      mp3Encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitrate || 128);
      mp3Data = [];
      postMessage({ event: 'initialized' });
      return;
    }

    if (command === 'encode') {
      if (!mp3Encoder) {
        postMessage({ event: 'error', error: 'encode: Encoder not initialized' });
        return;
      }

      const { channelsData } = payload;
      let mp3buf;

      if (channelsData.length === 1) {
        const monoInt16 = floatTo16BitPCM(channelsData[0]);
        mp3buf = mp3Encoder.encodeBuffer(monoInt16);
      } else {
        const leftInt16 = floatTo16BitPCM(channelsData[0]);
        const rightInt16 = floatTo16BitPCM(channelsData[1]);
        mp3buf = mp3Encoder.encodeBuffer(leftInt16, rightInt16);
      }

      if (mp3buf.length > 0) {
        mp3Data.push(new Uint8Array(mp3buf.buffer, mp3buf.byteOffset, mp3buf.length));
      }

      postMessage({ event: 'progress' });
      return;
    }

    if (command === 'finish') {
      if (!mp3Encoder) {
        postMessage({ event: 'error', error: 'finish: Encoder not initialized' });
        return;
      }

      const mp3buf = mp3Encoder.flush();
      if (mp3buf.length > 0) {
        mp3Data.push(new Uint8Array(mp3buf.buffer, mp3buf.byteOffset, mp3buf.length));
      }

      const blob = new Blob(mp3Data, { type: 'audio/mp3' });
      postMessage({ event: 'finished', blob });

      mp3Encoder = null;
      mp3Data = [];
      self.close();
    }
  } catch (error) {
    const commandName = typeof data?.command === 'string' ? data.command : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ event: 'error', error: `${commandName}: ${message}` });
  }
});

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}