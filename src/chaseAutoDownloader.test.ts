import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { savePdf } from './reliability';
import {
  createDownloadContext,
  getRequestedDateFilters,
  getStatementFileName,
} from './chaseAutoDownloader';

test('headless context uses the installed Chrome version and retains saved-session options', async () => {
  let closed = false;
  const calls: (BrowserContextOptions | undefined)[] = [];
  const context = {} as BrowserContext;
  const original =
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 HeadlessChrome/145.0.1234.0 Safari/537.36';
  const browser = {
    newContext: async (options?: BrowserContextOptions) => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          newPage: async () => ({ evaluate: async () => original }),
          close: async () => {
            closed = true;
          },
        };
      }
      assert.equal(closed, true);
      return context;
    },
  } as unknown as Browser;
  assert.equal(
    await createDownloadContext(browser, true, { storageState: 'session.json' }),
    context,
  );
  assert.deepEqual(calls, [
    undefined,
    {
      storageState: 'session.json',
      userAgent: original.replace('HeadlessChrome/', 'Chrome/'),
    },
  ]);
});

test('headed context keeps the default user agent and opens no probe', async () => {
  const calls: BrowserContextOptions[] = [];
  const browser = {
    newContext: async (options: BrowserContextOptions) => {
      calls.push(options);
      return {} as BrowserContext;
    },
  } as unknown as Browser;
  await createDownloadContext(browser, false, { storageState: 'session.json' });
  assert.deepEqual(calls, [{ storageState: 'session.json' }]);
});

test('user-agent probe is closed when reading the user agent fails', async () => {
  let closed = false;
  const browser = {
    newContext: async () => ({
      newPage: async () => ({
        evaluate: async () => {
          throw new Error('Probe failed');
        },
      }),
      close: async () => {
        closed = true;
      },
    }),
  } as unknown as Browser;
  await assert.rejects(createDownloadContext(browser, true, {}), /Probe failed/);
  assert.equal(closed, true);
});

test('CLI accepts only one valid year selector or bulk mode', () => {
  assert.deepEqual(getRequestedDateFilters([]), ['CURRENT_YEAR']);
  assert.deepEqual(getRequestedDateFilters(['0']), ['CURRENT_YEAR']);
  assert.deepEqual(getRequestedDateFilters(['--year=7']), ['CURRENT_YEAR_MINUS_7']);
  assert.equal(getRequestedDateFilters(['--bulk']).length, 8);
  for (const args of [
    ['-1'],
    ['--year='],
    ['typo'],
    ['8'],
    ['1.5'],
    ['1', '2'],
    ['--bulk', '1'],
    ['--bulk', '--invalid'],
  ]) {
    assert.throws(() => getRequestedDateFilters(args));
  }
});

test('same-date documents get separate files without trusting an ambiguous legacy PDF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chase-names-'));
  try {
    const docs = [
      { documentDate: '20261011', documentId: 'first/id' },
      { documentDate: '20261011', documentId: 'first_id' },
    ];
    const legacyName = getStatementFileName(docs[0], '1234', [docs[0]]);
    const legacy = Buffer.from('%PDF-1.7\nlegacy\n%%EOF\n');
    savePdf(path.join(dir, legacyName), legacy);
    const names = docs.map((doc) => getStatementFileName(doc, '1234', docs));
    assert.notEqual(names[0], names[1]);
    assert.equal(names.includes(legacyName), false);
    docs.forEach((doc, index) =>
      savePdf(path.join(dir, names[index]), Buffer.from(`%PDF-1.7\n${doc.documentId}\n%%EOF\n`)),
    );
    assert.equal(fs.readdirSync(dir).length, 3);
    assert.deepEqual(fs.readFileSync(path.join(dir, legacyName)), legacy);
    assert.notDeepEqual(
      fs.readFileSync(path.join(dir, names[0])),
      fs.readFileSync(path.join(dir, names[1])),
    );
    assert.equal(getStatementFileName(docs[0], '1234', [...docs].reverse()), names[0]);
    assert.equal(getStatementFileName(docs[0], '1234', [docs[0], docs[0]]), legacyName);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
