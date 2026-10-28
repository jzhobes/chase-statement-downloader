import type { BrowserContext, Locator, Page } from 'playwright';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { NavigationResult } from './types';

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function isMfaDebugRun(): boolean {
  return process.env.DEBUG_MFA === 'true';
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

/**
 * Wait for a usable dashboard, then replace the saved session without exposing a partial file.
 */
export async function confirmDashboard(
  page: Page,
  context: BrowserContext,
  stateFile: string,
): Promise<void> {
  await failOnUnsupportedBrowser(
    page,
    (async () => {
      await page.waitForURL((url) => url.pathname.includes('dashboard'), { timeout: 60000 });
      await page.waitForSelector('[data-testid="accounts-group-container"]', { timeout: 30000 });
    })(),
  );
  // Create with restricted permissions before Playwright writes session cookies.
  const temporaryPath = `${stateFile}.${randomUUID()}.part`;
  try {
    fs.writeFileSync(temporaryPath, '', { flag: 'wx', mode: 0o600 });
    await context.storageState({ path: temporaryPath });
    fs.renameSync(temporaryPath, stateFile);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  console.log('✅ Dashboard ready. Session saved.');
}

async function clickNext(page: Page): Promise<void> {
  await page
    .locator('#next-content, button:has-text("Next"), mds-button[text="Next"]')
    .first()
    .click();
}

/**
 * Click Chase’s custom controls, falling back to coordinates or DOM events when needed.
 */
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

/**
 * Select an MFA option, including controls inside Chase’s shadow DOM.
 */
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

/**
 * Fill either a native OTP input or Chase’s custom verification control.
 */
export async function fillOneTimeCode(page: Page, code: string): Promise<void> {
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

/** Detect the unsupported-browser redirect by URL or heading while login outcomes are pending. */
async function waitForUnsupportedBrowser(
  page: Page,
  timeout = 30000,
): Promise<'unsupported-browser'> {
  await Promise.any([
    page.waitForURL((url) => /system[-_]?requirements/i.test(url.pathname), { timeout }),
    page.getByRole('heading', { name: 'System Requirements', exact: true }).waitFor({ timeout }),
  ]);
  return 'unsupported-browser';
}

/** Keep watching for browser rejection while verification or dashboard waits are pending. */
async function failOnUnsupportedBrowser<T>(page: Page, pending: Promise<T>): Promise<T> {
  return Promise.race([
    pending,
    waitForUnsupportedBrowser(page, 90000).then(
      () => {
        throw new Error('Chase redirected to its System Requirements page. Try HEADLESS=false.');
      },
      () => pending,
    ),
  ]);
}

/** Wait for either supported OTP control before asking the user for their code. */
export async function waitForOneTimeCodeInput(page: Page): Promise<void> {
  await failOnUnsupportedBrowser(
    page,
    page
      .locator('input[autocomplete="one-time-code"]:visible, #otpInput:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 60000 }),
  );
}

/**
 * Reuse the loaded session or complete login and MFA, then save the confirmed session.
 * Reads credentials only when login is needed; SMS verification prompts in the terminal.
 */
export async function authenticate(
  page: Page,
  context: BrowserContext,
  stateFile: string,
  screenshotDir: string,
): Promise<void> {
  console.log('🌐 Navigating to Chase...');
  await page.goto('https://www.chase.com/');

  const loginSelector = '#userId-text-input-field';
  const dashboardSelector = '[data-testid="accounts-group-container"]';
  const identitySelector = '#challengeIntroductionHeader';
  const chaseErrorText = "It looks like this part of our site isn't working right now";

  const result: NavigationResult = await Promise.any([
    page.waitForSelector(loginSelector, { timeout: 30000 }).then(() => 'login' as const),
    page.waitForSelector(dashboardSelector, { timeout: 30000 }).then(() => 'dashboard' as const),
    waitForUnsupportedBrowser(page),
  ]).catch(() => 'timeout' as const);

  if (result === 'unsupported-browser') {
    throw new Error('Chase redirected to its System Requirements page. Try HEADLESS=false.');
  }
  console.log('🔍 Navigation Result:', result);
  await page.screenshot({ path: path.join(screenshotDir, '1_landing_page.png') });

  if (result === 'login') {
    console.log('🔐 Login required. Filling credentials...');
    await page.fill(loginSelector, getRequiredEnv('USERNAME'));
    await page.fill('#password-text-input-field', getRequiredEnv('PASSWORD'));
    await page.screenshot({ path: path.join(screenshotDir, '2_before_click_signin.png') });
    await page.click('#signin-button');

    console.log('⏳ Waiting for post-login redirection (MFA or Dashboard)...');
    const postLoginState = await Promise.any([
      waitForUnsupportedBrowser(page),
      page.waitForSelector(identitySelector, { timeout: 30000 }).then(() => 'identity' as const),
      page.waitForSelector(dashboardSelector, { timeout: 30000 }).then(() => 'dashboard' as const),
      page
        .getByText(chaseErrorText)
        .waitFor({ timeout: 30000 })
        .then(() => 'site-error' as const),
    ]).catch(() => 'unknown' as const);

    if (postLoginState === 'unsupported-browser') {
      throw new Error('Chase redirected to its System Requirements page. Try HEADLESS=false.');
    }
    console.log('🔍 Post-login state:', postLoginState);
    await page.screenshot({ path: path.join(screenshotDir, '3_after_signin_click.png') });

    if (postLoginState === 'unknown') {
      throw new Error('Timed out after sign-in.');
    }
    if (postLoginState === 'site-error') {
      throw new Error(`Chase returned a site error after sign-in: ${chaseErrorText}`);
    }
  } else if (result === 'dashboard') {
    console.log('✅ Active session detected. Skipping login flow.');
  } else {
    throw new Error('Timed out waiting for login or dashboard.');
  }

  if (page.url().includes('confirmIdentity') || (await isSelectorVisible(page, identitySelector))) {
    console.log('🔐 Identity verification required!');
    await page.screenshot({ path: path.join(screenshotDir, '4_identity_verification.png') });

    const optionSummaries = await getVerificationOptionSummaries(page);

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

      await waitForOneTimeCodeInput(page);

      const verificationCode = await promptForVerificationCode();
      await fillOneTimeCode(page, verificationCode);
      await page.screenshot({ path: path.join(screenshotDir, '7_after_code_entry.png') });

      console.log('✅ Submitting text verification code...');
      await clickNext(page);
    } else {
      throw new Error('No supported identity verification option found.');
    }
  }

  await confirmDashboard(page, context, stateFile);
}
