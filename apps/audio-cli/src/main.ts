/**
 * CLI entry point. The logic lives in cli.ts (side-effect-free, testable).
 *
 *   bun apps/audio-cli/src/main.ts rehearsal.wav --out ./tracks
 *   node dist/apps/audio-cli/main.js rehearsal.wav --out ./tracks
 */
import { runCli } from './cli';

runCli(process.argv.slice(2), process.env).catch(error => {
  console.error('audio-cli failed:', error);
  process.exitCode = 1;
});