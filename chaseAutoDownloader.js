require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function run() {
  const isBulk = process.argv.includes('--bulk');
  const filtersToProcess = isBulk
    ? Array.from({ length: 7 }, (_, i) => `CURRENT_YEAR_MINUS_${i + 1}`)
    : ['CURRENT_YEAR_MINUS_1'];

  console.log(
    `🚀 --- Chase Automated Statement Downloader (${isBulk ? 'BULK MODE' : 'LATEST MODE'}) ---`,
  );

  /** Helper to call Chase APIs with consistent headers */
  async function chaseApi(page, url, options = {}) {
    const { method = 'POST', data = null, headers = {} } = options;
    const response = await page.request.fetch(url, {
      method,
      data,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-jpmc-channel': 'id=C30',
        'x-jpmc-csrf-token': 'NONE',
        Referer: 'https://secure.chase.com/web/auth/dashboard',
        Origin: 'https://secure.chase.com',
        Accept: '*/*',
        ...headers,
      },
    });
    return response;
  }

  // 1. Launch Browser
  const browser = await chromium.launch({ headless: true });
  const stateFile = path.join(__dirname, 'chase_session.json');
  const screenshotDir = path.join(__dirname, 'screenshots');

  // Clear and recreate screenshots directory
  if (fs.existsSync(screenshotDir)) {
    fs.rmSync(screenshotDir, { recursive: true, force: true });
  }
  fs.mkdirSync(screenshotDir, { recursive: true });

  const contextOptions = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  };

  if (fs.existsSync(stateFile)) {
    console.log('📂 Loading existing session from:', stateFile);
    contextOptions.storageState = stateFile;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    console.log('🌐 Navigating to Chase...');
    await page.goto('https://www.chase.com/');

    // Wait for either the login field OR the dashboard to appear
    const loginSelector = '#userId-text-input-field';
    const dashboardSelector = '[data-testid="accounts-group-container"]';

    const result = await Promise.race([
      page.waitForSelector(loginSelector, { timeout: 30000 }).then(() => 'login'),
      page.waitForSelector(dashboardSelector, { timeout: 30000 }).then(() => 'dashboard'),
    ]).catch(() => 'timeout');

    console.log('🔍 Navigation Result:', result);
    await page.screenshot({ path: path.join(screenshotDir, '1_landing_page.png') });

    if (result === 'login') {
      console.log('🔐 Login required. Filling credentials...');
      await page.fill(loginSelector, process.env.USERNAME);
      await page.fill('#password-text-input-field', process.env.PASSWORD);
      await page.screenshot({ path: path.join(screenshotDir, '2_before_click_signin.png') });
      await page.click('#signin-button');

      console.log('⏳ Waiting for post-login redirection (MFA or Dashboard)...');
      await Promise.race([
        page.waitForSelector('#challengeIntroductionHeader', { timeout: 30000 }).catch(() => {}),
        page.waitForSelector(dashboardSelector, { timeout: 30000 }).catch(() => {}),
      ]);
      await page.screenshot({ path: path.join(screenshotDir, '3_after_signin_click.png') });
    } else if (result === 'dashboard') {
      console.log('✅ Active session detected. Skipping login flow.');
    } else {
      console.log(
        '⚠️ Navigation timed out or unknown state. Proceeding with current URL:',
        page.url(),
      );
    }

    if (page.url().includes('confirmIdentity')) {
      console.log('🔐 Identity verification required!');
      await page.screenshot({ path: path.join(screenshotDir, '4_identity_verification.png') });

      // Check for the "Confirm using our mobile app" link
      const mobileAppLink = page.locator('a.list-item__navigational').first();
      if (await mobileAppLink.isVisible()) {
        console.log('📱 Clicking "Confirm using our mobile app"...');
        await mobileAppLink.click();
        await page.waitForTimeout(3000); // Wait for the "Next" screen to render
        await page.screenshot({ path: path.join(screenshotDir, '5_after_mobile_app_click.png') });

        // Click the "Next" button if it appeared
        const nextButton = page.locator('button:has-text("Next")').first();
        if (await nextButton.isVisible()) {
          console.log('📲 Clicking "Next" to send push notification...');
          await nextButton.click();
          console.log('🤳 Please approve the notification on your mobile device...');

          try {
            // 1. Wait for URL to change
            await page.waitForURL((url) => url.toString().includes('dashboard'), {
              timeout: 60000,
            });
            console.log('⏳ Dashboard URL reached. Waiting for content to render...');

            // 2. Wait for actual content (avoids the blank white screen)
            await page.waitForSelector('[data-testid="accounts-group-container"]', {
              timeout: 30000,
            });
            console.log('✅ Dashboard rendered successfully!');

            // Save successful session state
            await context.storageState({ path: stateFile });
            console.log('📂 Session state saved to:', stateFile);
          } catch (e) {
            console.log('❌ Timed out waiting for dashboard content. Current URL:', page.url());
          }
          await page.screenshot({ path: path.join(screenshotDir, '6_dashboard_ready.png') });
        }
      }
    }

    // 2. Discover Accounts
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

    const menuData = await menuResponse.json().catch((e) => {
      console.error(`⚠️ Failed to parse Menu List JSON: ${e.message}`);
      return {};
    });

    // Updated to match the actual API schema provided: menuData.items
    // Filtering for type "BAC" (Bankcard / Credit Card)
    const accounts = (menuData.items || []).filter((acc) => acc.type === 'BAC');

    if (accounts.length === 0) {
      console.log('⚠️ No credit card accounts (BAC) found.');
      return;
    }

    console.log(`✅ Found ${accounts.length} credit card account(s).`);

    for (const account of accounts) {
      const { accountId, accountMask } = account;
      console.log(`\n--- Processing Account: ${accountMask} (ID: ${accountId}) ---`);

      // Create a dedicated folder for this account
      const accountDir = path.join(__dirname, `Chase-${accountMask}`);
      if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
      }

      for (const currentFilter of filtersToProcess) {
        console.log(`\n📅 Checking period: ${currentFilter}...`);

        // 3. Fetch Statement List for this account period
        console.log(`📡 Sending Request to List Documents (${currentFilter})...`);
        const listResponse = await chaseApi(
          page,
          'https://secure.chase.com/svc/rr/documents/secure/idal/v2/docref/list',
          {
            data: `accountFilter=${accountId}&dateFilter.idalDateFilterType=${currentFilter}`,
          },
        );

        console.log(`List API Status: ${listResponse.status()}`);
        const listData = await listResponse.json().catch((e) => {
          console.error(`⚠️ Failed to parse Statement List JSON: ${e.message}`);
          return {};
        });

        if (!listData?.idaldocRefs) {
          continue; // Just go to next year filter
        }

        const docRefs = listData.idaldocRefs || [];
        if (docRefs.length === 0) {
          continue;
        }

        console.log(`📄 Found ${docRefs.length} statement(s).`);

        // Process each document (all in bulk mode, just the first in latest mode)
        const docsToProcess = isBulk ? docRefs : [docRefs[0]];

        for (const doc of docsToProcess) {
          const fileName = `${doc.documentDate}-statements-${accountMask}-.pdf`;
          const filePath = path.join(accountDir, fileName);

          if (fs.existsSync(filePath)) {
            console.log(`⏭️  Skipping existing statement: ${fileName}`);
            continue;
          }

          console.log(`📄 Processing Statement: ${doc.documentDate} (ID: ${doc.documentId})`);

          // 4. Get the DocKey
          console.log(`🔑 Getting Document Key for ${doc.documentDate}...`);
          const keyResponse = await chaseApi(
            page,
            'https://secure.chase.com/svc/rr/documents/secure/idal/v2/dockey/list',
            {
              data: `accountFilter=${accountId}&dateFilter.idalDateFilterType=${currentFilter}&documentId=${doc.documentId}`,
            },
          );

          console.log(`DocKey API Status: ${keyResponse.status()}`);
          const keyData = await keyResponse.json().catch((e) => {
            console.error(`⚠️ Failed to parse DocKey JSON: ${e.message}`);
            return {};
          });

          let docKey, csrfToken;

          if (keyData?.idaldockeyRefs?.length > 0) {
            docKey = keyData.idaldockeyRefs[0].docKey;
            csrfToken = keyData.csrftoken || '';
          } else if (keyData.docKey) {
            docKey = keyData.docKey;
            csrfToken = keyData.csrftoken || ''; // Fallback
          } else {
            console.error(
              'Failed to find docKey in API Response:',
              JSON.stringify(keyData, null, 2),
            );
            throw new Error('docKey not found in response.');
          }

          // Check headers for CSRF token if still missing from body
          if (!csrfToken) {
            csrfToken = ['x-jpmc-csrf-token', 'xsrf-token', 'csrf-token']
              .map((h) => keyResponse.headers()[h])
              .find(Boolean);
            if (csrfToken) {
              console.log(`Found CSRF token in DocKey Response Headers: ${csrfToken}`);
            }
          }

          console.log(` Using Final DocKey: ${docKey}`);
          console.log(` Using Final CSRF Token: ${csrfToken || 'NONE'}`);
          // Check cookies for CSRF token
          const cookies = await context.cookies();

          // Try to find a CSRF-like cookie if csrfToken is empty
          if (!csrfToken) {
            const csrfCookie = cookies.find((c) => c.name.toLowerCase().includes('csrf'));
            if (csrfCookie) {
              csrfToken = csrfCookie.value;
              console.log(`Found CSRF token in cookie: ${csrfCookie.name}`);
            }
          }

          // Attempt to extract from page environment if still missing
          if (!csrfToken) {
            console.log('🔍 Attempting to extract CSRF token from page environment...');
            csrfToken = await page
              .evaluate(() => {
                return window.csrfToken || window.envConfig?.csrfToken || window.JPMC?.csrfToken;
              })
              .catch(() => null);
            if (csrfToken) {
              console.log(`Found CSRF token in page JS: ${csrfToken}`);
            }
          }

          console.log('📥 Downloading PDF...');
          // If we still don't have it, try omitting the parameter or using 'NONE'
          const finalCsrf = csrfToken || 'NONE';
          const pdfUrl = `https://secure.chase.com/svc/rr/documents/secure/idal/v5/pdfdoc/star/list?docKey=${docKey}&sor=STAR_MS&adaVersion=false&download=true&csrftoken=${finalCsrf}`;

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

          if (pdfResponse.headers()['content-type'] !== 'application/pdf') {
            console.error('Response is not a PDF. Status:', pdfResponse.status());
            throw new Error('Download failed: Response was not a PDF.');
          }

          fs.writeFileSync(filePath, buffer);

          console.log(`✅ SUCCESS! Saved to ${filePath}`);
        } // End of Doc loop
      } // End of DateFilter loop
    } // End of Account loop
  } catch (err) {
    console.error('An error occurred:', err);
    if (page) {
      await page.screenshot({ path: path.join(screenshotDir, 'error_state.png') });
      console.log(`📸 Error screenshot saved to ${path.join(screenshotDir, 'error_state.png')}`);
    }
  } finally {
    await browser.close();
  }
}

run();
