import 'dotenv/config';

import {
  chromium,
  type APIResponse,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import type {
  ChaseApiOptions,
  CreditCardAccount,
  DateFilter,
  DocKeyResponse,
  MenuItem,
  MenuListResponse,
  NavigationResult,
  StatementListResponse,
} from './types';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isHeadlessRun(): boolean {
  return process.env.HEADLESS === 'true';
}

function isMfaDebugRun(): boolean {
  return process.env.DEBUG_MFA === 'true';
}

function toDateFilter(yearOffset: number): DateFilter {
  if (yearOffset === 0) {
    return 'CURRENT_YEAR';
  }

  return `CURRENT_YEAR_MINUS_${yearOffset}` as DateFilter;
}

function getRequestedDateFilters(args: string[]): DateFilter[] {
  if (args.includes('--bulk')) {
    return Array.from({ length: 8 }, (_, yearOffset) => toDateFilter(yearOffset));
  }

  const yearArg = args.find((arg) => /^\d+$/.test(arg) || arg.startsWith('--year='));
  const yearOffset = yearArg ? Number(yearArg.replace('--year=', '')) : 0;

  if (!Number.isInteger(yearOffset) || yearOffset < 0 || yearOffset > 7) {
    throw new Error('Year offset must be an integer from 0 through 7.');
  }

  return [toDateFilter(yearOffset)];
}

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

async function parseJsonResponse<T extends object>(
  response: APIResponse,
  label: string,
): Promise<Partial<T>> {
  return response.json().catch(async (error: unknown) => {
    console.error(`⚠️ Failed to parse ${label} JSON: ${formatError(error)}`);
    const bodyPreview = await response
      .text()
      .then((text) => text.replace(/\s+/g, ' ').slice(0, 500))
      .catch(() => '');

    if (bodyPreview) {
      console.error(`⚠️ ${label} response preview: ${bodyPreview}`);
    }

    return {};
  });
}

function getDocKeyInfo(keyData: Partial<DocKeyResponse>): { docKey: string; csrfToken: string } {
  const firstDocKey = keyData.idaldockeyRefs?.[0]?.docKey;
  const docKey = firstDocKey ?? keyData.docKey;

  if (!docKey) {
    console.error('Failed to find docKey in API Response:', JSON.stringify(keyData, null, 2));
    throw new Error('docKey not found in response.');
  }

  return {
    docKey,
    csrfToken: keyData.csrftoken ?? '',
  };
}

async function isSelectorVisible(page: Page, selector: string): Promise<boolean> {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

async function promptForVerificationCode(): Promise<string> {
  const terminal = createInterface({ input, output });

  try {
    const code = await terminal.question('Enter the Chase text verification code: ');
    return code.trim();
  } finally {
    terminal.close();
  }
}

async function waitForDashboardAndSaveSession(
  page: Page,
  context: BrowserContext,
  stateFile: string,
): Promise<void> {
  try {
    await page.waitForURL((url) => url.toString().includes('dashboard'), {
      timeout: 60000,
    });
    console.log('⏳ Dashboard URL reached. Waiting for content to render...');

    await page.waitForSelector('[data-testid="accounts-group-container"]', {
      timeout: 30000,
    });
    console.log('✅ Dashboard rendered successfully!');

    await context.storageState({ path: stateFile });
    console.log('📂 Session state saved to:', stateFile);
  } catch {
    console.log('❌ Timed out waiting for dashboard content. Current URL:', page.url());
  }
}

async function clickNext(page: Page): Promise<void> {
  await page
    .locator('#next-content, button:has-text("Next"), mds-button[text="Next"]')
    .first()
    .click();
}

async function clickCustomElement(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();

  const internalClickable = locator
    .locator('a.list-item__navigational, button, [role="button"], [role="link"]')
    .first();

  if ((await internalClickable.count()) > 0) {
    await internalClickable.click({ force: true, timeout: 5000 });
    return;
  }

  try {
    await locator.click({ force: true, timeout: 5000 });
    return;
  } catch {
    const box = await locator.boundingBox();

    if (box) {
      await locator.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return;
    }
  }

  await locator.evaluate((element) => {
    for (const eventType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      element.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
        }),
      );
    }
  });
}

async function clickMfaOptionById(page: Page, optionId: string, label: string): Promise<void> {
  if (isMfaDebugRun()) {
    const debugInfo = await page.evaluate((id) => {
      const host = document.getElementById(id);
      const shadowClickable = host?.shadowRoot?.querySelector(
        'a.list-item__navigational, button, [role="button"], [role="link"]',
      );
      const hostRect = host?.getBoundingClientRect();
      const shadowRect = shadowClickable?.getBoundingClientRect();

      return {
        hostExists: Boolean(host),
        hostTag: host?.tagName,
        hostRect: hostRect
          ? {
              x: hostRect.x,
              y: hostRect.y,
              width: hostRect.width,
              height: hostRect.height,
            }
          : null,
        hasShadowRoot: Boolean(host?.shadowRoot),
        shadowClickableTag: shadowClickable?.tagName,
        shadowRect: shadowRect
          ? {
              x: shadowRect.x,
              y: shadowRect.y,
              width: shadowRect.width,
              height: shadowRect.height,
            }
          : null,
      };
    }, optionId);

    console.log(`🧪 MFA option "${optionId}" click debug:`, debugInfo);
  }

  const textLocator = page.getByText(label, { exact: true }).first();
  if ((await textLocator.count()) > 0) {
    console.log(`🖱️ Clicking "${label}"...`);
    await textLocator.click({ force: true, timeout: 5000 });
    return;
  }

  const internalClickable = page
    .locator(
      `#${optionId} a.list-item__navigational, #${optionId} button, #${optionId} [role="button"], #${optionId} [role="link"]`,
    )
    .first();

  if ((await internalClickable.count()) > 0) {
    console.log(`🖱️ Clicking internal control for "${label}"...`);
    await internalClickable.click({ force: true, timeout: 5000 });
    return;
  }

  const clickedWithDom = await page.evaluate((id) => {
    const host = document.getElementById(id);
    const target =
      host?.shadowRoot?.querySelector(
        'a.list-item__navigational, button, [role="button"], [role="link"]',
      ) ?? host;

    if (!(target instanceof HTMLElement)) {
      return false;
    }

    for (const eventType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
        }),
      );
    }

    target.click();
    return true;
  }, optionId);

  if (!clickedWithDom) {
    throw new Error(`Unable to find MFA option "${optionId}" (${label}) to click.`);
  }
}

async function getVerificationOptionSummaries(page: Page): Promise<string[]> {
  const options = page.locator('mds-list-item');

  return options.evaluateAll((elements) =>
    elements.map((element, index) => {
      const label = element.getAttribute('label');
      const description = element.getAttribute('description');
      const accessibleDescription = element.getAttribute('navigational-accessible-description');
      const text = [label, description, accessibleDescription, element.textContent]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      return text || `<empty option text at index ${index}>`;
    }),
  );
}

function getMenuItemTypeCounts(items: MenuItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const type = typeof item.type === 'string' ? item.type : '<missing>';
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
}

function getSanitizedMenuItemSummary(item: MenuItem, index: number): Record<string, unknown> {
  const keys = Object.keys(item);

  return {
    index,
    type: typeof item.type === 'string' ? item.type : undefined,
    accountMask: typeof item.accountMask === 'string' ? item.accountMask : undefined,
    keys,
  };
}

async function fillOneTimeCode(page: Page, code: string): Promise<void> {
  const nativeCodeInput = page.locator('input[autocomplete="one-time-code"]:visible').first();

  if ((await nativeCodeInput.count()) > 0) {
    await nativeCodeInput.fill(code);
    return;
  }

  const secureCodeInput = page.locator('#otpInput').first();
  await secureCodeInput.waitFor({ state: 'visible', timeout: 60000 });
  await secureCodeInput.evaluate((element, value) => {
    element.setAttribute('value', value);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }, code);
}

async function run(): Promise<void> {
  const isBulk = process.argv.includes('--bulk');
  const filtersToProcess = getRequestedDateFilters(process.argv.slice(2));

  console.log(
    `🚀 --- Chase Automated Statement Downloader (${isBulk ? 'BULK MODE' : filtersToProcess[0]}) ---`,
  );

  async function chaseApi(
    page: Page,
    url: string,
    options: ChaseApiOptions = {},
  ): Promise<APIResponse> {
    const { method = 'POST', data = null, headers = {} } = options;
    const requestOptions: Parameters<typeof page.request.fetch>[1] = {
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-jpmc-channel': 'id=C30',
        'x-jpmc-csrf-token': 'NONE',
        Referer: 'https://secure.chase.com/web/auth/dashboard',
        Origin: 'https://secure.chase.com',
        Accept: '*/*',
        ...headers,
      },
    };

    if (data !== null) {
      requestOptions.data = data;
    }

    return page.request.fetch(url, requestOptions);
  }

  const headless = isHeadlessRun();
  const browser = await chromium.launch({ headless });
  const stateFile = path.join(__dirname, '..', 'chase_session.json');
  const screenshotDir = path.join(__dirname, '..', 'screenshots');

  if (fs.existsSync(screenshotDir)) {
    fs.rmSync(screenshotDir, { recursive: true, force: true });
  }
  fs.mkdirSync(screenshotDir, { recursive: true });

  console.log(`🧭 Browser mode: ${headless ? 'headless' : 'headed'}`);

  const contextOptions: BrowserContextOptions = {};

  if (fs.existsSync(stateFile)) {
    console.log('📂 Loading existing session from:', stateFile);
    contextOptions.storageState = stateFile;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    console.log('🌐 Navigating to Chase...');
    await page.goto('https://www.chase.com/');

    const loginSelector = '#userId-text-input-field';
    const dashboardSelector = '[data-testid="accounts-group-container"]';
    const identitySelector = '#challengeIntroductionHeader';
    const chaseErrorText = "It looks like this part of our site isn't working right now";

    const result: NavigationResult = await Promise.race([
      page.waitForSelector(loginSelector, { timeout: 30000 }).then(() => 'login' as const),
      page.waitForSelector(dashboardSelector, { timeout: 30000 }).then(() => 'dashboard' as const),
    ]).catch(() => 'timeout' as const);

    console.log('🔍 Navigation Result:', result);
    await page.screenshot({ path: path.join(screenshotDir, '1_landing_page.png') });

    if (result === 'login') {
      console.log('🔐 Login required. Filling credentials...');
      await page.fill(loginSelector, getRequiredEnv('USERNAME'));
      await page.fill('#password-text-input-field', getRequiredEnv('PASSWORD'));
      await page.screenshot({ path: path.join(screenshotDir, '2_before_click_signin.png') });
      await page.click('#signin-button');

      console.log('⏳ Waiting for post-login redirection (MFA or Dashboard)...');
      const postLoginState = await Promise.race([
        page.waitForSelector(identitySelector, { timeout: 30000 }).then(() => 'identity' as const),
        page
          .waitForSelector(dashboardSelector, { timeout: 30000 })
          .then(() => 'dashboard' as const),
        page
          .getByText(chaseErrorText)
          .waitFor({ timeout: 30000 })
          .then(() => 'site-error' as const),
      ]).catch(() => 'unknown' as const);

      console.log('🔍 Post-login state:', postLoginState);
      await page.screenshot({ path: path.join(screenshotDir, '3_after_signin_click.png') });

      if (postLoginState === 'site-error') {
        throw new Error(`Chase returned a site error after sign-in: ${chaseErrorText}`);
      }
    } else if (result === 'dashboard') {
      console.log('✅ Active session detected. Skipping login flow.');
    } else {
      console.log(
        '⚠️ Navigation timed out or unknown state. Proceeding with current URL:',
        page.url(),
      );
    }

    if (
      page.url().includes('confirmIdentity') ||
      (await isSelectorVisible(page, identitySelector))
    ) {
      console.log('🔐 Identity verification required!');
      await page.screenshot({ path: path.join(screenshotDir, '4_identity_verification.png') });

      const optionSummaries = await getVerificationOptionSummaries(page);
      console.log('🔎 Identity verification options:', optionSummaries);

      const mobileAppOptionIndex = optionSummaries.findIndex((summary) =>
        /mobile app|chase app|app/i.test(summary),
      );
      const textMessageOptionIndex = optionSummaries.findIndex((summary) =>
        /get a text|text a one-time code|text/i.test(summary),
      );
      const verificationOptions = page.locator('mds-list-item');
      const mobileAppOption = verificationOptions.nth(mobileAppOptionIndex);

      if (mobileAppOptionIndex >= 0 && (await mobileAppOption.isVisible())) {
        console.log('📱 Clicking mobile app confirmation option...');
        await clickCustomElement(mobileAppOption);
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(screenshotDir, '5_after_mobile_app_click.png') });

        if (await page.locator('#next-content').first().isVisible()) {
          console.log('📲 Clicking "Next" to send push notification...');
          await clickNext(page);
          console.log('🤳 Please approve the notification on your mobile device...');

          await waitForDashboardAndSaveSession(page, context, stateFile);
          await page.screenshot({ path: path.join(screenshotDir, '6_dashboard_ready.png') });
        }
      } else if (textMessageOptionIndex >= 0) {
        console.log('💬 Mobile app confirmation unavailable. Clicking "Get a text"...');
        await clickMfaOptionById(page, 'sms', 'Get a text');
        await page.locator('#eligibleTextContacts').waitFor({ state: 'visible', timeout: 30000 });
        await page.screenshot({ path: path.join(screenshotDir, '5_after_text_option_click.png') });

        console.log('📞 Selecting first eligible text contact...');
        await page.locator('#eligibleTextContacts-input-0').first().click();

        console.log('📨 Requesting text verification code...');
        await clickNext(page);
        await page.screenshot({ path: path.join(screenshotDir, '6_after_request_text_code.png') });

        await page.locator('#otpInput').first().waitFor({ state: 'visible', timeout: 60000 });

        const verificationCode = await promptForVerificationCode();
        await fillOneTimeCode(page, verificationCode);
        await page.screenshot({ path: path.join(screenshotDir, '7_after_code_entry.png') });

        console.log('✅ Submitting text verification code...');
        await clickNext(page);

        await waitForDashboardAndSaveSession(page, context, stateFile);
        await page.screenshot({ path: path.join(screenshotDir, '8_dashboard_ready.png') });
      } else {
        throw new Error(
          `No supported identity verification option found. Options: ${optionSummaries.join(' | ')}`,
        );
      }
    }

    console.log('🔍 Discovering accounts...');
    const menuResponse = await page.request.post(
      'https://secure.chase.com/svc/rr/documents/secure/v1/menu/list',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-jpmc-channel': 'id=C30',
          'x-jpmc-csrf-token': 'NONE',
          Referer: 'https://secure.chase.com/web/auth/dashboard',
          Origin: 'https://secure.chase.com',
        },
      },
    );

    console.log('🔍 Menu API Status:', menuResponse.status());
    console.log('🔍 Menu API Content-Type:', menuResponse.headers()['content-type'] ?? '<missing>');

    const menuData = await parseJsonResponse<MenuListResponse>(menuResponse, 'Menu List');
    const menuItems = Array.isArray(menuData.items) ? menuData.items : [];
    const accounts = menuItems
      .map((item) => toCreditCardAccount(item))
      .filter((account): account is CreditCardAccount => account !== null);

    console.log('🔍 Menu API top-level keys:', Object.keys(menuData));
    console.log(`🔍 Menu API item count: ${menuItems.length}`);
    console.log('🔍 Menu API item type counts:', getMenuItemTypeCounts(menuItems));

    if (accounts.length === 0) {
      console.log('⚠️ No credit card accounts (BAC) found.');
      console.log(
        '🔍 First menu item summaries:',
        menuItems.slice(0, 5).map((item, index) => getSanitizedMenuItemSummary(item, index)),
      );
      return;
    }

    console.log(`✅ Found ${accounts.length} credit card account(s).`);

    for (const account of accounts) {
      const { accountId, accountMask } = account;
      console.log(`\n--- Processing Account: ${accountMask} (ID: ${accountId}) ---`);

      const accountDir = path.join(__dirname, '..', `Chase-${accountMask}`);
      if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
      }

      for (const currentFilter of filtersToProcess) {
        console.log(`\n📅 Checking period: ${currentFilter}...`);

        console.log(`📡 Sending Request to List Documents (${currentFilter})...`);
        const listResponse = await chaseApi(
          page,
          'https://secure.chase.com/svc/rr/documents/secure/idal/v2/docref/list',
          {
            data: `accountFilter=${accountId}&dateFilter.idalDateFilterType=${currentFilter}`,
          },
        );

        console.log(`List API Status: ${listResponse.status()}`);
        const listData = await parseJsonResponse<StatementListResponse>(
          listResponse,
          'Statement List',
        );
        const docRefs = listData.idaldocRefs ?? [];

        if (docRefs.length === 0) {
          continue;
        }

        console.log(`📄 Found ${docRefs.length} statement(s).`);

        for (const doc of docRefs) {
          const fileName = `${doc.documentDate}-statements-${accountMask}-.pdf`;
          const filePath = path.join(accountDir, fileName);

          if (fs.existsSync(filePath)) {
            console.log(`⏭️  Skipping existing statement: ${fileName}`);
            continue;
          }

          console.log(`📄 Processing Statement: ${doc.documentDate} (ID: ${doc.documentId})`);

          console.log(`🔑 Getting Document Key for ${doc.documentDate}...`);
          const keyResponse = await chaseApi(
            page,
            'https://secure.chase.com/svc/rr/documents/secure/idal/v2/dockey/list',
            {
              data: `accountFilter=${accountId}&dateFilter.idalDateFilterType=${currentFilter}&documentId=${doc.documentId}`,
            },
          );

          console.log(`DocKey API Status: ${keyResponse.status()}`);
          const keyData = await parseJsonResponse<DocKeyResponse>(keyResponse, 'DocKey');
          const docKeyInfo = getDocKeyInfo(keyData);
          let csrfToken = docKeyInfo.csrfToken;

          if (!csrfToken) {
            csrfToken =
              ['x-jpmc-csrf-token', 'xsrf-token', 'csrf-token']
                .map((header) => keyResponse.headers()[header])
                .find(Boolean) ?? '';

            if (csrfToken) {
              console.log(`Found CSRF token in DocKey Response Headers: ${csrfToken}`);
            }
          }

          console.log(` Using Final DocKey: ${docKeyInfo.docKey}`);
          console.log(` Using Final CSRF Token: ${csrfToken || 'NONE'}`);

          const cookies = await context.cookies();

          if (!csrfToken) {
            const csrfCookie = cookies.find((cookie) => cookie.name.toLowerCase().includes('csrf'));

            if (csrfCookie) {
              csrfToken = csrfCookie.value;
              console.log(`Found CSRF token in cookie: ${csrfCookie.name}`);
            }
          }

          if (!csrfToken) {
            console.log('🔍 Attempting to extract CSRF token from page environment...');
            csrfToken =
              (await page
                .evaluate(
                  () => window.csrfToken ?? window.envConfig?.csrfToken ?? window.JPMC?.csrfToken,
                )
                .catch(() => null)) ?? '';

            if (csrfToken) {
              console.log(`Found CSRF token in page JS: ${csrfToken}`);
            }
          }

          console.log('📥 Downloading PDF...');
          const finalCsrf = csrfToken || 'NONE';
          const pdfUrl = `https://secure.chase.com/svc/rr/documents/secure/idal/v5/pdfdoc/star/list?docKey=${docKeyInfo.docKey}&sor=STAR_MS&adaVersion=false&download=true&csrftoken=${finalCsrf}`;

          console.log('🔗 Download URL:', pdfUrl);
          const pdfResponse = await chaseApi(page, pdfUrl, {
            method: 'GET',
            headers: {
              Accept:
                'application/pdf,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
              'x-jpmc-csrf-token': finalCsrf,
              'Upgrade-Insecure-Requests': '1',
            },
          });
          const buffer = await pdfResponse.body();

          if (!pdfResponse.headers()['content-type']?.startsWith('application/pdf')) {
            console.error('Response is not a PDF. Status:', pdfResponse.status());
            throw new Error('Download failed: Response was not a PDF.');
          }

          fs.writeFileSync(filePath, buffer);

          console.log(`✅ SUCCESS! Saved to ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error('An error occurred:', error);
    await page.screenshot({ path: path.join(screenshotDir, 'error_state.png') });
    console.log(`📸 Error screenshot saved to ${path.join(screenshotDir, 'error_state.png')}`);
  } finally {
    await browser.close();
  }
}

void run();
