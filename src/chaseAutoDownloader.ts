import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { authenticate } from './auth';
import { discoverAccounts, listStatements, downloadStatement } from './chaseApi';
import {
  isCompletePdf,
  savePdf,
  formatError,
  processDocuments,
  type DownloadSummary,
} from './reliability';
import type { CreditCardAccount, DateFilter, DocRef } from './types';

function isHeadlessRun(): boolean {
  return process.env.HEADLESS === 'true';
}

function toDateFilter(yearOffset: number): DateFilter {
  if (yearOffset === 0) {
    return 'CURRENT_YEAR';
  }

  return `CURRENT_YEAR_MINUS_${yearOffset}` as DateFilter;
}

/** Translate the year offset or --bulk option into Chase’s relative year filters. */
export function getRequestedDateFilters(args: string[]): DateFilter[] {
  if (args.length === 0) {
    return ['CURRENT_YEAR'];
  }
  if (args.length !== 1) {
    throw new Error('Use one year offset (0–7) or --bulk, not multiple arguments.');
  }
  const [argument] = args;
  if (argument === '--bulk') {
    return Array.from({ length: 8 }, (_, yearOffset) => toDateFilter(yearOffset));
  }
  const value = argument.replace(/^--year=/, '');
  if (!/^\d+$/.test(value) || !Number.isInteger(Number(value)) || Number(value) > 7) {
    throw new Error('Year offset must be an integer from 0 through 7.');
  }
  return [toDateFilter(Number(value))];
}

/** Keep existing filenames unless multiple document IDs share the same date. */
export function getStatementFileName(doc: DocRef, accountMask: string, docs: DocRef[]): string {
  const safeDate = doc.documentDate.replace(/[^a-zA-Z0-9_-]/g, '_');
  const sameDateIds = new Set(
    docs
      .filter((other) => other.documentDate.replace(/[^a-zA-Z0-9_-]/g, '_') === safeDate)
      .map((other) => other.documentId),
  );
  const suffix =
    sameDateIds.size > 1 ? createHash('sha256').update(doc.documentId).digest('hex') : '';
  return `${safeDate}-statements-${accountMask}-${suffix}.pdf`;
}

/** Save statements by account, skipping complete PDFs and continuing after download or listing failures. */
async function archiveStatements(
  page: Page,
  context: BrowserContext,
  accounts: CreditCardAccount[],
  filters: DateFilter[],
  summary: DownloadSummary,
): Promise<void> {
  for (const { accountId, accountMask } of accounts) {
    // API-provided values must never become path separators.
    const safeMask = accountMask.replace(/[^a-zA-Z0-9_-]/g, '_');
    const accountDir = path.join(__dirname, '..', 'statements', `Chase-${safeMask}`);
    fs.mkdirSync(accountDir, { recursive: true });
    for (const filter of filters) {
      console.log(`📅 Account ${safeMask}: ${filter}`);
      let docs;
      try {
        docs = await listStatements(page, accountId, filter);
      } catch (error) {
        summary.periodFailures++;
        console.error(`❌ Cannot list ${safeMask}/${filter}: ${formatError(error)}`);
        continue;
      }
      if (docs.length === 0) {
        console.log('   No statements found.');
        continue;
      }
      await processDocuments(docs, summary, async (doc) => {
        const filePath = path.join(accountDir, getStatementFileName(doc, safeMask, docs));
        if (fs.existsSync(filePath) && isCompletePdf(fs.readFileSync(filePath))) {
          return 'skipped';
        }
        const pdf = await downloadStatement(page, context, accountId, filter, doc.documentId);
        savePdf(filePath, pdf);
        console.log(`✅ Saved ${path.basename(filePath)}`);
        return 'downloaded';
      });
    }
  }
}

/** Read the installed browser's user agent locally and use its Chrome identifier in headless mode. */
export async function createDownloadContext(
  browser: Browser,
  headless: boolean,
  options: BrowserContextOptions,
): Promise<BrowserContext> {
  if (!headless) {
    return browser.newContext(options);
  }
  const probe = await browser.newContext();
  let userAgent: string;
  try {
    const page = await probe.newPage();
    userAgent = await page.evaluate(() => navigator.userAgent);
  } finally {
    await probe.close();
  }
  return browser.newContext({
    ...options,
    userAgent: userAgent.replace(/HeadlessChrome\//g, 'Chrome/'),
  });
}

/** Manage the browser lifecycle and report incomplete runs with a nonzero exit status. */
async function run(): Promise<void> {
  const summary: DownloadSummary = { downloaded: 0, skipped: 0, failed: 0, periodFailures: 0 };
  const filters = getRequestedDateFilters(process.argv.slice(2));
  const stateFile = path.join(__dirname, '..', 'chase_session.json');
  const screenshotDir = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const headless = isHeadlessRun();
  const browser = await chromium.launch({ headless, channel: 'chromium' });
  let page: Page | undefined;
  let stage = 'browser setup';
  try {
    const options: BrowserContextOptions = fs.existsSync(stateFile)
      ? { storageState: stateFile }
      : {};
    const context = await createDownloadContext(browser, headless, options);
    page = await context.newPage();
    stage = 'authentication';
    await authenticate(page, context, stateFile, screenshotDir);
    stage = 'account discovery';
    const accounts = await discoverAccounts(page);
    stage = 'downloads';
    await archiveStatements(page, context, accounts, filters, summary);
  } catch (error) {
    process.exitCode = 1;
    console.error(`❌ ${formatError(error)}`);
    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'error_state.png') }).catch(() => {
        console.error('Could not capture error screenshot.');
      });
    }
  } finally {
    if (stage === 'downloads') {
      console.log(
        `Summary: ${summary.downloaded} downloaded, ${summary.skipped} skipped, ${summary.failed} failed; ${summary.periodFailures} account periods could not be listed.`,
      );
    } else {
      console.log(`Run aborted during ${stage}. No account periods were checked.`);
    }
    if (summary.failed || summary.periodFailures) {
      process.exitCode = 1;
    }
    await browser.close();
  }
}

if (require.main === module) {
  void run().catch((error) => {
    process.exitCode = 1;
    console.error(`❌ ${formatError(error)}`);
  });
}
