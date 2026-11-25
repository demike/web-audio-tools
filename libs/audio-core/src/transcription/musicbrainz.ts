/**
 * MusicBrainz metadata client. Verifies a clean title candidate against known
 * works (classical/concert repertoire first) and recordings. Uses fetch and
 * timers only, so it runs in the browser, Node, and Bun.
 */
import { normalizeModelText, normalizeTitle, replaceControlCharacters } from './prompts';

interface MusicBrainzRecording {
  score?: number | string;
  title?: string;
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
}

interface MusicBrainzWork {
  score?: number | string;
  title?: string;
  type?: string;
}

export class MusicBrainzClient {
  private lookupQueue: Promise<void> = Promise.resolve();
  private lastLookupAt = 0;

  /** Returns a canonical "Artist - Title" (or work title) when a strong match exists. */
  public async findTitle(candidate: string): Promise<string | null> {
    for (const query of this.buildSearchQueries(candidate)) {
      const workTitle = await this.lookupWorkTitle(query);
      if (workTitle) {
        return workTitle;
      }

      const recordingTitle = await this.lookupRecordingTitle(query);
      if (recordingTitle) {
        return recordingTitle;
      }
    }

    return null;
  }

  private buildSearchQueries(rawText: string): string[] {
    const normalized = replaceControlCharacters(rawText)
      .replace(/["'`]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return [];
    }

    const filteredTokens = normalized
      .split(/\s+/)
      .filter(token => !this.isLikelyPresenterFiller(token));
    const compactQuery = filteredTokens.slice(0, 14).join(' ').trim();
    const bySplit = normalized.split(/\s+by\s+/i).map(part => part.trim()).filter(Boolean);
    const dashSplit = normalized.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    const dashJoined = dashSplit.join(' ');

    return Array.from(new Set([
      normalized.slice(0, 160),
      dashJoined,
      compactQuery,
      ...bySplit,
      ...dashSplit
    ].filter(query => query.length >= 4)));
  }

  private isLikelyPresenterFiller(token: string): boolean {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    return new Set([
      'again', 'and', 'coming', 'everyone', 'everybody', 'gonna', 'heard', 'here',
      'intro', 'just', 'let', 'lets', 'listen', 'listening', 'next', 'now', 'ok',
      'okay', 'play', 'playing', 'please', 'radio', 'ready', 'rehearsal', 'shall',
      'so', 'song', 'that', 'the', 'this', 'track', 'uh', 'um', 'up', 'us', 'was',
      'well', 'were', 'will', 'with', 'you', 'your'
    ]).has(normalized);
  }

  private async lookupRecordingTitle(query: string): Promise<string | null> {
    const data = await this.fetchJson<{ recordings?: MusicBrainzRecording[] }>('recording', query);
    const match = data.recordings?.find(recording => this.getScore(recording.score) >= 95);
    if (!match?.title) {
      return null;
    }

    const artistName = this.formatArtistCredit(match['artist-credit']);
    return artistName
      ? normalizeTitle(`${artistName} - ${match.title}`)
      : normalizeTitle(match.title);
  }

  private async lookupWorkTitle(query: string): Promise<string | null> {
    const data = await this.fetchJson<{ works?: MusicBrainzWork[] }>('work', query);
    const match = data.works?.find(work => this.getScore(work.score) >= 95);
    return match?.title ? normalizeTitle(match.title) : null;
  }

  private async fetchJson<T>(entityType: 'recording' | 'work', query: string): Promise<T> {
    return this.runRateLimited(async () => {
      const url = new URL(`https://musicbrainz.org/ws/2/${entityType}`);
      url.searchParams.set('query', query);
      url.searchParams.set('fmt', 'json');
      url.searchParams.set('limit', '5');
      url.searchParams.set('dismax', 'true');

      const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        if (response.status === 503) {
          return {} as T;
        }
        throw new Error(`MusicBrainz lookup failed: ${response.status}`);
      }

      return await response.json() as T;
    });
  }

  private async runRateLimited<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lookupQueue.then(async () => {
      const waitMs = Math.max(0, 1100 - (Date.now() - this.lastLookupAt));
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
      try {
        return await operation();
      } finally {
        this.lastLookupAt = Date.now();
      }
    });

    this.lookupQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private getScore(value: number | string | undefined): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private formatArtistCredit(credits: MusicBrainzRecording['artist-credit']): string | null {
    if (!credits || credits.length === 0) {
      return null;
    }
    const names = credits
      .map(credit => credit.name ?? credit.artist?.name ?? '')
      .map(name => normalizeModelText(name))
      .filter(Boolean);
    return names.length > 0 ? names.join(' ') : null;
  }
}