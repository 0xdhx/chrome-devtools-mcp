/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {executablePath} from 'puppeteer';
import sinon from 'sinon';

import {BrowserManager} from '../src/browser.js';
import {puppeteer, type Browser} from '../src/third_party/index.js';

import {
  createMockParsedArguments,
  createMockPuppeteerBrowser,
} from './mocks.js';
import {serverHooks} from './server.js';

async function safeClose(browser: Browser) {
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), 2000),
      ),
    ]);
  } catch {
    browser.process()?.kill('SIGKILL');
  }
}

async function runWithRetry(fn: () => Promise<void>) {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Test execution timeout exceeded')),
            20000,
          ),
        ),
      ]);
      return;
    } catch (e) {
      lastError = e as Error;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastError;
}

describe('browser', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('detects display does not crash', () => {
    BrowserManager.detectDisplay();
  });

  describe('BrowserManager', () => {
    it('launches a browser when no connect options are set and closes it on close()', async () => {
      const pptrBrowser = createMockPuppeteerBrowser();
      const launchStub = sinon.stub(puppeteer, 'launch').resolves(pptrBrowser);
      const connectStub = sinon.stub(puppeteer, 'connect');

      const args = createMockParsedArguments({
        headless: true,
        isolated: true,
        channel: 'canary',
        proxyServer: 'http://localhost:8080',
        chromeArg: ['--custom-arg'],
      });
      const manager = new BrowserManager(args);

      const browser1 = await manager.ensureBrowser();
      const browser2 = await manager.ensureBrowser();

      assert.strictEqual(browser1, pptrBrowser);
      assert.strictEqual(browser2, pptrBrowser);
      sinon.assert.calledOnce(launchStub);
      sinon.assert.notCalled(connectStub);
      sinon.assert.calledWithMatch(launchStub, {
        channel: 'chrome-canary',
        headless: true,
        args: [
          '--custom-arg',
          '--proxy-server=http://localhost:8080',
          '--hide-crash-restore-bubble',
          '--screen-info={3840x2160}',
        ],
      });

      await manager.close();
      sinon.assert.calledOnceWithExactly(pptrBrowser.close);
      sinon.assert.notCalled(pptrBrowser.disconnect);
    });

    it('connects to a browser when browserUrl is set and disconnects on close()', async () => {
      const pptrBrowser = createMockPuppeteerBrowser();
      const launchStub = sinon.stub(puppeteer, 'launch');
      const connectStub = sinon
        .stub(puppeteer, 'connect')
        .resolves(pptrBrowser);

      const args = createMockParsedArguments({
        browserUrl: 'http://127.0.0.1:9222',
        channel: 'stable',
      });
      const manager = new BrowserManager(args);

      const browser = await manager.ensureBrowser();

      assert.strictEqual(browser, pptrBrowser);
      sinon.assert.calledOnce(connectStub);
      sinon.assert.notCalled(launchStub);
      sinon.assert.calledWithMatch(connectStub, {
        browserURL: 'http://127.0.0.1:9222',
      });

      await manager.close();
      sinon.assert.calledOnceWithExactly(pptrBrowser.disconnect);
      sinon.assert.notCalled(pptrBrowser.close);
    });

    it('reconnects when existing browser is no longer connected', async () => {
      const pptrBrowser1 = createMockPuppeteerBrowser();
      const pptrBrowser2 = createMockPuppeteerBrowser();
      let isConnected = true;
      sinon.stub(pptrBrowser1, 'connected').get(() => isConnected);

      const launchStub = sinon
        .stub(puppeteer, 'launch')
        .onFirstCall()
        .resolves(pptrBrowser1)
        .onSecondCall()
        .resolves(pptrBrowser2);

      const args = createMockParsedArguments({
        headless: true,
        isolated: true,
      });
      const manager = new BrowserManager(args);

      const first = await manager.ensureBrowser();
      assert.strictEqual(first, pptrBrowser1);

      isConnected = false;
      const second = await manager.ensureBrowser();
      assert.strictEqual(second, pptrBrowser2);
      sinon.assert.calledTwice(launchStub);
    });

    it('waits for in-flight launch and closes browser when close() is called mid-launch', async () => {
      const pptrBrowser = createMockPuppeteerBrowser();
      const {promise, resolve} = Promise.withResolvers<Browser>();
      sinon.stub(puppeteer, 'launch').returns(promise);

      const args = createMockParsedArguments({
        headless: true,
        isolated: true,
      });
      const manager = new BrowserManager(args);

      const ensurePromise = manager.ensureBrowser();
      const closePromise = manager.close();

      resolve(pptrBrowser);
      await Promise.all([ensurePromise, closePromise]);

      sinon.assert.calledOnceWithExactly(pptrBrowser.close);
    });
  });

  describe('rootSandboxLaunchError', () => {
    const targetClosed = new Error(
      'Protocol error (Target.setDiscoverTargets): Target closed',
    );

    it('explains an opaque launch failure when running as root', () => {
      const error = BrowserManager.rootSandboxLaunchError(targetClosed, [], 0);
      assert.ok(error);
      assert.match(error.message, /non-root user/);
      assert.match(error.message, /pptr\.dev\/troubleshooting/);
      // The original failure stays visible so unrelated errors are not masked.
      assert.match(error.message, /Target closed/);
      assert.strictEqual(error.cause, targetClosed);
    });

    it('does not explain failures when not running as root', () => {
      assert.strictEqual(
        BrowserManager.rootSandboxLaunchError(targetClosed, [], 1000),
        undefined,
      );
    });

    it('does not explain failures on platforms without uids', () => {
      assert.strictEqual(
        BrowserManager.rootSandboxLaunchError(targetClosed, [], undefined),
        undefined,
      );
    });

    it('does not explain failures when the sandbox is already disabled', () => {
      assert.strictEqual(
        BrowserManager.rootSandboxLaunchError(
          targetClosed,
          ['--no-sandbox'],
          0,
        ),
        undefined,
      );
      assert.strictEqual(
        BrowserManager.rootSandboxLaunchError(
          targetClosed,
          ['--no-sandbox=true'],
          0,
        ),
        undefined,
      );
    });

    it('is not fooled by unrelated arguments that start the same', () => {
      assert.ok(
        BrowserManager.rootSandboxLaunchError(
          targetClosed,
          ['--no-sandbox-and-elevated'],
          0,
        ),
      );
      assert.ok(
        BrowserManager.rootSandboxLaunchError(
          targetClosed,
          ['--disable-setuid-sandbox'],
          0,
        ),
      );
    });
  });

  it('cannot launch multiple times with the same profile', async () => {
    await runWithRetry(async () => {
      const tmpDir = os.tmpdir();
      const folderPath = path.join(
        tmpDir,
        `temp-folder-${crypto.randomUUID()}`,
      );
      const browser1 = await BrowserManager.launch({
        headless: true,
        isolated: false,
        userDataDir: folderPath,
        executablePath: await executablePath(),
        devtools: false,
      });
      try {
        try {
          const browser2 = await BrowserManager.launch({
            headless: true,
            isolated: false,
            userDataDir: folderPath,
            executablePath: await executablePath(),
            devtools: false,
          });
          await safeClose(browser2);
          assert.fail('not reached');
        } catch (err) {
          assert.strictEqual(
            (err as Error).message,
            `The browser is already running for ${folderPath}. Use --isolated to run multiple browser instances.`,
          );
        }
      } finally {
        await safeClose(browser1);
      }
    });
  });

  it('launches with the initial viewport', async () => {
    await runWithRetry(async () => {
      const tmpDir = os.tmpdir();
      const folderPath = path.join(
        tmpDir,
        `temp-folder-${crypto.randomUUID()}`,
      );
      const browser = await BrowserManager.launch({
        headless: true,
        isolated: false,
        userDataDir: folderPath,
        executablePath: await executablePath(),
        viewport: {
          width: 1501,
          height: 801,
        },
        devtools: false,
      });
      try {
        const [page] = await browser.pages();
        const result = await page.evaluate(() => {
          return {width: window.innerWidth, height: window.innerHeight};
        });
        assert.deepStrictEqual(result, {
          width: 1501,
          height: 801,
        });
      } finally {
        await safeClose(browser);
      }
    });
  });

  it('connects to an existing browser with userDataDir', async () => {
    await runWithRetry(async () => {
      const tmpDir = os.tmpdir();
      const folderPath = path.join(
        tmpDir,
        `temp-folder-${crypto.randomUUID()}`,
      );
      const browser = await BrowserManager.launch({
        headless: true,
        isolated: false,
        userDataDir: folderPath,
        executablePath: await executablePath(),
        devtools: false,
        chromeArgs: ['--remote-debugging-port=0'],
      });
      try {
        const manager = new BrowserManager(
          createMockParsedArguments({
            userDataDir: folderPath,
            autoConnect: true,
            experimentalDevtools: false,
          }),
        );
        const connectedBrowser = await manager.ensureBrowser();
        assert.ok(connectedBrowser);
        assert.ok(connectedBrowser.connected);
        await manager.close();
      } finally {
        await safeClose(browser);
      }
    });
  });

  describe('Blocking', () => {
    const server = serverHooks();

    it('blocks URLs in blocklist', async () => {
      await runWithRetry(async () => {
        server.addHtmlRoute(
          '/allowed.html',
          '<html><body>Allowed</body></html>',
        );
        server.addHtmlRoute(
          '/blocked.html',
          '<html><body>Blocked</body></html>',
        );

        const browser = await BrowserManager.launch({
          headless: true,
          isolated: true,
          executablePath: await executablePath(),
          devtools: false,
          blocklist: ['*://*:*/blocked.html'],
        });
        try {
          const page = await browser.newPage();

          // Access allowed URL
          await page.goto(server.getRoute('/allowed.html'));
          const content = await page.evaluate(() => document.body.textContent);
          assert.strictEqual(content, 'Allowed');

          // Fetch of blocked URL from the page
          const fetchSucceeded = await page.evaluate(async url => {
            try {
              await fetch(url, {signal: AbortSignal.timeout(5000)});
              return true;
            } catch {
              return false;
            }
          }, server.getRoute('/blocked.html'));

          assert.strictEqual(fetchSucceeded, false);
        } finally {
          await safeClose(browser);
        }
      });
    });

    it('blocks URLs not in allowlist', async () => {
      await runWithRetry(async () => {
        server.addHtmlRoute(
          '/allowed.html',
          '<html><body>Allowed</body></html>',
        );
        server.addHtmlRoute(
          '/blocked.html',
          '<html><body>Blocked</body></html>',
        );

        const browser = await BrowserManager.launch({
          headless: true,
          isolated: true,
          executablePath: await executablePath(),
          devtools: false,
          allowlist: ['*://*:*/allowed.html'],
        });
        try {
          const page = await browser.newPage();

          // Access allowed URL
          await page.goto(server.getRoute('/allowed.html'));
          const content = await page.evaluate(() => document.body.textContent);
          assert.strictEqual(content, 'Allowed');

          // Fetch of blocked URL from the page
          const fetchSucceeded = await page.evaluate(async url => {
            try {
              await fetch(url, {signal: AbortSignal.timeout(5000)});
              return true;
            } catch {
              return false;
            }
          }, server.getRoute('/blocked.html'));

          assert.strictEqual(fetchSucceeded, false);
        } finally {
          await safeClose(browser);
        }
      });
    });
  });

  describe('makeTargetFilter', () => {
    it('filters internal chrome and extension targets', () => {
      const filterWithoutExtensions = BrowserManager.makeTargetFilter(false);
      const filterWithExtensions = BrowserManager.makeTargetFilter(true);

      const mockTarget = (url: string) => ({
        url: () => url,
      });

      // Newtab and inspect allowances
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('chrome://newtab/')),
        true,
      );
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('chrome://inspect')),
        true,
      );
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('chrome://inspect/#devices')),
        true,
      );

      // Disallowed internal schemes
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('chrome://settings')),
        false,
      );
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('chrome://version')),
        false,
      );
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('chrome-untrusted://terminal')),
        false,
      );

      // Extensions toggle
      assert.strictEqual(
        filterWithoutExtensions(
          mockTarget('chrome-extension://abcdef/popup.html'),
        ),
        false,
      );
      assert.strictEqual(
        filterWithExtensions(
          mockTarget('chrome-extension://abcdef/popup.html'),
        ),
        true,
      );

      // Web URLs
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('https://example.com')),
        true,
      );
      assert.strictEqual(
        filterWithoutExtensions(mockTarget('about:blank')),
        true,
      );
    });
  });
});
