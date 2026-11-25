# Settings persisted as a single versioned document

Settings (slicer parameters, transcription language, transcribe-speech-gaps-on-start) are persisted as one versioned JSON document under a single localStorage key, written through the core's `ConfigStore` port, rather than one key per setting. A single document makes reset-to-defaults atomic and gives future schema changes one version number to migrate; per-key storage would scatter both. The apiKey deliberately stays in its own pre-existing key: it is a credential, not a preference, and keeping it separate is what lets reset-to-defaults preserve it. Once users have stored data, splitting or re-keying the document requires a migration, so this shape is hard to reverse.

## Consequences

- On load, each field is validated independently; invalid fields fall back to Defaults, and an unparseable document or a newer unknown version is discarded wholesale.
- The legacy `web_audio_slicer_transcription_language` key is migrated into the document on first load and then deleted.
- No multi-tab sync: last writer wins, and other tabs pick up changes on next load.