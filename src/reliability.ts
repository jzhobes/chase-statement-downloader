import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DocRef, MenuItem } from './types';

interface JsonResponse {
  ok(): boolean;
  status(): number;
  json(): Promise<unknown>;
}

export interface DownloadSummary {
  downloaded: number;
  skipped: number;
  failed: number;
  periodFailures: number;
}

/** Format an error for logs and redact URLs and common secret fields as a fallback. */
export function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s]+/gi, '[URL redacted]')
    .replace(
      /((?:csrftoken|csrf-token|docKey|password|username)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject HTTP errors and invalid JSON without logging potentially sensitive response bodies. */
export async function parseJsonResponse(response: JsonResponse, label: string): Promise<unknown> {
  if (!response.ok()) {
    throw new Error(`${label} failed (HTTP ${response.status()}).`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export function parseMenu(value: unknown): MenuItem[] {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isRecord)) {
    throw new Error('Account discovery returned an unexpected response.');
  }
  for (const item of value.items) {
    if (
      item.type === 'BAC' &&
      (!['string', 'number'].includes(typeof item.accountId) ||
        !['string', 'number'].includes(typeof item.accountMask) ||
        String(item.accountId) === '' ||
        String(item.accountMask) === '')
    ) {
      throw new Error('Credit card account is missing its ID or account mask.');
    }
  }
  return value.items;
}

/** Include the response code for diagnosis; describe other fields by type only. */
function describeStatementResponse(value: unknown): string {
  const typeOf = (field: unknown): string =>
    field === null ? 'null' : Array.isArray(field) ? 'array' : typeof field;

  if (!isRecord(value)) {
    return `response type: ${typeOf(value)}`;
  }

  const keys = Object.keys(value);
  const fields = keys
    .slice(0, 20)
    .map((key) => `${JSON.stringify(key.slice(0, 60))}: ${typeOf(value[key])}`)
    .join(', ');
  const listType = Object.hasOwn(value, 'idaldocRefs') ? typeOf(value.idaldocRefs) : 'missing';
  const truncated = keys.length > 20 ? ', ...' : '';
  const code = !Object.hasOwn(value, 'code')
    ? 'missing'
    : typeof value.code === 'string'
      ? JSON.stringify(formatError(value.code).slice(0, 120))
      : typeof value.code === 'number' && Number.isFinite(value.code)
        ? String(value.code)
        : `<${typeOf(value.code)}>`;
  return `code: ${code}; fields: {${fields}${truncated}}; idaldocRefs: ${listType}`;
}

/** Chase omits the document list for empty years with code SUCCESS; other missing lists are errors. */
export function parseStatements(value: unknown): DocRef[] {
  if (isRecord(value) && value.code === 'SUCCESS' && !Object.hasOwn(value, 'idaldocRefs')) {
    return [];
  }
  if (
    !isRecord(value) ||
    (Object.hasOwn(value, 'code') && value.code !== 'SUCCESS') ||
    !Array.isArray(value.idaldocRefs)
  ) {
    throw new Error(
      `Statement list returned an unexpected response (${describeStatementResponse(value)}).`,
    );
  }
  return value.idaldocRefs.map((doc) => {
    if (
      !isRecord(doc) ||
      typeof doc.documentDate !== 'string' ||
      !doc.documentDate ||
      typeof doc.documentId !== 'string' ||
      !doc.documentId
    ) {
      throw new Error('Statement list contains an invalid document reference.');
    }
    return { documentDate: doc.documentDate, documentId: doc.documentId };
  });
}

export function parseDocKey(value: unknown): { docKey: string; csrfToken: string } {
  if (!isRecord(value)) {
    throw new Error('Document key returned an unexpected response.');
  }
  const first = Array.isArray(value.idaldockeyRefs) ? value.idaldockeyRefs[0] : undefined;
  const docKey = (isRecord(first) ? first.docKey : undefined) ?? value.docKey;
  if (
    typeof docKey !== 'string' ||
    !docKey ||
    (value.csrftoken !== undefined && typeof value.csrftoken !== 'string')
  ) {
    throw new Error('Document key response is missing a valid key or token.');
  }
  return { docKey, csrfToken: typeof value.csrftoken === 'string' ? value.csrftoken : '' };
}

/** Check the PDF header and end marker for obvious truncation; this is not a full PDF parser. */
export function isCompletePdf(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, 5).toString('ascii') === '%PDF-' &&
    /%%EOF\s*$/.test(buffer.subarray(-1024).toString('latin1'))
  );
}

/** Validate PDF markers, then replace the destination atomically using a private temporary file. */
export function savePdf(filePath: string, buffer: Buffer): void {
  if (!isCompletePdf(buffer)) {
    throw new Error('Downloaded PDF is empty, invalid, or truncated.');
  }
  const temporaryPath = `${filePath}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/** Process documents sequentially, count outcomes, and keep going after individual failures. */
export async function processDocuments(
  docs: DocRef[],
  summary: DownloadSummary,
  processDocument: (doc: DocRef) => Promise<'downloaded' | 'skipped'>,
): Promise<void> {
  for (const doc of docs) {
    try {
      summary[await processDocument(doc)]++;
    } catch (error) {
      summary.failed++;
      console.error(
        `❌ Statement ${doc.documentDate.replace(/[^a-zA-Z0-9_-]/g, '_')} failed: ${formatError(error)}`,
      );
    }
  }
}
