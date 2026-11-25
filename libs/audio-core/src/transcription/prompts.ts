/**
 * Pure prompt builders and text normalizers. No platform dependencies.
 */
import {
  TRANSCRIPTION_LANGUAGE_OPTIONS,
  type TranscriptionLanguageCode,
  type TranscriptionLanguageOption
} from '../types';

export function getLanguageOption(language: TranscriptionLanguageCode): TranscriptionLanguageOption {
  return TRANSCRIPTION_LANGUAGE_OPTIONS.find(option => option.value === language)
    ?? TRANSCRIPTION_LANGUAGE_OPTIONS[0];
}

export function isTranscriptionLanguageCode(value: string | null): value is TranscriptionLanguageCode {
  return TRANSCRIPTION_LANGUAGE_OPTIONS.some(option => option.value === value);
}

export function buildTranscriptionInstruction(language: TranscriptionLanguageCode): string {
  return [
    'Transcribe the spoken audio in this gap from an ensemble rehearsal, before a piece of music is played.',
    'Someone may announce the name of the piece, its composer, movement, or opus/catalog number some time before it is played. Pay attention to those announcements.',
    'Transcribe speech verbatim; do not summarize, describe the audio, or add commentary.',
    getTranscriptionLanguageInstruction(language),
    'Return only the transcript text.',
    'If there is no intelligible speech, return an empty string.'
  ].join(' ');
}

export function buildTitleExtractionInstruction(rawText: string, language: TranscriptionLanguageCode): string {
  const languageInstruction = language === 'auto'
    ? 'The transcript may be in any language. Preserve artist names, song titles, and any summary text in the transcript\'s original language and script. Do not translate to English.'
    : `The transcript is expected to be in ${getLanguageOption(language).promptLabel}. Preserve artist names, song titles, and any summary text in ${getLanguageOption(language).promptLabel} when possible. Do not translate to English.`;

  return [
    'This transcript was captured from speech during an ensemble rehearsal, before a piece of music was played.',
    'Extract a concise MP3 title for the piece that follows.',
    'Prefer the format "Composer - Piece Title" for classical music, or "Artist - Song Title" otherwise.',
    'Preserve any movement numbers, opus or catalog numbers, and keys mentioned (e.g. "Symphony No. 5 in C minor, Op. 67").',
    'If only the piece title or composer is clear, return that.',
    'If no title is mentioned, return a short 2-5 word summary.',
    languageInstruction,
    `Transcript: "${rawText}"`
  ].join(' ');
}

function getTranscriptionLanguageInstruction(language: TranscriptionLanguageCode): string {
  if (language === 'auto') {
    return 'Automatically detect the spoken language and return the transcript in that same language and script. Do not translate to English.';
  }

  return `The expected spoken language is ${getLanguageOption(language).promptLabel}. Return the transcript in ${getLanguageOption(language).promptLabel}. Do not translate it to English.`;
}

export function normalizeModelText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ');
}

export function replaceControlCharacters(value: string): string {
  let normalized = '';
  for (const character of value) {
    normalized += character.charCodeAt(0) <= 0x1f ? ' ' : character;
  }
  return normalized;
}

export function normalizeTitle(title: string): string {
  const cleaned = replaceControlCharacters(title)
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  return cleaned.length > 120 ? cleaned.slice(0, 117).trimEnd() + '...' : cleaned;
}

export function fallbackRegexExtraction(text: string): string {
  const clean = text.replace(/[\n\r]+/g, ' ').trim();
  if (clean.length > 50) {
    return clean.substring(0, 47) + '...';
  }
  return clean;
}

/**
 * Detects model meta-responses ("there is no speech", "I cannot transcribe...")
 * that describe the audio instead of transcribing it.
 */
export function isLikelyNonTranscript(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return true;
  }

  const metaResponsePatterns = [
    /^(there is|there s) (no|nothing|not)\b/,
    /^no (speech|spoken|audio|intelligible|words|voice|discernible)\b/,
    /^(i m sorry|i cannot|i can t|i am unable|sorry)\b/,
    /^(unable|cannot) to (transcribe|hear|detect|understand)\b/,
    /^the (audio|recording|clip|file) (is|contains|does|appears|sounds)\b/,
    /^(this|it) (is|sounds|appears) (silent|silence|inaudible|quiet|empty|music|instrumental)\b/,
    /^(silence|silent|inaudible|unintelligible|no speech)$/
  ];

  return metaResponsePatterns.some(pattern => pattern.test(normalized));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Platform-agnostic base64 encoder over bytes (no Buffer/btoa dependency). */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    result += BASE64_ALPHABET[b0 >> 2];
    result += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
  }
  return result;
}