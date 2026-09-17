#!/usr/bin/env node
/**
 * analyze-patterns.mjs — Rejection Pattern Detector for career-ops
 *
 * Parses applications.md + all linked reports, extracts dimensions
 * (archetype, seniority, remote, gaps, scores), classifies outcomes,
 * and outputs structured JSON with actionable patterns.
 *
 * Run: node analyze-patterns.mjs          (JSON to stdout)
 *      node analyze-patterns.mjs --summary (human-readable table)
 *      node analyze-patterns.mjs --min-threshold 3
 *      node analyze-patterns.mjs --min-vendor-n 8   (per-vendor sample floor)
 *      node analyze-patterns.mjs --self-test
 */

import { readFileSync, existsSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './lib/is-main-module.mjs';
import { load as yamlLoad } from 'js-yaml';
import { resolveColumns, parseTrackerRow, normalizeVia } from './tracker-parse.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';

const CAREER_OPS = getCareerOpsRoot();
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const REPORTS_DIR = join(CAREER_OPS, 'reports');

const MACHINE_SUMMARY_FIELDS = new Set([
  'company',
  'role',
  'score',
  'legitimacy_tier',
  'archetype',
  'final_decision',
  'hard_stops',
  'soft_gaps',
  'top_strengths',
  'risk_level',
  'confidence',
  'next_action',
  // Optional context fields accepted for future reports.
  'domain',
  'seniority',
  'remote',
  'team_size',
  // Issue 1380: predicted skip/discard reasons from the agent.
  'discard_reasons',
  'advertised_comp',
  'via',
  'company_confidential',
  'risk_summary',
  // Work-authorization / visa-sponsorship tier from Block A (report + Machine
  // Summary only). Allowlisted so it round-trips; no consumer logic yet.
  'work_auth',
  // Reporting line stated by the JD, verbatim (report + Machine Summary only).
  // Allowlisted so it round-trips; no consumer logic yet.
  'reports_to',
  // Block B's requirement -> importance table, mirrored row by row (evidence
  // tier, importance band, match). Allowlisted so it round-trips; no consumer
  // logic yet, deliberately: importance is score-neutral, so nothing that folds
  // historical scores may start reading it without its own design pass.
  'requirement_importance',
]);

const args = process.argv.slice(2);

const KNOWN_FLAGS = ['--min-threshold', '--min-vendor-n', '--self-test', '--summary', '--help', '-h'];
const VALUE_FLAGS = ['--min-threshold', '--min-vendor-n'];
const USAGE = `Usage:
  node analyze-patterns.mjs                       # analyze application patterns as JSON
  node analyze-patterns.mjs --summary             # print a human-readable summary
  node analyze-patterns.mjs --min-threshold <n>   # minimum submitted applications required (default: 5)
  node analyze-patterns.mjs --min-vendor-n <n>    # minimum sample per vendor/channel (default: 8)
  node analyze-patterns.mjs --self-test           # run the built-in consistency checks
  node analyze-patterns.mjs --help                # show this message`;

// --- CLI args ---
const summaryMode = args.includes('--summary');
const MIN_THRESHOLD = (() => {
  const raw = flagValue(args, '--min-threshold');
  if (raw === undefined) return 5;

  const value = parseInt(raw, 10);
  return Number.isNaN(value) ? 5 : value;
})();

const MIN_VENDOR_N = (() => {
  const raw = flagValue(args, '--min-vendor-n');
  if (raw === undefined) return 8;

  const value = parseInt(raw, 10);
  return Number.isNaN(value) || value < 1 ? 8 : value;
})();

// --- Status normalization (mirrors verify-pipeline.mjs) ---
const ALIASES = {
  'evaluada': 'evaluated', 'condicional': 'evaluated', 'hold': 'evaluated',
  'evaluar': 'evaluated', 'verificar': 'evaluated',
  'aplicado': 'applied', 'enviada': 'applied', 'aplicada': 'applied',
  'applied': 'applied', 'sent': 'applied',
  'respondido': 'responded',
  'entrevista': 'interview',
  'oferta': 'offer',
  'rechazado': 'rejected', 'rechazada': 'rejected',
  'contratado': 'hired', 'contratada': 'hired', 'accepted': 'hired', 'accept': 'hired',
  'descartado': 'discarded', 'descartada': 'discarded',
  'cerrada': 'discarded', 'cancelada': 'discarded',
  'no aplicar': 'skip', 'no_aplicar': 'skip', 'monitor': 'skip', 'geo blocker': 'skip',
};

function normalizeStatus(raw) {
  const clean = raw.replace(/\*\*/g, '').trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  return ALIASES[clean] || clean;
}

export function classifyOutcome(status) {
  const s = normalizeStatus(status);
  // 'hired' is the strongest positive outcome — a landed job. It must not fall
  // through to the 'pending' default, which would drag conversion rates down.
  if (['hired', 'interview', 'offer', 'responded'].includes(s)) return 'positive';
  // 'applied' is SENT, not answered: denominator only, never the numerator.
  // Mirrors ADVANCED_STATUSES, which already excludes it.
  if (s === 'applied') return 'awaiting';
  if (s === 'rejected') return 'negative';
  // Withdrawn by the candidate or the posting died: neither a submission the
  // canonical funnel counts (stats.mjs) nor an employer decision.
  if (s === 'discarded') return 'discarded';
  if (s === 'skip') return 'self_filtered';
  return 'pending'; // evaluated
}

// PLACEHOLDER_REST_OF_FILE_TOO_LARGE_FOR_SINGLE_CALL
