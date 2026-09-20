/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {ParsedArguments} from './config/mcp-options.js';
import type {
  Browser,
  ChromeReleaseChannel,
  LaunchOptions,
} from './third_party/index.js';
import {puppeteer} from './third_party/index.js';
import {logger, puppeteerLogger} from './utils/logger.js';
import {isAllowedUrl} from './utils/url.js';

export type Channel = 'stable' | 'canary' | 'beta' | 'dev';

export interface McpConnectOptions {
  browserURL?: string;
  wsEndpoint?: string;
  wsHeaders?: Record<string, string>;
  channel?: Channel;
  userDataDir?: string;
  enableExtensions?: boolean;
  blocklist?: string[];
  allowlist?: string[];
}

export interface McpLaunchOptions {
  acceptInsecureCerts?: boolean;
  executablePath?: string;
  channel?: Channel;
  userDataDir?: string;
  headless: boolean;
  isolated: boolean;
  logFile?: fs.WriteStream;
  viewport?: {
    width: number;
    height: number;
  };
  chromeArgs?: string[];
  ignoreDefaultChromeArgs?: string[];
  devtools: boolean;
  enableExtensions?: boolean;
  viaCli?: boolean;
  blocklist?: string[];
  allowlist?: string[];
}

export interface BrowserManagerOptions {
  logFile?: fs.WriteStream;
  devtools?: boolean;
  blocklist?: string[];
  allowlist?: string[];
}

export class BrowserManager {
  #browser?: Browser;
  #browserMode?: 'launched' | 'connected';
  #pendingBrowser?: Promise<Browser>;
  #serverArgs: ParsedArguments;
  #options: BrowserManagerOptions;
  #devtools: boolean;
  #blocklist?: string[];
  #allowlist?: string[];

  constructor(
    serverArgs: ParsedArguments,
    options: BrowserManagerOptions = {},
  ) {
    this.#serverArgs = serverArgs;
    this.#options = options;
    this.#devtools =
      options.devtools ?? serverArgs.experimentalDevtools ?? false;
    this.#blocklist =
      options.blocklist ??
      (serverArgs.blockedUrlPattern
        ? serverArgs.blockedUrlPattern.map(String)
        : undefined);
    this.#allowlist =
      options.allowlist ??
      (serverArgs.allowedUrlPattern
        ? serverArgs.allowedUrlPattern.map(String)
        : undefined);
  }

  static makeTargetFilter(enableExtensions = false) {
    return function targetFilter(target: {url(): string}): boolean {
      const url = target.url();
      if (!url) {
        return true;
      }
      return isAllowedUrl(url, {categoryExtensions: enableExtensions});
    };
  }

  static detectDisplay(): void {
    // Only detect display on Linux/UNIX.
    if (os.platform() === 'win32' || os.platform() === 'darwin') {
      return;
    }
    if (!process.env['DISPLAY']) {
      try {
        const result = execSync(
          `ps -u $(id -u) -o pid= | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\\0' '\\n' | grep -m1 '^DISPLAY=' | cut -d= -f2`,
        );
        const display = result.toString('utf8').trim();
        process.env['DISPLAY'] = display;
      } catch {
        // no-op
      }
    }
  }

  /**
   * Chrome refuses to start as root unless the sandbox is explicitly disabled and
   * only says so on its stderr. Because we launch with `pipe: true`, Puppeteer
   * never surfaces that stderr and the failure reaches the client as an opaque
   * `Protocol error (Target.setDiscoverTargets): Target closed`. Detect the
   * situation and explain the way out instead. See https://crbug.com/638180.
   *
   * Returns `undefined` when the failure cannot be explained by running as root,
   * including on platforms without uids and when the sandbox was already disabled
   * through `--chrome-arg` (in which case root is not what stopped Chrome).
   */
  static rootSandboxLaunchError(
    error: Error,
    args: readonly string[],
    uid = process.getuid?.(),
  ): Error | undefined {
    if (uid !== 0) {
      return undefined;
    }
    if (
      args.some(
        arg => arg === '--no-sandbox' || arg.startsWith('--no-sandbox='),
      )
    ) {
      return undefined;
    }
    return new Error(
      `Chrome failed to start: ${error.message}\n\n` +
        'chrome-devtools-mcp is running as root and Chrome does not start as root ' +
        '(https://crbug.com/638180). Run chrome-devtools-mcp as a non-root user; in a ' +
        'container, create an unprivileged user in the image and switch to it with ' +
        "USER. For the setup that Chrome's sandbox needs, see " +
        'https://pptr.dev/troubleshooting#setting-up-chrome-linux-sandbox.',
      {
        cause: error,
      },
    );
  }

  static async launch(options: McpLaunchOptions): Promise<Browser> {
    const {channel, executablePath, headless, isolated} = options;
    const profileDirName =
      channel && channel !== 'stable'
        ? `chrome-profile-${channel}`
        : 'chrome-profile';

    let userDataDir = options.userDataDir;
    if (!isolated && !userDataDir) {
      userDataDir = path.join(
        os.homedir(),
        '.cache',
        options.viaCli ? 'chrome-devtools-mcp-cli' : 'chrome-devtools-mcp',
        profileDirName,
      );
      await fs.promises.mkdir(userDataDir, {
        recursive: true,
      });
    }

    const args: LaunchOptions['args'] = [
      ...(options.chromeArgs ?? []),
      '--hide-crash-restore-bubble',
    ];
    const ignoreDefaultArgs: LaunchOptions['ignoreDefaultArgs'] =
      options.ignoreDefaultChromeArgs ?? false;

    if (headless) {
      args.push('--screen-info={3840x2160}');
    }
    let puppeteerChannel: ChromeReleaseChannel | undefined;
    if (options.devtools) {
      args.push('--auto-open-devtools-for-tabs');
    }
    if (!executablePath) {
      puppeteerChannel =
        channel && channel !== 'stable' ? `chrome-${channel}` : 'chrome';
    }

    if (!headless) {
      BrowserManager.detectDisplay();
    }

    try {
      const browser = await puppeteer.launch({
        channel: puppeteerChannel,
        targetFilter: BrowserManager.makeTargetFilter(options.enableExtensions),
        executablePath,
        defaultViewport: null,
        userDataDir,
        pipe: true,
        headless,
        args,
        ignoreDefaultArgs: ignoreDefaultArgs,
        acceptInsecureCerts: options.acceptInsecureCerts,
        handleDevToolsAsPage: true,
        enableExtensions: options.enableExtensions,
        blocklist: options.blocklist,
        allowlist: options.allowlist,
        logger: puppeteerLogger,
      });
      if (options.logFile) {
        // FIXME: we are probably subscribing too late to catch startup logs. We
        // should expose the process earlier or expose the getRecentLogs() getter.
        browser.process()?.stderr?.pipe(options.logFile);
        browser.process()?.stdout?.pipe(options.logFile);
      }
      if (options.viewport) {
        const [page] = await browser.pages();
        await page?.resize({
          contentWidth: options.viewport.width,
          contentHeight: options.viewport.height,
        });
      }
      return browser;
    } catch (error) {
      if (
        userDataDir &&
        error instanceof Error &&
        error.message.includes('The browser is already running')
      ) {
        throw new Error(
          `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
          {
            cause: error,
          },
        );
      }
      if (error instanceof Error) {
        const rootError = BrowserManager.rootSandboxLaunchError(error, args);
        if (rootError) {
          throw rootError;
        }
      }
      throw error;
    }
  }

  static async connect(options: McpConnectOptions): Promise<Browser> {
    const {channel, enableExtensions} = options;

    const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
      targetFilter: BrowserManager.makeTargetFilter(enableExtensions),
      defaultViewport: null,
      handleDevToolsAsPage: true,
      blocklist: options.blocklist,
      allowlist: options.allowlist,
      logger: puppeteerLogger,
    };

    let autoConnect = false;
    if (options.wsEndpoint) {
      connectOptions.browserWSEndpoint = options.wsEndpoint;
      if (options.wsHeaders) {
        connectOptions.headers = options.wsHeaders;
      }
    } else if (options.browserURL) {
      connectOptions.browserURL = options.browserURL;
    } else if (channel || options.userDataDir) {
      const userDataDir = options.userDataDir;
      if (userDataDir) {
        autoConnect = true;
        // TODO: re-expose this logic via Puppeteer.
        const portPath = path.join(userDataDir, 'DevToolsActivePort');
        try {
          const fileContent = await fs.promises.readFile(portPath, 'utf8');
          const [rawPort, rawPath] = fileContent
            .split('\n')
            .map(line => {
              return line.trim();
            })
            .filter(line => {
              return !!line;
            });
          if (!rawPort || !rawPath) {
            throw new Error(
              `Invalid DevToolsActivePort '${fileContent}' found`,
            );
          }
          const port = parseInt(rawPort, 10);
          if (isNaN(port) || port <= 0 || port > 65535) {
            throw new Error(`Invalid port '${rawPort}' found`);
          }
          const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
          connectOptions.browserWSEndpoint = browserWSEndpoint;
        } catch (error) {
          throw new Error(
            `Could not connect to Chrome in ${userDataDir}. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`,
            {
              cause: error,
            },
          );
        }
      } else {
        if (!channel) {
          throw new Error('Channel must be provided if userDataDir is missing');
        }
        connectOptions.channel =
          channel === 'stable' ? 'chrome' : `chrome-${channel}`;
      }
    } else {
      throw new Error(
        'Either browserURL, wsEndpoint, channel or userDataDir must be provided',
      );
    }

    logger?.('Connecting Puppeteer to ', JSON.stringify(connectOptions));
    try {
      const connected = await puppeteer.connect(connectOptions);
      logger?.('Connected Puppeteer');
      return connected;
    } catch (err) {
      throw new Error(
        `Could not connect to Chrome. ${autoConnect ? `Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.` : `Check if Chrome is running.`}`,
        {
          cause: err,
        },
      );
    }
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.#browser?.connected) {
      return this.#browser;
    }
    if (this.#pendingBrowser) {
      return await this.#pendingBrowser;
    }

    const pending = this.#initBrowser();
    this.#pendingBrowser = pending;
    try {
      return await pending;
    } finally {
      if (this.#pendingBrowser === pending) {
        this.#pendingBrowser = undefined;
      }
    }
  }

  async #initBrowser(): Promise<Browser> {
    if (
      this.#serverArgs.browserUrl ||
      this.#serverArgs.wsEndpoint ||
      this.#serverArgs.autoConnect
    ) {
      return await this.#ensureBrowserConnected();
    }
    return await this.#ensureBrowserLaunched();
  }

  async #ensureBrowserConnected(): Promise<Browser> {
    // Assign mode before browser so a concurrent close() never sees
    // `browser` set with `browserMode` still undefined (would fall through
    // to the disconnect() path and orphan a launched Chrome).
    const connected = await BrowserManager.connect({
      browserURL: this.#serverArgs.browserUrl,
      wsEndpoint: this.#serverArgs.wsEndpoint,
      wsHeaders: this.#serverArgs.wsHeaders,
      // Important: only pass channel, if autoConnect is true.
      channel: this.#serverArgs.autoConnect
        ? this.#serverArgs.channel
        : undefined,
      userDataDir: this.#serverArgs.userDataDir,
      enableExtensions: this.#serverArgs.categoryExtensions,
      blocklist: this.#blocklist,
      allowlist: this.#allowlist,
    });
    this.#browserMode = 'connected';
    this.#browser = connected;
    return this.#browser;
  }

  async #ensureBrowserLaunched(): Promise<Browser> {
    const chromeArgs: string[] = (this.#serverArgs.chromeArg ?? []).map(String);
    const ignoreDefaultChromeArgs: string[] = (
      this.#serverArgs.ignoreDefaultChromeArg ?? []
    ).map(String);
    if (this.#serverArgs.proxyServer) {
      chromeArgs.push(`--proxy-server=${this.#serverArgs.proxyServer}`);
    }
    // Assign mode before browser; see the connect path above for rationale.
    const launched = await BrowserManager.launch({
      headless: this.#serverArgs.headless,
      executablePath: this.#serverArgs.executablePath,
      channel: this.#serverArgs.channel,
      isolated: this.#serverArgs.isolated ?? false,
      userDataDir: this.#serverArgs.userDataDir,
      logFile: this.#options.logFile,
      viewport: this.#serverArgs.viewport,
      chromeArgs,
      ignoreDefaultChromeArgs,
      acceptInsecureCerts: this.#serverArgs.acceptInsecureCerts,
      devtools: this.#devtools,
      enableExtensions: this.#serverArgs.categoryExtensions,
      viaCli: this.#serverArgs.viaCli,
      blocklist: this.#blocklist,
      allowlist: this.#allowlist,
    });
    this.#browserMode = 'launched';
    this.#browser = launched;
    return this.#browser;
  }

  /**
   * Shutdown hook for the active browser. Closes a launched browser (so the
   * Chrome subprocess is reaped) or disconnects from an attached browser (so
   * the user's Chrome instance stays alive). No-op if no browser is active or
   * the connection has already been dropped.
   */
  async close(): Promise<void> {
    const pending = this.#pendingBrowser;
    this.#pendingBrowser = undefined;
    if (pending) {
      await pending.catch(() => {
        // Ignore in-flight launch/connect errors during shutdown.
      });
    }
    const browser = this.#browser;
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (!browser || !browser.connected) {
      return;
    }
    if (mode === 'launched') {
      await browser.close().catch(err => {
        logger?.('Failed to close browser', err);
      });
      return;
    }
    await browser.disconnect().catch(err => {
      logger?.('Failed to disconnect from browser', err);
    });
  }

  [Symbol.dispose](): void {
    this.close().catch(() => {
      // TODO: wire up the logger
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
