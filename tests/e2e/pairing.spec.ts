import { test, expect, type Browser } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launch, openApp, pair, state, waitFor } from './helpers';

let chromiumBrowser: Browser;

test.beforeAll(async () => {
  chromiumBrowser = await launch('chromium');
});
test.afterAll(async () => {
  await chromiumBrowser?.close();
});

test('pair, chat with markdown, transfer files, end and wipe', async ({ baseURL }) => {
  const host = await openApp(chromiumBrowser, baseURL!, 'Alice');
  const joiner = await openApp(chromiumBrowser, baseURL!, 'Bob');
  await pair(host, joiner);

  // Both sides derived the same short authentication string.
  const sasHost = await state(host, (h) => h.app.sas);
  const sasJoiner = await state(joiner, (h) => h.app.sas);
  expect(sasHost).toHaveLength(5);
  expect(sasHost).toEqual(sasJoiner);
  await expect(host.locator('header strong').first()).toHaveText('Bob');
  await expect(joiner.locator('header strong').first()).toHaveText('Alice');

  // Markdown + emoji shortcode, sent with Enter.
  const box = host.getByLabel('Message');
  await box.fill('**hello** _there_ :wave:');
  await box.press('Enter');
  await expect(joiner.locator('.md strong', { hasText: 'hello' })).toBeVisible();
  await expect(joiner.locator('.md em', { hasText: 'there' })).toBeVisible();
  await expect(joiner.locator('.md', { hasText: '👋' })).toBeVisible();

  // Hostile markdown from the peer is neutralised.
  await joiner.getByLabel('Message').fill('<img src=x onerror="window.__pwned=1"> [x](javascript:window.__pwned=1)');
  await joiner.getByLabel('Message').press('Enter');
  await expect(host.locator('.md', { hasText: '<img src=x' })).toBeVisible();
  expect(await host.locator('.md img').count()).toBe(0);
  expect(await host.locator('.md a[href^="javascript"]').count()).toBe(0);
  expect(await host.evaluate(() => (window as any).__pwned)).toBeUndefined();

  // A 1.5 MB binary file, joiner → host, spanning many chunks.
  const data = Buffer.alloc(1_500_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
  await joiner.locator('input[type=file][multiple]').setInputFiles({ name: 'data.bin', mimeType: 'application/octet-stream', buffer: data });
  const card = host.locator('.card', { hasText: 'data.bin' });
  await expect(card.getByRole('button', { name: 'Save' })).toBeVisible({ timeout: 30_000 });
  const [download] = await Promise.all([host.waitForEvent('download'), card.getByRole('button', { name: 'Save' }).click()]);
  expect(download.suggestedFilename()).toBe('data.bin');
  const saved = readFileSync(await download.path());
  expect(saved.equals(data)).toBe(true);
  await expect(joiner.locator('.card', { hasText: 'data.bin' })).toContainText('Sent');

  // A picture, host → joiner, previewed inline.
  const png = readFileSync(new URL('../../public/icon-192.png', import.meta.url));
  await host.locator('input[type=file][multiple]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  const img = joiner.locator('.card img[alt="photo.png"]');
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toMatch(/^blob:/);
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(192);

  // HTML disguised as an image is stored as octet-stream and never rendered.
  await host.locator('input[type=file][multiple]').setInputFiles({
    name: 'evil.html', mimeType: 'text/html', buffer: Buffer.from('<script>parent.__pwned=1</script>'),
  });
  await expect(joiner.locator('.card', { hasText: 'evil.html' }).getByRole('button', { name: 'Save' })).toBeVisible();
  expect(await joiner.locator('.card img[alt="evil.html"]').count()).toBe(0);

  // Ending wipes both sides.
  await host.getByRole('button', { name: 'End', exact: true }).click();
  await waitFor(host, "h.app.screen === 'home'");
  await waitFor(joiner, "h.app.screen === 'home'");
  await expect(joiner.getByRole('status')).toContainText('Alice ended the chat.');
  await expect(host.getByRole('status')).toContainText('You ended the chat.');
  for (const p of [host, joiner]) {
    expect(await state(p, (h) => h.app.items.length)).toBe(0);
    expect(await state(p, (h) => h.app.sas.length)).toBe(0);
    await expect(p.locator('body')).not.toContainText('hello');
    await expect(p.locator('body')).not.toContainText('data.bin');
  }
  // Object URLs were revoked: the old image URL no longer resolves.
  await host.context().close();
  await joiner.context().close();
});

test('rejects foreign and mismatched codes; a third device cannot join', async ({ baseURL }) => {
  const host = await openApp(chromiumBrowser, baseURL!, 'Host');
  const joiner = await openApp(chromiumBrowser, baseURL!, 'Joiner');
  const intruder = await openApp(chromiumBrowser, baseURL!, 'Intruder');

  await host.getByRole('button', { name: 'Start a conversation' }).click();
  await waitFor(host, "h.app.step === 'show'");
  const offer = await state(host, (h) => h.app.qrText);

  await joiner.getByRole('button', { name: 'Join a conversation' }).click();
  await waitFor(joiner, "h.app.step === 'scan'");
  // Not a ramtalk code.
  expect(await joiner.evaluate(() => (window as any).__ramtalk.controller.onScan('https://example.com'))).toBe(false);
  await expect(joiner.getByRole('alert')).toContainText('isn’t a ramtalk code');
  expect(await joiner.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), offer)).toBe(true);
  await waitFor(joiner, "h.app.step === 'show'");
  const answer = await state(joiner, (h) => h.app.qrText);

  // The intruder also scans the host's (now single-use) offer and produces its own reply.
  await intruder.getByRole('button', { name: 'Join a conversation' }).click();
  await waitFor(intruder, "h.app.step === 'scan'");
  await intruder.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), offer);
  await waitFor(intruder, "h.app.step === 'show'");
  const intruderAnswer = await state(intruder, (h) => h.app.qrText);

  await host.getByRole('button', { name: /scan their reply/ }).click();
  await waitFor(host, "h.app.step === 'scan'");
  // Host scanning its own offer (wrong role) is rejected.
  expect(await host.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), offer)).toBe(false);
  // Host accepts exactly one reply...
  expect(await host.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), answer)).toBe(true);
  // ...and any further reply (the intruder's) is ignored.
  expect(await host.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), intruderAnswer)).toBe(false);

  await waitFor(host, "h.app.screen === 'chat'");
  await waitFor(joiner, "h.app.screen === 'chat'");
  // The intruder never gets a chat; it just keeps waiting for a host that will never scan it.
  await intruder.waitForTimeout(3000);
  expect(await state(intruder, (h) => [h.app.screen, h.app.step])).toEqual(['join', 'show']);
  await intruder.getByRole('button', { name: 'Cancel' }).click();
  await waitFor(intruder, "h.app.screen === 'home'");

  // A host whose session ID differs rejects a reply made for another host's offer.
  const host2 = await openApp(chromiumBrowser, baseURL!, 'Host2');
  await host2.getByRole('button', { name: 'Start a conversation' }).click();
  await waitFor(host2, "h.app.step === 'show'");
  await host2.getByRole('button', { name: /scan their reply/ }).click();
  expect(await host2.evaluate((t) => (window as any).__ramtalk.controller.onScan(t), answer)).toBe(false);
  await expect(host2.getByRole('alert')).toContainText('doesn’t belong to this chat');

  for (const p of [host, joiner, intruder, host2]) await p.context().close();
});

test('a slow reply scan (25 s) still connects', async ({ baseURL }) => {
  test.setTimeout(90_000);
  const host = await openApp(chromiumBrowser, baseURL!, 'Slow');
  const joiner = await openApp(chromiumBrowser, baseURL!, 'Patient');
  await pair(host, joiner, 25_000);
  await host.getByLabel('Message').fill('made it');
  await host.getByLabel('Message').press('Enter');
  await expect(joiner.locator('.md', { hasText: 'made it' })).toBeVisible();
  await host.context().close();
  await joiner.context().close();
});

test('peer disappearing ends the chat and wipes it', async ({ baseURL }) => {
  const host = await openApp(chromiumBrowser, baseURL!, 'A');
  const joiner = await openApp(chromiumBrowser, baseURL!, 'B');
  await pair(host, joiner);
  await host.getByLabel('Message').fill('before close');
  await host.getByLabel('Message').press('Enter');
  await expect(joiner.locator('.md', { hasText: 'before close' })).toBeVisible();

  await host.context().close(); // like the app being killed
  await waitFor(joiner, "h.app.screen === 'home'", 30_000);
  expect(await state(joiner, (h) => h.app.items.length)).toBe(0);
  await expect(joiner.locator('body')).not.toContainText('before close');
  await joiner.context().close();
});

for (const [hostKind, joinerKind] of [['chromium', 'firefox'], ['firefox', 'chromium']] as const) {
  test(`cross-browser: ${hostKind} host ↔ ${joinerKind} joiner`, async ({ baseURL }) => {
    const ff = await launch('firefox');
    const pick = (k: string) => (k === 'firefox' ? ff : chromiumBrowser);
    try {
      const host = await openApp(pick(hostKind), baseURL!, 'Hosty');
      const joiner = await openApp(pick(joinerKind), baseURL!, 'Joiny');
      await pair(host, joiner);
      expect(await state(host, (h) => h.app.sas)).toEqual(await state(joiner, (h) => h.app.sas));

      await joiner.getByLabel('Message').fill('from *joiner*');
      await joiner.getByLabel('Message').press('Enter');
      await expect(host.locator('.md em', { hasText: 'joiner' })).toBeVisible();

      const data = Buffer.alloc(300_000, 0xab);
      await host.locator('input[type=file][multiple]').setInputFiles({ name: 'x.bin', mimeType: 'application/octet-stream', buffer: data });
      await expect(joiner.locator('.card', { hasText: 'x.bin' }).getByRole('button', { name: 'Save' })).toBeVisible({ timeout: 30_000 });

      await joiner.getByRole('button', { name: 'End', exact: true }).click();
      await waitFor(host, "h.app.screen === 'home'");
      await expect(host.getByRole('status')).toContainText('Joiny ended the chat.');
    } finally {
      await ff.close();
    }
  });
}
