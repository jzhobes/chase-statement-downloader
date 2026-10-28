import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { authenticate, confirmDashboard, waitForOneTimeCodeInput, fillOneTimeCode } from './auth';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chase-auth-test-'));
}

for (const loginRequired of [false, true]) {
  test(`successful ${loginRequired ? 'password login without MFA' : 'reused session'} saves session after dashboard confirmation`, async () => {
    const dir = temporaryDirectory();
    const stateFile = path.join(dir, 'session.json');
    const events: string[] = [];
    const oldUsername = process.env.USERNAME;
    const oldPassword = process.env.PASSWORD;
    process.env.USERNAME = 'test';
    process.env.PASSWORD = 'test';
    try {
      const page = {
        goto: async () => {},
        screenshot: async () => {},
        waitForSelector: async (selector: string) => {
          if (
            (selector.includes('userId') && !loginRequired) ||
            selector.includes('challengeIntroduction')
          ) {
            throw new Error('Not visible');
          }
          events.push(selector);
        },
        waitForURL: async (predicate: (url: URL) => boolean) => {
          if (!predicate(new URL('https://secure.chase.com/dashboard'))) {
            throw new Error('URL not reached');
          }
          events.push('dashboard-url');
        },
        getByRole: () => ({
          waitFor: async () => {
            throw new Error('Not visible');
          },
        }),
        getByText: () => ({
          waitFor: async () => {
            throw new Error('Not visible');
          },
        }),
        locator: () => ({ first: () => ({ isVisible: async () => false }) }),
        fill: async () => {},
        click: async () => {},
        url: () => 'https://secure.chase.com/dashboard',
      } as unknown as Page;
      const context = {
        storageState: async ({ path: file }: { path: string }) => {
          events.push('saved');
          fs.writeFileSync(file, '{}');
        },
      } as unknown as BrowserContext;
      await authenticate(page, context, stateFile, dir);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), '{}');
      assert.equal(events.at(-1), 'saved');
      assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    } finally {
      if (oldUsername === undefined) {
        delete process.env.USERNAME;
      } else {
        process.env.USERNAME = oldUsername;
      }
      if (oldPassword === undefined) {
        delete process.env.PASSWORD;
      } else {
        process.env.PASSWORD = oldPassword;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('dashboard timeout propagates and preserves existing session', async () => {
  const dir = temporaryDirectory();
  try {
    const stateFile = path.join(dir, 'session.json');
    fs.writeFileSync(stateFile, 'existing');
    const page = {
      waitForURL: async () => {
        throw new Error('Dashboard timeout');
      },
      getByRole: () => ({
        waitFor: async () => {
          throw new Error('Heading not found');
        },
      }),
    } as unknown as Page;
    await assert.rejects(
      confirmDashboard(page, {} as BrowserContext, stateFile),
      /Dashboard timeout/,
    );
    assert.equal(fs.readFileSync(stateFile, 'utf8'), 'existing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const stage of ['landing', 'post-login']) {
  for (const detection of ['url', 'heading']) {
    test(`System Requirements ${detection} detection fails promptly during ${stage}`, async () => {
      let signedIn = false;
      let saved = false;
      const never = () => new Promise<never>(() => {});
      const redirected = () => stage === 'landing' || signedIn;
      const page = {
        goto: async () => {},
        screenshot: async () => {},
        waitForSelector: (selector: string) =>
          selector.includes('userId') && !redirected() ? Promise.resolve() : never(),
        waitForURL: (predicate: (url: URL) => boolean) =>
          detection === 'url' &&
          redirected() &&
          predicate(new URL('https://www.chase.com/digital/resources/system-requirements'))
            ? Promise.resolve()
            : never(),
        getByRole: () => ({
          waitFor: () => (detection === 'heading' && redirected() ? Promise.resolve() : never()),
        }),
        getByText: () => ({ waitFor: never }),
        fill: async () => {},
        click: async () => {
          signedIn = true;
        },
      } as unknown as Page;
      const context = {
        storageState: async () => {
          saved = true;
        },
      } as unknown as BrowserContext;
      const previousUsername = process.env.USERNAME;
      const previousPassword = process.env.PASSWORD;
      process.env.USERNAME = 'test';
      process.env.PASSWORD = 'test';
      try {
        // Normal login waits remain unresolved, so only immediate redirect detection can finish.
        await assert.rejects(
          authenticate(page, context, 'unused-session.json', 'unused-screenshots'),
          /System Requirements.*HEADLESS=false/,
        );
        assert.equal(saved, false);
      } finally {
        if (previousUsername === undefined) {
          delete process.env.USERNAME;
        } else {
          process.env.USERNAME = previousUsername;
        }
        if (previousPassword === undefined) {
          delete process.env.PASSWORD;
        } else {
          process.env.PASSWORD = previousPassword;
        }
      }
    });
  }
}

for (const control of ['native', 'custom']) {
  test(`OTP readiness and entry work with only the ${control} input`, async () => {
    let ready = false;
    let entered = '';
    const page = {
      locator: (selector: string) => ({
        first: () => ({
          waitFor: async () => {
            if (control === 'native' && !selector.includes('autocomplete')) {
              throw new Error('Custom input does not exist');
            }
            ready = true;
          },
          count: async () => (control === 'native' ? 1 : 0),
          fill: async (value: string) => {
            entered = value;
          },
          evaluate: async (_callback: unknown, value: string) => {
            entered = value;
          },
        }),
      }),
      waitForURL: () => new Promise<never>(() => {}),
      getByRole: () => ({ waitFor: () => new Promise<never>(() => {}) }),
    } as unknown as Page;
    await waitForOneTimeCodeInput(page);
    assert.equal(ready, true);
    await fillOneTimeCode(page, '123456');
    assert.equal(entered, '123456');
  });
}

for (const waitingFor of ['dashboard URL', 'dashboard content']) {
  for (const detection of ['url', 'heading']) {
    test(`browser rejection after MFA interrupts waiting for ${waitingFor} via ${detection}`, async () => {
      let saved = false;
      const never = () => new Promise<never>(() => {});
      const page = {
        waitForURL: (predicate: (url: URL) => boolean) => {
          if (
            detection === 'url' &&
            predicate(new URL('https://www.chase.com/system-requirements'))
          ) {
            return Promise.resolve();
          }
          if (
            waitingFor === 'dashboard content' &&
            predicate(new URL('https://secure.chase.com/dashboard'))
          ) {
            return Promise.resolve();
          }
          return never();
        },
        waitForSelector: never,
        getByRole: () => ({
          waitFor: () => (detection === 'heading' ? Promise.resolve() : never()),
        }),
      } as unknown as Page;
      const context = {
        storageState: async () => {
          saved = true;
        },
      } as unknown as BrowserContext;
      await assert.rejects(
        confirmDashboard(page, context, 'unused-session.json'),
        /System Requirements.*HEADLESS=false/,
      );
      assert.equal(saved, false);
    });
  }
}
