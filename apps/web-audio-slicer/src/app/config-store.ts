import { InjectionToken } from '@angular/core';
import type { ConfigStore } from '@web-audio-tools/audio-core';

/**
 * localStorage-backed ConfigStore. Degrades to a no-op store when localStorage
 * is unavailable (SSR, tests, blocked storage) so the app never crashes on it.
 */
export class LocalStorageConfigStore implements ConfigStore {
  public get(key: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  public set(key: string, value: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage full or blocked; settings stay in memory for this session.
    }
  }

  public remove(key: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }
}

/** The persistence seam; tests provide an in-memory store instead. */
export const CONFIG_STORE = new InjectionToken<ConfigStore>('ConfigStore', {
  providedIn: 'root',
  factory: () => new LocalStorageConfigStore()
});