// Regression coverage for #2982: supplied flag values must be validated rather
// than silently falling through to the command's default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(script, ...args) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `${script} failed to spawn: ${result.error?.message}`);
  assert.equal(result.signal, null, `${script} was killed by ${result.signal}`);
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const cases = [
  ['detect-reposts.mjs', ['--window', '--summary'], '--window'],
  ['detect-reposts.mjs', ['--window', 'abc'], '--window'],
  ['detect-reposts.mjs', ['--window', '-5'], '--window'],
  ['detect-reposts.mjs', ['--window=abc'], '--window'],
  ['process-quality.mjs', ['--min-threshold', 'abc'], '--min-threshold'],
  ['process-quality.mjs', ['--min-threshold', '3.5'], '--min-threshold'],
  ['process-quality.mjs', ['--min-threshold', '9007199254740993'], '--min-threshold'],
  ['process-quality.mjs', ['--file'], '--file'],
  ['weekly-digest.mjs', ['--dir'], '--dir'],
];

for (const [script, args, flag] of cases) {
  test(`${script} rejects unusable value for ${flag}`, () => {
    const result = run(script, ...args);
    assert.equal(result.status, 2, `${script} ${args.join(' ')} exited ${result.status}, want 2`);
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(result.output, new RegExp(escapedFlag));
    assert.match(result.output, /requires/);
  });
}

test('detect-reposts accepts a valid positive window', () => {
  const result = run('detect-reposts.mjs', '--window', '60');
  assert.equal(result.status, 0, result.output);
  const report = JSON.parse(result.stdout);
  assert.equal(report.metadata.windowDays, 60);
});

test('detect-reposts accepts the --window=value spelling', () => {
  const result = run('detect-reposts.mjs', '--window=60');
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(result.stdout).metadata.windowDays, 60);
});

test('process-quality accepts zero as a meaningful threshold', () => {
  const result = run('process-quality.mjs', '--min-threshold', '0');
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(result.stdout).metadata.minThreshold, 0);
});

test('weekly-digest rejects an invalid date instead of widening the range', () => {
  const result = run('weekly-digest.mjs', '--from', '2026-02-30', '--to', '2026-03-01');
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /--from/);
});

test('value validation happens before --help for malformed value flags', () => {
  const result = run('detect-reposts.mjs', '--window', '--help');
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /--window requires a value/);
});
