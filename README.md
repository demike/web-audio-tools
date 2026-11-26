# Web Audio Tools

Slices large WAV files (e.g. ensemble rehearsal recordings) into MP3 tracks. The
slicing/transcription logic lives in a platform-agnostic core library shared by a
browser Angular app, a Node/Bun CLI, and a portable tool layer.

## Layout

- `libs/audio-core` — the shared core: WAV parsing, the SILENCE/SONG state machine,
  MP3 encoding, speech-gap preparation, transcription clients, and tool definitions.
  No Angular, DOM, Worker, or Node APIs; platform specifics are injected at seams.
- `apps/web-audio-slicer` — browser Angular app. Thin adapters over the core: a Web
  Worker MP3 encoder, File input, localStorage, object URLs, and the Chrome Prompt API.
- `apps/audio-cli` — Node/Bun CLI. Filesystem input/output, direct lamejs encoding,
  Gemini transcription, and a JSON manifest.

## What it does

- Streams WAV input and parses PCM incrementally instead of loading the whole file into memory.
- Processes split recordings as one continuous Recording: multiple WAV chunks
  (e.g. a Zoom recorder's 2 GB splits in separate date/time folders) are joined
  into a single timeline, so a piece spanning a split stays one track. A single
  file is just a one-chunk Recording — the same flow, no extra steps.
- Detects piece regions by watching dB level transitions between `SILENCE` and `SONG` windows.
- Encodes each detected piece to MP3 (Web Worker in the browser, lamejs directly in Node/Bun).
- Transcribes spoken announcements (someone naming the piece before it is played) and uses that text to name the next MP3 file.
- Captures short loud regions too: a spoken announcement above the silence threshold is transcribed instead of being discarded as a too-short track.
- Prepares gap audio for transcription: mono downmix, 16 kHz resample, silence trimming, long-pause compression, and peak normalization.
- Exposes the functionality to agents through WebMCP / portable tools, with the calling model doing transcription.

## AI strategy

- Browser: Chrome Prompt API for on-device transcription, falling back to the Gemini API when a key is provided.
- Node/Bun: Gemini API only (the Prompt API is Chrome-only). Without a key, tracks are still sliced and encoded, but titles stay generic.
- Tool layer: the calling model transcribes. `slice_wav` leaves prepared gap audio; the model fetches it (`get_gap_audio`), transcribes it itself, and names tracks with `set_track_title` (optionally canonicalized against MusicBrainz).
- No mock transcript fallback.

## Run the browser app

```sh
npx nx serve web-audio-slicer
npx nx build web-audio-slicer
```

The production bundle is emitted to `dist/apps/web-audio-slicer` and can be hosted as static files.

## Run the CLI (Node or Bun)

```sh
# Bun runs the TypeScript source directly
bun apps/audio-cli/src/main.ts rehearsal.wav --out ./tracks

# Or build once and run with Node
npx nx build audio-cli
node dist/apps/audio-cli/main.js rehearsal.wav --out ./tracks

# Split recordings: list the chunks in order, or point at directories.
# Here a Zoom card's date/time folders each hold a mic file and a mix;
# --match keeps only the mic files (TRASH/Export are always skipped).
node dist/apps/audio-cli/main.js /path/to/card --match '*_TrMic.WAV' --out ./tracks
```

Writes each piece as `<title>.mp3` plus a `manifest.json` of tracks, timings,
transcriptions, and the Recording's chunks (file names, sizes, start times).
Options: `--match`, `--threshold`, `--min-silence`, `--min-song`, `--bitrate`,
`--lang`, `--start-index`, `--no-transcribe`, `--gemini-key` (or `GEMINI_API_KEY`).

## Why not ffmpeg.wasm

`ffmpeg.wasm` is useful when you need broad codec support or exact FFmpeg parity. This app only needs streamed WAV parsing plus MP3 encoding, so a custom WAV stream parser and a lightweight MP3 encoder keep memory use lower and the bundle simpler for a serverless deployment.

## Browser notes

- Large WAV files are processed incrementally, but quiet gaps still need to be buffered temporarily for transcription.
- Multi-select, multi-file drop, and folder drop load a multi-chunk Recording; an
  optional folder filter (e.g. `TrMic`) picks one file per folder. Chunks sort
  naturally by file name and can be reordered before slicing.
- Prompt API audio support depends on the local Chrome build and device capabilities.
- WebMCP registration is optional and activates only when the browser exposes a model context API.
