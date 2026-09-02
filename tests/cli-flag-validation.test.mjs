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
import { mkdtempSync, rmSync } from 'node:fs';
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

// Each script paired with a realistic typo of one of ITS OWN flags
const SCRIPTS = [
  ['fix-slugs.mjs', '--dryrun'],
  ['fix-slugs.mjs', '--fle'],
  ['linkedin-join.mjs', '--csvv'],
  ['linkedin-join.mjs', '--sinse'],
  ['application-artifacts.mjs', '--reprot'],
];

for (const [script, typo] of SCRIPTS) {
  test(`${script} rejects ${typo} instead of falling back to its default`, () => {
    const r = runScript(script, typo, 'some-value');
    assert.equal(r.status, 1, `${script} ${typo} exited ${r.status}, want 1`);
    assert.match(r.all, /unrecognized flag/i, `${script} did not name the unrecognized flag`);
    assert.ok(r.all.includes(typo), `${script} did not echo ${typo} back`);
  });
}


test('fix-slugs.mjs --help exits 0 and prints usage', () => {
  const r = runScript('fix-slugs.mjs', '--help');
  assert.equal(r.status, 0, `fix-slugs.mjs --help exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'fix-slugs.mjs --help printed no usage block');
});

test('fix-slugs.mjs -h exits 0 and prints usage', () => {
  const r = runScript('fix-slugs.mjs', '-h');
  assert.equal(r.status, 0, `fix-slugs.mjs -h exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'fix-slugs.mjs -h printed no usage block');
});

test('fix-slugs.mjs --help --bogus still errors', () => {
  const r = runScript('fix-slugs.mjs', '--help', '--bogus');
  assert.equal(r.status, 1, `fix-slugs.mjs --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});


test('application-artifacts.mjs --help exits 0 and prints usage', () => {
  const r = runScript('application-artifacts.mjs', '--help');
  assert.equal(r.status, 0, `application-artifacts.mjs --help exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'application-artifacts.mjs --help printed no usage block');
});

test('application-artifacts.mjs -h exits 0 and prints usage', () => {
  const r = runScript('application-artifacts.mjs', '-h');
  assert.equal(r.status, 0, `application-artifacts.mjs -h exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'application-artifacts.mjs -h printed no usage block');
});

test('application-artifacts.mjs --help --bogus still errors', () => {
  const r = runScript('application-artifacts.mjs', '--help', '--bogus');
  assert.equal(r.status, 1, `application-artifacts.mjs --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// --help must not reach the required-argument check: before #2774 the flag was
// swallowed by parseArgs's strict mode and reported as an unknown option.
test('application-artifacts.mjs --help wins over the missing-required-args error', () => {
  const r = runScript('application-artifacts.mjs', '--help');
  assert.doesNotMatch(r.all, /Unknown option/i, '--help was still treated as an unrecognized option');
});

test('fix-slugs rejects unknown flags before checking or reading portals file', () => {
  const r = runScript('fix-slugs.mjs', '--file', join(tmpdir(), 'non-existent-portals.yml'), '--unknown-flag');
  assert.equal(r.status, 1);
  assert.match(r.all, /unrecognized flag\\(s\\): --unknown-flag/);
  assert.doesNotMatch(r.all, /no portals file at/i);
});
