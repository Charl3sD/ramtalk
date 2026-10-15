import { chromium, firefox, expect, type Browser, type Page } from '@playwright/test';

export const CHROMIUM_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
export const FIREFOX_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
};

export async function launch(kind: 'chromium' | 'firefox'): Promise<Browser> {
  return kind === 'chromium'
    ? chromium.launch({ args: CHROMIUM_ARGS })
    : firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS });
}

export async function openApp(browser: Browser, baseURL: string, name: string): Promise<Page> {
  const isChromium = browser.browserType().name() === 'chromium';
  // A granted camera permission (as after tapping "Allow" on a phone) makes Chromium expose
  // raw host IPs rather than mDNS names.
  // bypassCSP: the test helpers poll with string predicates (eval), which the app's CSP forbids.
  // It also makes the XSS assertions stricter, since only the sanitizer is left to protect the page.
  const ctx = await browser.newContext({ baseURL, bypassCSP: true, ...(isChromium ? { permissions: ['camera'] } : {}) });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => console.error(`[${name}] pageerror:`, e));
  if (process.env.E2E_LOG) page.on('console', (m) => console.log(`[${name}]`, m.text()));
  await page.goto('/');
  await page.getByLabel('Your name').fill(name);
  return page;
}

type Hook = {
  app: { screen: string; step: string; qrText: string; sas: string[]; items: unknown[]; notice: string; pairingError: string };
  controller: { onScan(t: string): Promise<boolean>; hostReadyToScan(): void };
};

export function state<T>(page: Page, fn: (h: Hook) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__ramtalk)`) as Promise<T>;
}

export async function waitFor(page: Page, predicate: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(`(() => { const h = window.__ramtalk; return ${predicate}; })()`, undefined, { timeout });
}

/** Runs the full two-QR pairing, injecting the QR texts instead of using a camera. */
export async function pair(host: Page, joiner: Page, replyScanDelayMs = 0): Promise<void> {
  await host.getByRole('button', { name: 'Start a conversation' }).click();
  await waitFor(host, "h.app.step === 'show' && h.app.qrText.length > 0");
  const offer = await state(host, (h) => h.app.qrText);

  await joiner.getByRole('button', { name: 'Join a conversation' }).click();
  await waitFor(joiner, "h.app.step === 'scan'");
  expect(await joiner.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), offer)).toBe(true);
  await waitFor(joiner, "h.app.step === 'show' && h.app.qrText.length > 0");
  const answer = await state(joiner, (h) => h.app.qrText);

  // In real use a person has to turn the phone around and scan; the joiner must keep waiting.
  if (replyScanDelayMs) await host.waitForTimeout(replyScanDelayMs);
  await host.getByRole('button', { name: /scan their reply/ }).click();
  await waitFor(host, "h.app.step === 'scan'");
  expect(await host.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), answer)).toBe(true);

  await waitFor(host, "h.app.screen === 'chat'");
  await waitFor(joiner, "h.app.screen === 'chat'");
}
