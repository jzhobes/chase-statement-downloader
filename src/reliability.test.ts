import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseJsonResponse,
  parseMenu,
  parseStatements,
  parseDocKey,
  savePdf,
  isCompletePdf,
  formatError,
  processDocuments,
} from './reliability';

const pdf = Buffer.from('%PDF-1.7\nexample\n%%EOF\n');

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chase-test-'));
}

test('HTTP failures and invalid JSON never become empty results or leak response bodies', async () => {
  await assert.rejects(
    parseJsonResponse({ ok: () => false, status: () => 401, json: async () => ({}) }, 'List'),
    /HTTP 401/,
  );
  await assert.rejects(
    parseJsonResponse(
      {
        ok: () => true,
        status: () => 200,
        json: async () => {
          throw new Error('secret response');
        },
      },
      'List',
    ),
    /^Error: List returned invalid JSON\.$/,
  );
  assert.deepEqual(
    await parseJsonResponse(
      { ok: () => true, status: () => 200, json: async () => ({ items: [] }) },
      'List',
    ),
    { items: [] },
  );
});

test('response validation distinguishes empty results from missing or malformed data', () => {
  assert.deepEqual(parseMenu({ items: [] }), []);
  assert.deepEqual(parseStatements({ idaldocRefs: [] }), []);
  for (const value of [{}, null, { error: 'expired' }, { idaldocRefs: {} }]) {
    assert.throws(() => parseStatements(value));
  }
  assert.throws(() => parseMenu({ items: [null] }));
  assert.throws(() => parseMenu({ items: [{ type: 'BAC' }] }));
  assert.throws(() => parseStatements({ idaldocRefs: [{ documentId: 'x' }] }));
  assert.throws(() => parseDocKey({ docKey: 123 }));
  assert.deepEqual(parseDocKey({ idaldockeyRefs: [{ docKey: 'key' }], csrftoken: 'token' }), {
    docKey: 'key',
    csrfToken: 'token',
  });
  assert.deepEqual(parseDocKey({ docKey: 'key' }), { docKey: 'key', csrfToken: '' });
});

test('SUCCESS without a document list is an empty year; errors and malformed lists still fail', () => {
  assert.deepEqual(
    parseStatements({
      code: 'SUCCESS',
      payeeId: 12345,
      paperless: true,
      mailMeACopy: false,
      payAllowed: true,
    }),
    [],
  );
  const docs = [{ documentId: 'example', documentDate: '20261011' }];
  assert.deepEqual(parseStatements({ code: 'SUCCESS', idaldocRefs: docs }), docs);
  for (const idaldocRefs of [null, undefined, {}, 'invalid']) {
    assert.throws(() => parseStatements({ code: 'SUCCESS', idaldocRefs }));
  }
  for (const value of [
    { code: 'ERROR' },
    { code: 'ERROR', idaldocRefs: [] },
    { code: 'ERROR', idaldocRefs: docs },
    { code: null },
    {},
  ]) {
    assert.throws(() => parseStatements(value));
  }
});

test('unexpected statement responses include the code without exposing other values', () => {
  assert.throws(
    () => parseStatements({ code: 'NO_DOCUMENTS', payeeId: 987654321, csrftoken: 'private-token' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code: "NO_DOCUMENTS"/);
      assert.match(error.message, /idaldocRefs: missing/);
      assert.equal(error.message.includes('987654321'), false);
      assert.equal(error.message.includes('private-token'), false);
      return true;
    },
  );
  assert.throws(() => parseStatements({ code: 42 }), /code: 42/);
  assert.throws(() => parseStatements({}), /code: missing/);
  assert.throws(() => parseStatements({ code: { secret: 'hidden' } }), /code: <object>/);
  assert.throws(
    () => parseStatements({ code: 'https://example.com/?docKey=secret\npassword=hidden' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes('hidden'), false);
      assert.equal(error.message.includes('\n'), false);
      return true;
    },
  );
});

test('invalid PDF cannot replace an existing file, valid replacement leaves no temporary files', () => {
  const dir = temporaryDirectory();
  try {
    const file = path.join(dir, 'statement.pdf');
    fs.writeFileSync(file, 'old content');
    assert.throws(() => savePdf(file, Buffer.from('%PDF-1.7\ntruncated')), /truncated/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old content');
    savePdf(file, pdf);
    assert.deepEqual(fs.readFileSync(file), pdf);
    assert.deepEqual(fs.readdirSync(dir), ['statement.pdf']);
    assert.equal(isCompletePdf(Buffer.alloc(0)), false);
    assert.equal(isCompletePdf(Buffer.from('<html>error</html>')), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rename failure cleans up temporary download', () => {
  const dir = temporaryDirectory();
  try {
    const file = path.join(dir, 'existing-directory');
    fs.mkdirSync(file);
    assert.throws(() => savePdf(file, pdf));
    assert.deepEqual(fs.readdirSync(dir), ['existing-directory']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed statement does not prevent subsequent downloads and summary counts stay accurate', async () => {
  const docs = ['a', 'b', 'c'].map((documentId) => ({ documentId, documentDate: '2026-10-01' }));
  const summary = { downloaded: 0, skipped: 0, failed: 0, periodFailures: 0 };
  const visited: string[] = [];
  await processDocuments(docs, summary, async (doc) => {
    visited.push(doc.documentId);
    if (doc.documentId === 'a') {
      throw new Error('Request failed');
    }
    return doc.documentId === 'b' ? 'skipped' : 'downloaded';
  });
  assert.deepEqual(visited, ['a', 'b', 'c']);
  assert.deepEqual(summary, { downloaded: 1, skipped: 1, failed: 1, periodFailures: 0 });
});

test('request URLs and named secrets are redacted from errors', () => {
  const message = formatError(
    new Error('Failed https://chase.example/pdf?docKey=secret csrfToken=token password=hidden'),
  );
  for (const secret of ['secret', 'token', 'hidden', 'chase.example']) {
    assert.equal(message.includes(secret), false);
  }
});
