// tests/cli-flag-validation.test.mjs — CLIs must reject a mistyped flag
// instead of answering from their defaults (#2980).
//
// The failure class lib/cli-flags.mjs exists to end: an unrecognized flag is
// ignored, the value flag it was meant to be falls back to its default, and
// the script reports a result for inputs nobody asked for at exit 0. Already
// fixed in scan-ats-full.mjs (#1633/#1635), reply-watch.mjs (#2743/#2745),
// dedup-tracker.mjs (#2744/#2746), scan.mjs (#2270), doctor.mjs (#2874),
// fix-slugs.mjs (#2980), and application-artifacts.mjs (#2774).
//
// HERMETIC: paths use tmpdir fixtures; nothing reads or writes the real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function runScript(script, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  assert.equal(r.error, undefined, `${script} failed to spawn: ${r.error?.message}`);
  assert.equal(r.signal, null, `${script} was killed by ${r.signal} (timeout?)`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
