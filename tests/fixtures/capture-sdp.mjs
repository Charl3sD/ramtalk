// Captures real offer/answer SDPs (as the app creates them) from Playwright's browsers into
// tests/fixtures/sdp/. Run: node tests/fixtures/capture-sdp.mjs
import { chromium, firefox } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const OUT = new URL('./sdp/', import.meta.url);

async function capture(page, withCamera) {
  return page.evaluate(async (withCamera) => {
    let stream;
    if (withCamera) stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const gather = (pc) =>
      new Promise((res) => {
        if (pc.iceGatheringState === 'complete') return res();
        const t = setTimeout(res, 3000);
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(t), res()));
      });
    const mk = () => {
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      pc.createDataChannel('ramtalk', { negotiated: true, id: 0, ordered: true });
      return pc;
    };
    const a = mk();
    const b = mk();
    await a.setLocalDescription(await a.createOffer());
    await gather(a);
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await gather(b);
    const out = { offer: a.localDescription.sdp, answer: b.localDescription.sdp };
    a.close();
    b.close();
    stream?.getTracks().forEach((t) => t.stop());
    return out;
  }, withCamera);
}

const targets = [
  ['chrome', chromium, { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }],
  ['firefox', firefox, { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } }],
];

for (const [name, type, opts] of targets) {
  const browser = await type.launch(opts);
  for (const cam of [false, true]) {
    // A granted camera permission is what makes Chrome expose raw host IPs instead of mDNS names.
    const ctx = await browser.newContext(cam && name === 'chrome' ? { permissions: ['camera'] } : {});
    const page = await ctx.newPage();
    // Any secure-context page will do; localhost counts as secure, so serve a stub from a route.
    await page.route('http://localhost/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>sdp</title>' }),
    );
    await page.goto('http://localhost/');
    const { offer, answer } = await capture(page, cam);
    const tag = cam ? 'camera' : 'nocamera';
    writeFileSync(new URL(`${name}-${tag}-offer.sdp`, OUT), offer);
    writeFileSync(new URL(`${name}-${tag}-answer.sdp`, OUT), answer);
    console.log(name, tag, 'offer', offer.length, 'answer', answer.length);
    await ctx.close();
  }
  await browser.close();
}
