import type { APIResponse, BrowserContext, Page } from 'playwright';
import { parseJsonResponse, parseMenu, parseStatements, parseDocKey } from './reliability';
import type { ChaseApiOptions, CreditCardAccount, DateFilter, DocRef, MenuItem } from './types';

function stringifyAccountField(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  return null;
}

function toCreditCardAccount(item: MenuItem): CreditCardAccount | null {
  if (item.type !== 'BAC') {
    return null;
  }

  const accountId = stringifyAccountField(item.accountId);
  const accountMask = stringifyAccountField(item.accountMask);

  if (!accountId || !accountMask) {
    return null;
  }

  return {
    accountId,
    accountMask,
    type: 'BAC',
  };
}

/**
 * Send a request with the browser session’s cookies. Transport errors omit sensitive request details.
 */
async function chaseApi(
  page: Page,
  url: string,
  options: ChaseApiOptions = {},
): Promise<APIResponse> {
  try {
    return await page.request.fetch(url, {
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-jpmc-channel': 'id=C30',
        'x-jpmc-csrf-token': 'NONE',
        Referer: 'https://secure.chase.com/web/auth/dashboard',
        Origin: 'https://secure.chase.com',
        ...options.headers,
      },
      ...(options.data == null ? {} : { data: options.data }),
    });
  } catch {
    // Playwright errors can include request URLs, headers, and document keys.
    throw new Error('Chase request failed before a response was received.');
  }
}

/**
 * Return supported credit card accounts, rejecting malformed responses or an empty selection.
 */
export async function discoverAccounts(page: Page): Promise<CreditCardAccount[]> {
  const response = await chaseApi(
    page,
    'https://secure.chase.com/svc/rr/documents/secure/v1/menu/list',
  );
  const items = parseMenu(await parseJsonResponse(response, 'Account discovery'));
  const accounts = items
    .map(toCreditCardAccount)
    .filter((account): account is CreditCardAccount => account !== null);
  if (!accounts.length) {
    throw new Error('No supported credit card accounts (BAC) found.');
  }
  console.log(`✅ Found ${accounts.length} credit card account(s).`);
  return accounts;
}

/**
 * Resolve a document key and CSRF token, then fetch the PDF bytes.
 * The caller validates and saves the PDF; keys, tokens, and download URLs stay out of logs.
 */
export async function downloadStatement(
  page: Page,
  context: BrowserContext,
  accountId: string,
  filter: DateFilter,
  documentId: string,
): Promise<Buffer> {
  const response = await chaseApi(
    page,
    'https://secure.chase.com/svc/rr/documents/secure/idal/v2/dockey/list',
    {
      data: new URLSearchParams({
        accountFilter: accountId,
        'dateFilter.idalDateFilterType': filter,
        documentId,
      }).toString(),
    },
  );
  const key = parseDocKey(await parseJsonResponse(response, 'Document key'));
  let csrfToken =
    key.csrfToken ||
    ['x-jpmc-csrf-token', 'xsrf-token', 'csrf-token']
      .map((name) => response.headers()[name])
      .find(Boolean) ||
    '';
  if (!csrfToken) {
    csrfToken =
      (await context.cookies()).find((cookie) => cookie.name.toLowerCase().includes('csrf'))
        ?.value ?? '';
  }
  if (!csrfToken) {
    csrfToken = await page.evaluate(
      () => window.csrfToken ?? window.envConfig?.csrfToken ?? window.JPMC?.csrfToken ?? '',
    );
  }
  const params = new URLSearchParams({
    docKey: key.docKey,
    sor: 'STAR_MS',
    adaVersion: 'false',
    download: 'true',
    csrftoken: csrfToken || 'NONE',
  });
  const pdfResponse = await chaseApi(
    page,
    `https://secure.chase.com/svc/rr/documents/secure/idal/v5/pdfdoc/star/list?${params}`,
    {
      method: 'GET',
      headers: { Accept: 'application/pdf', 'x-jpmc-csrf-token': csrfToken || 'NONE' },
    },
  );
  if (
    !pdfResponse.ok() ||
    !pdfResponse.headers()['content-type']?.toLowerCase().startsWith('application/pdf')
  ) {
    throw new Error(`PDF request failed (HTTP ${pdfResponse.status()}).`);
  }
  return pdfResponse.body();
}

/** List one account period, including empty years where Chase returns SUCCESS without a list. */
export async function listStatements(
  page: Page,
  accountId: string,
  filter: DateFilter,
): Promise<DocRef[]> {
  const response = await chaseApi(
    page,
    'https://secure.chase.com/svc/rr/documents/secure/idal/v2/docref/list',
    {
      data: new URLSearchParams({
        accountFilter: accountId,
        'dateFilter.idalDateFilterType': filter,
      }).toString(),
    },
  );
  return parseStatements(await parseJsonResponse(response, 'Statement list'));
}
