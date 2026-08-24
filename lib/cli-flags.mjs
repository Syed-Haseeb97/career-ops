/**
 * cli-flags.mjs — shared CLI argv helpers.
 *
 * Two related but distinct defects, both born from scripts hand-rolling their
 * own argv parsing and independently getting it wrong the same way:
 *
 * `args.indexOf('--flag')` returns -1 for `--flag=value`, so a lookup written
 * that way silently DISCARDS the value the caller supplied and the script runs
 * with its default instead — reporting a result for inputs nobody asked for,
 * with no warning. That is the defect #2401 described for weekly-digest
 * (`--from=…` digesting the wrong week) and #2402 fixed there and in
 * company-history.mjs. `flagValue`/`hasFlag` are the shared fix.
 *
 * An unrecognized or mistyped flag (`--dryrun` instead of `--dry-run`)
 * silently falls through to default/live behavior instead of failing fast —
 * fixed independently, in the identical shape, in scan-ats-full.mjs
 * (#1633/#1635), reply-watch.mjs (#2743/#2745) and dedup-tracker.mjs
 * (#2744/#2746). `validateFlags` is that shape in one place (#2775).
 */

export function flagValue(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const eq = args.find((a) => typeof a === 'string' && a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

export function hasFlag(args, flag) {
  if (!Array.isArray(args)) return false;
  return args.some((a) => typeof a === 'string' && (a === flag || a.startsWith(`${flag}=`)));
}

// These are the value shapes involved in #2982. Keeping the policy here means
// callers cannot silently drift back to parseInt()/default fallback behavior.
const POSITIVE_INTEGER_FLAGS = new Set(['--window', '--courtesy-days']);
const NON_NEGATIVE_INTEGER_FLAGS = new Set(['--min-threshold', '--min-span']);
const DATE_FLAGS = new Set(['--from', '--to', '--today', '--posted-after', '--posted-before']);

function failValue(flag, message) {
  console.error(`Error: ${flag} ${message}`);
  process.exit(2);
}

function validateValue(flag, value) {
  if (POSITIVE_INTEGER_FLAGS.has(flag) || NON_NEGATIVE_INTEGER_FLAGS.has(flag)) {
    if (!/^\d+$/.test(value)) failValue(flag, 'requires a valid integer value');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) failValue(flag, 'requires a safe integer value');
    if (POSITIVE_INTEGER_FLAGS.has(flag) && parsed < 1) failValue(flag, 'requires a positive integer value');
    return;
  }
  if (DATE_FLAGS.has(flag)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) failValue(flag, 'requires a YYYY-MM-DD value');
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      failValue(flag, 'requires a valid YYYY-MM-DD value');
    }
  }
}

export function validateFlags(args, knownFlags, usage, { valueFlags = [], requireOperand = false } = {}) {
  if (!Array.isArray(args)) return;

  const consumedValueIndices = new Set();
  args.forEach((a, idx) => {
    if (valueFlags.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumedValueIndices.add(idx + 1);
    }
  });

  const unknownFlags = args.filter((a, idx) => {
    if (typeof a !== 'string' || !a.startsWith('-') || consumedValueIndices.has(idx)) return false;
    const flag = a.split('=')[0];
    return !knownFlags.includes(flag) || (a.includes('=') && !valueFlags.includes(flag));
  });
  if (unknownFlags.length > 0) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${knownFlags.join(', ')}`);
    process.exit(1);
  }

  const missingOperand = args.filter((a, idx) => {
    if (typeof a !== 'string' || !valueFlags.includes(a)) return false;
    const next = args[idx + 1];
    return next === undefined || (typeof next === 'string' && next.startsWith('--'));
  });
  if (missingOperand.length > 0 || (requireOperand && missingOperand.length > 0)) {
    failValue(missingOperand[0], 'requires a value');
  }

  // Validate both --flag value and --flag=value spellings. Only the affected
  // value shapes are strict here; path/string operands remain arbitrary strings.
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== 'string') continue;
    let flag = null;
    let value = null;
    if (token.includes('=')) {
      flag = token.split('=')[0];
      value = token.slice(flag.length + 1);
    } else if (valueFlags.includes(token)) {
      flag = token;
      value = args[i + 1];
    }
    if (flag && value !== undefined && value !== null && value !== '' && valueFlags.includes(flag)) {
      validateValue(flag, String(value));
    } else if (flag && value === '' && valueFlags.includes(flag)) {
      failValue(flag, 'requires a value');
    }
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
}
