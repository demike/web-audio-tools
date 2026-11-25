import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTitleExtractionInstruction,
  buildTranscriptionInstruction,
  fallbackRegexExtraction,
  isLikelyNonTranscript,
  normalizeModelText,
  normalizeTitle
} from './transcription/prompts';
import { Transcriber } from './transcription/transcriber';
import { MusicBrainzClient } from './transcription/musicbrainz';
import type { AudioModel, TextModel } from './transcription/models';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('text normalizers', () => {
  it('normalizeModelText strips wrapping quotes and collapses whitespace', () => {
    expect(normalizeModelText('  "Hello   world"  ')).toBe('Hello world');
    expect(normalizeModelText(42)).toBe('');
  });

  it('normalizeTitle removes slashes/control chars and truncates long titles', () => {
    expect(normalizeTitle('A/B\\C')).toBe('A B C');
    const long = 'x'.repeat(200);
    expect(normalizeTitle(long).length).toBeLessThanOrEqual(120);
    expect(normalizeTitle('   ')).toBe('');
  });

  it('fallbackRegexExtraction truncates long text', () => {
    expect(fallbackRegexExtraction('short')).toBe('short');
    expect(fallbackRegexExtraction('y'.repeat(80)).endsWith('...')).toBe(true);
  });

  it('isLikelyNonTranscript flags meta-responses but not real speech', () => {
    expect(isLikelyNonTranscript('There is no speech in this audio.')).toBe(true);
    expect(isLikelyNonTranscript('I cannot transcribe this.')).toBe(true);
    expect(isLikelyNonTranscript('The audio is silent.')).toBe(true);
    expect(isLikelyNonTranscript('')).toBe(true);
    expect(isLikelyNonTranscript('Okay everyone, lets play the Beethoven.')).toBe(false);
  });
});

describe('prompt builders', () => {
  it('describe the rehearsal context and preserve language', () => {
    const transcript = buildTranscriptionInstruction('de');
    expect(transcript).toContain('ensemble rehearsal');
    expect(transcript).toContain('German');
    const title = buildTitleExtractionInstruction('some text', 'auto');
    expect(title).toContain('Composer - Piece Title');
    expect(title).toContain('some text');
  });
});

describe('Transcriber', () => {
  const fakeAudio = (result: string | null): AudioModel => ({
    transcribe: async () => result
  });
  const fakeText = (result: string | null): TextModel => ({
    complete: async () => result
  });
  const fakeMusicBrainz = (title: string | null): MusicBrainzClient =>
    ({ findTitle: async () => title }) as unknown as MusicBrainzClient;

  it('reports no provider without an audio model', async () => {
    const t = new Transcriber({ getLanguage: () => 'auto' });
    expect(await t.hasProvider()).toBe(false);
    expect(await t.transcribeAudio(new Uint8Array(10), 16000)).toBeNull();
  });

  it('normalizes transcripts and filters meta-responses to empty', async () => {
    const t = new Transcriber({ audioModel: fakeAudio('  "Hello  world"  '), getLanguage: () => 'auto' });
    expect(await t.transcribeAudio(new Uint8Array(10), 16000)).toBe('Hello world');

    const meta = new Transcriber({ audioModel: fakeAudio('There is no speech.'), getLanguage: () => 'auto' });
    expect(await meta.transcribeAudio(new Uint8Array(10), 16000)).toBe('');
  });

  it('returns null when the audio model cannot run', async () => {
    const t = new Transcriber({ audioModel: fakeAudio(null), getLanguage: () => 'auto' });
    expect(await t.transcribeAudio(new Uint8Array(10), 16000)).toBeNull();
  });

  it('prefers a MusicBrainz-verified title (metadata source)', async () => {
    const t = new Transcriber({
      textModel: fakeText('Beethoven - Quartet'),
      musicBrainz: fakeMusicBrainz('Ludwig van Beethoven - String Quartet No. 14'),
      getLanguage: () => 'auto'
    });
    const result = await t.extractSongTitle('beethoven quartet');
    expect(result).toEqual({ title: 'Ludwig van Beethoven - String Quartet No. 14', source: 'metadata' });
  });

  it('falls back to the model candidate when MusicBrainz has no match', async () => {
    const t = new Transcriber({
      textModel: fakeText('Beethoven - Quartet'),
      musicBrainz: fakeMusicBrainz(null),
      getLanguage: () => 'auto'
    });
    const result = await t.extractSongTitle('beethoven quartet');
    expect(result).toEqual({ title: 'Beethoven - Quartet', source: 'transcription' });
  });

  it('uses a regex fallback when no text model is available', async () => {
    const t = new Transcriber({ musicBrainz: fakeMusicBrainz(null), getLanguage: () => 'auto' });
    const result = await t.extractSongTitle('  A short phrase  ');
    expect(result?.title).toBe('A short phrase');
    expect(result?.source).toBe('transcription');
  });

  it('returns null for empty input', async () => {
    const t = new Transcriber({ getLanguage: () => 'auto' });
    expect(await t.extractSongTitle('   ')).toBeNull();
  });
});

describe('MusicBrainzClient', () => {
  function stubFetch(responder: (url: string) => unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => responder(url)
    })));
  }

  it('searches works before recordings', async () => {
    stubFetch(url => url.includes('/work')
      ? { works: [{ title: 'Work Title', score: 100 }] }
      : { recordings: [{ title: 'Recording Title', score: 100, 'artist-credit': [{ name: 'Artist' }] }] });

    const title = await new MusicBrainzClient().findTitle('Some Candidate');
    expect(title).toBe('Work Title');
  });

  it('falls back to a recording with artist credit when no work matches', async () => {
    stubFetch(url => url.includes('/work')
      ? { works: [{ title: 'Weak', score: 40 }] }
      : { recordings: [{ title: 'Recording Title', score: 100, 'artist-credit': [{ name: 'Artist' }] }] });

    const title = await new MusicBrainzClient().findTitle('Some Candidate');
    expect(title).toBe('Artist - Recording Title');
  });

  it('ignores matches below the score threshold', async () => {
    stubFetch(() => ({ works: [{ title: 'Weak', score: 50 }], recordings: [{ title: 'Weak', score: 50 }] }));
    const title = await new MusicBrainzClient().findTitle('Some Candidate');
    expect(title).toBeNull();
  });
});