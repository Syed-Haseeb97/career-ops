import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import {
  processPipelineBatch,
  processOffer,
  PATHS,
  isLivenessGateDeadResponse,
  deadPipelineLine,
} from '../batch-evaluate-gemini.mjs';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

console.log('\nbatch-evaluate.test.mjs — processPipelineBatch and processOffer artifacts');

async function testProcessOffer() {
  const work = mkdtempSync(join(tmpdir(), 'cops-batcheval-'));
  const oldReports = PATHS.reports;
  const oldAdditions = PATHS.trackerAdditions;

  try {
    const reportsDir = join(work, 'reports');
    const additionsDir = join(work, 'tracker-additions');
    
    PATHS.reports = reportsDir;
    PATHS.trackerAdditions = additionsDir;
    
    process.env.CAREER_OPS_REPORTS_DIR = reportsDir;
    process.env.CAREER_OPS_TRACKER = join(work, 'applications.md');

    mkdirSync(work, { recursive: true });
    import('fs').then(fs => fs.writeFileSync(join(work, 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n'));

    const mockBrowser = {
      newPage: async () => ({
        url: () => 'https://example.com/job',
        route: async () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => 'Valid JD Text of sufficient length (more than 100 characters). '.repeat(5),
        close: async () => {}
      })
    };

    const mockEvaluate = async () => `
---SCORE_SUMMARY---
COMPANY: Acme Corp
ROLE: Senior Engineer
SCORE: 4.5
ARCHETYPE: Tech Lead
LEGITIMACY: High Confidence
---END_SUMMARY---
`;

    const inputLine = '- [ ] https://example.com/job | Acme Corp | Senior Engineer';
    const result = await processOffer(mockBrowser, inputLine, 1, mockEvaluate);

    if (result.processed && result.line === '- [x] https://example.com/job | Acme Corp | Senior Engineer') {
      pass('processOffer returns processed: true and marks the pipeline line with [x]');
    } else {
      fail(`processOffer returned unexpected result: ${JSON.stringify(result)}`);
    }

    const reports = readdirSync(reportsDir).filter(f => !f.includes('-RESERVED.md'));
    if (reports.length === 1 && reports[0].includes('acme-corp') && reports[0].endsWith('.md')) {
      pass(`processOffer writes a markdown report: ${reports[0]}`);
      const content = readFileSync(join(reportsDir, reports[0]), 'utf-8');
      if (content.includes('**Score:** 4.5')) {
        pass('report contains the correct score');
      } else {
        fail('report missing the score');
      }
    } else {
      fail(`processOffer report write failed: ${reports}`);
    }

    const additions = readdirSync(additionsDir);
    if (additions.length === 1 && additions[0].includes('acme-corp') && additions[0].endsWith('.tsv')) {
      pass(`processOffer emits a TSV row for the tracker: ${additions[0]}`);
      const tsv = readFileSync(join(additionsDir, additions[0]), 'utf-8');
      if (tsv.includes('Acme Corp\tSenior Engineer\tEvaluated\t4.5/5')) {
        pass('TSV row contains the correct evaluation data');
      } else {
        fail(`TSV row has wrong content: ${tsv}`);
      }
    } else {
      fail(`processOffer tracker TSV write failed: ${additions}`);
    }

  } finally {
    PATHS.reports = oldReports;
    PATHS.trackerAdditions = oldAdditions;
    delete process.env.CAREER_OPS_REPORTS_DIR;
    delete process.env.CAREER_OPS_TRACKER;
    rmSync(work, { recursive: true, force: true });
  }
}

async function testProcessPipelineBatch() {
  const pendingIndices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const concurrency = 4;
  let activeCount = 0;
  let maxActiveCount = 0;
  let processedCount = 0;

  const mockProcessorFn = async (lineIdx, runIdx) => {
    activeCount++;
    if (activeCount > maxActiveCount) {
      maxActiveCount = activeCount;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    processedCount++;
    activeCount--;
    return { line: `Processed ${lineIdx}`, processed: true };
  };

  await processPipelineBatch(pendingIndices, concurrency, mockProcessorFn);

  if (processedCount === 10) {
    pass('processPipelineBatch processes all items');
  } else {
    fail(`processPipelineBatch processed ${processedCount} instead of 10 items`);
  }

  if (maxActiveCount <= concurrency) {
    pass(`concurrency upper bound respected (max ${maxActiveCount} <= limit ${concurrency})`);
  } else {
    fail(`concurrency upper bound violated (max ${maxActiveCount} > limit ${concurrency})`);
  }

  if (maxActiveCount > 1) {
    pass(`concurrency lower bound respected (max ${maxActiveCount} > 1, did not serialize)`);
  } else {
    fail(`concurrency lower bound violated (max ${maxActiveCount} <= 1, execution serialized)`);
  }
}

function testLivenessGateDetection() {
  const realDead = `The job posting at the provided URL (**Product Manager - AI Platform (m/f/x)** at **Scalable GmbH**) has expired and is no longer accepting applications
> **Notice on page:** *"This job has expired / Sorry, this job has expired"*
Per the **Liveness Gate** rules, evaluation stops here before Block A. No evaluation, report, or CV customization will be generated for an expired posting.`;

  if (isLivenessGateDeadResponse(realDead)) {
    pass('isLivenessGateDeadResponse accepts the observed liveness-gate exit');
  } else {
    fail('isLivenessGateDeadResponse rejected a legitimate dead-posting response');
  }

  if (!isLivenessGateDeadResponse('I evaluated the role and the score is strong overall.')) {
    pass('isLivenessGateDeadResponse rejects ordinary prose without gate markers');
  } else {
    fail('isLivenessGateDeadResponse false-positived on ordinary prose');
  }

  if (!isLivenessGateDeadResponse('Per the Liveness Gate rules, evaluation continues to Block A.')) {
    pass('isLivenessGateDeadResponse rejects gate reference without dead signal');
  } else {
    fail('isLivenessGateDeadResponse false-positived on gate-only text');
  }

  if (!isLivenessGateDeadResponse('This job has expired and is no longer accepting applications.')) {
    pass('isLivenessGateDeadResponse rejects dead signal without gate reference');
  } else {
    fail('isLivenessGateDeadResponse false-positived on dead-signal-only text');
  }

  if (!isLivenessGateDeadResponse('')) {
    pass('isLivenessGateDeadResponse rejects empty input');
  } else {
    fail('isLivenessGateDeadResponse accepted empty input');
  }

  const expected = '- [x] ~~Acme Corp | Data Engineer~~ — oferta nieaktywna';
  if (deadPipelineLine('Acme Corp', 'Data Engineer') === expected) {
    pass('deadPipelineLine matches modes/oferta.md contract');
  } else {
    fail(`deadPipelineLine produced unexpected mark: ${deadPipelineLine('Acme Corp', 'Data Engineer')}`);
  }
}

async function testProcessOfferLivenessDead() {
  const work = mkdtempSync(join(tmpdir(), 'cops-batcheval-dead-'));
  const oldReports = PATHS.reports;
  const oldAdditions = PATHS.trackerAdditions;

  try {
    const reportsDir = join(work, 'reports');
    const additionsDir = join(work, 'tracker-additions');
    PATHS.reports = reportsDir;
    PATHS.trackerAdditions = additionsDir;
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(additionsDir, { recursive: true });

    const mockBrowser = {
      newPage: async () => ({
        url: () => 'https://example.com/expired-job',
        route: async () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => 'This job has expired. Sorry, this job has expired. '.repeat(10),
        close: async () => {}
      })
    };

    const deadResponse = `The job posting at the provided URL has expired and is no longer accepting applications.
Per the **Liveness Gate** rules, evaluation stops here before Block A. No evaluation, report, or CV will be generated for an expired posting.`;

    const mockEvaluate = async () => deadResponse;

    const inputLine = '- [ ] https://example.com/expired-job | Scalable Capital | Product Manager - AI Platform';
    const result = await processOffer(mockBrowser, inputLine, 1, mockEvaluate);

    const expectedLine = '- [x] ~~Scalable Capital | Product Manager - AI Platform~~ — oferta nieaktywna';
    if (result.processed === true && result.dead === true && result.line === expectedLine) {
      pass('processOffer treats liveness-gate dead posting as handled and marks pipeline inactive');
    } else {
      fail(`processOffer dead path unexpected result: ${JSON.stringify(result)}`);
    }

    const reports = existsSync(reportsDir) ? readdirSync(reportsDir).filter(f => !f.includes('-RESERVED.md')) : [];
    if (reports.length === 0) {
      pass('processOffer writes no report for a dead posting');
    } else {
      fail(`processOffer wrote unexpected reports for dead posting: ${reports}`);
    }

    const additions = existsSync(additionsDir) ? readdirSync(additionsDir) : [];
    if (additions.length === 0) {
      pass('processOffer writes no tracker TSV / CV path for a dead posting');
    } else {
      fail(`processOffer wrote unexpected tracker additions for dead posting: ${additions}`);
    }
  } finally {
    PATHS.reports = oldReports;
    PATHS.trackerAdditions = oldAdditions;
    rmSync(work, { recursive: true, force: true });
  }
}

async function testProcessOfferMissingSummaryStillFails() {
  const work = mkdtempSync(join(tmpdir(), 'cops-batcheval-miss-'));
  const oldReports = PATHS.reports;
  const oldAdditions = PATHS.trackerAdditions;

  try {
    const reportsDir = join(work, 'reports');
    const additionsDir = join(work, 'tracker-additions');
    PATHS.reports = reportsDir;
    PATHS.trackerAdditions = additionsDir;
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(additionsDir, { recursive: true });

    const mockBrowser = {
      newPage: async () => ({
        url: () => 'https://example.com/job',
        route: async () => {},
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async () => 'Valid JD Text of sufficient length (more than 100 characters). '.repeat(5),
        close: async () => {}
      })
    };

    const mockEvaluate = async () => 'I am not sure how to score this. Here is some free-form commentary only.';

    const inputLine = '- [ ] https://example.com/job | Acme Corp | Senior Engineer';
    const result = await processOffer(mockBrowser, inputLine, 1, mockEvaluate);

    if (result.processed === false && result.line === inputLine) {
      pass('processOffer still fails (processed: false) on unexpected missing SCORE_SUMMARY');
    } else {
      fail(`processOffer should have left the line unchecked on malformed output: ${JSON.stringify(result)}`);
    }

    const reports = existsSync(reportsDir) ? readdirSync(reportsDir).filter(f => !f.includes('-RESERVED.md')) : [];
    if (reports.length === 0) {
      pass('processOffer writes no report when SCORE_SUMMARY is missing and not a liveness exit');
    } else {
      fail(`processOffer wrote reports on malformed output: ${reports}`);
    }
  } finally {
    PATHS.reports = oldReports;
    PATHS.trackerAdditions = oldAdditions;
    rmSync(work, { recursive: true, force: true });
  }
}

async function run() {
  try {
    testLivenessGateDetection();
    await testProcessPipelineBatch();
    await testProcessOffer();
    await testProcessOfferLivenessDead();
    await testProcessOfferMissingSummaryStillFails();
  } catch (err) {
    fail(`batch-evaluate tests crashed: ${err.message}`);
  }
}

await run();
