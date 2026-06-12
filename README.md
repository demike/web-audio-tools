# Web Audio Tools

This workspace contains a browser-only Angular app that slices large WAV files into MP3 tracks without a Node server.

## What it does

- Streams WAV input with the File API and parses PCM incrementally instead of loading the whole file into memory.
- Detects song regions by watching dB level transitions between `SILENCE` and `SONG` windows.
- Encodes each detected song to MP3 in a Web Worker with `lamejs`.
- Transcribes quiet intro gaps and uses the text before each song to name the next MP3 file.
- Exposes track and segment state to compatible browser agents through WebMCP.

## AI strategy

- Primary path: Chrome Prompt API for on-device audio transcription and title extraction.
- Fallback path: Gemini API when the user provides an API key.
- No mock transcript fallback: if neither provider is available, tracks are still sliced and exported, but silent-gap transcription will fail and titles stay generic.

## Why not ffmpeg.wasm

`ffmpeg.wasm` is useful when you need broad codec support or exact FFmpeg parity. This app only needs streamed WAV parsing plus MP3 encoding, so a custom WAV stream parser and a lightweight MP3 worker keep memory use lower and the bundle simpler for a serverless deployment.

## Run it

```sh
npx nx serve web-audio-slicer
```

```sh
npx nx build web-audio-slicer
```

The production bundle is emitted to `dist/apps/web-audio-slicer` and can be hosted as static files.

## Browser notes

- Large WAV files are processed incrementally, but quiet gaps still need to be buffered temporarily for transcription.
- Prompt API audio support depends on the local Chrome build and device capabilities.
- WebMCP registration is optional and activates only when the browser exposes a model context API.
