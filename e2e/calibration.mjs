// The pen calibration wizard with pens that lack things: no hover (touching down answers the Hover
// step) and no pressure (the pressure steps are skipped with an explanation), plus a firm stroke that
// is no firmer than the light one (asked to be written again). Chromium. Usage: npm run web:build &&
// npx vite preview --port 4173, then npm run e2e:calibration
import { chromium } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const R = {};
const open = async () => {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  p.setDefaultTimeout(15000);
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  await p.locator('[aria-label="Pen feel and palm settings"]').click();
  await p.getByText('Calibrate my pen…').click();
  await p.waitForSelector('.cal-pad');
  return p;
};
const title = (p) => p.locator('.cal-title').innerText();
const status = (p) => p.locator('.cal-status, .cal-card [aria-live], .cal-card .cal-text').allInnerTexts();
// A stroke of pen events on the pad, with a pressure per sample.
const stroke = (p, pressures, id = 1) =>
  p.evaluate(
    async ({ pressures, id }) => {
      const pad = document.querySelector('.cal-pad');
      const r = pad.getBoundingClientRect();
      const ev = (type, i) =>
        pad.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', clientX: r.left + 40 + i * 4, clientY: r.top + r.height * 0.6 + Math.sin(i / 5) * 8, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, pressure: pressures[Math.min(i, pressures.length - 1)], bubbles: true, cancelable: true }));
      ev('pointerdown', 0);
      for (let i = 1; i < pressures.length; i++) {
        ev('pointermove', i);
        if (i % 8 === 0) await new Promise((r) => setTimeout(r, 2));
      }
      ev('pointerup', pressures.length);
    },
    { pressures, id },
  );
const waitTitle = async (p, prefix) => {
  for (let i = 0; i < 80; i++) {
    if ((await title(p)).startsWith(prefix)) return true;
    await p.waitForTimeout(100);
  }
  return false;
};

// 1. A pen with no hover: touching the pad during the Hover step moves on to "Hold still".
{
  const p = await open();
  R.startsAtHover = (await title(p)).startsWith('1.');
  await p.evaluate(() => {
    const pad = document.querySelector('.cal-pad');
    const r = pad.getBoundingClientRect();
    pad.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, pointerType: 'pen', clientX: r.left + 50, clientY: r.top + 50, button: 0, buttons: 1, pressure: 0.5, bubbles: true, cancelable: true }));
    pad.dispatchEvent(new PointerEvent('pointerup', { pointerId: 5, pointerType: 'pen', clientX: r.left + 50, clientY: r.top + 50, button: 0, buttons: 0, pressure: 0, bubbles: true, cancelable: true }));
  });
  R.touchDownAnswersHover = await waitTitle(p, '2.');
}

// 2. A pen with no pressure (always 0.5): the light step says so and the firm step is skipped.
{
  const p = await open();
  await p.evaluate(() => {
    const pad = document.querySelector('.cal-pad');
    const r = pad.getBoundingClientRect();
    pad.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, pointerType: 'pen', clientX: r.left + 60, clientY: r.top + 60, button: -1, buttons: 0, pressure: 0, bubbles: true }));
  });
  await waitTitle(p, '2.');
  // Hold still: 220 samples in one place for over two seconds.
  await p.evaluate(async () => {
    const pad = document.querySelector('.cal-pad');
    const r = pad.getBoundingClientRect();
    const e = (t, b) => pad.dispatchEvent(new PointerEvent(t, { pointerId: 11, pointerType: 'pen', clientX: r.left + 200, clientY: r.top + 200, button: t === 'pointermove' ? -1 : 0, buttons: b, pressure: 0.5, bubbles: true, cancelable: true }));
    e('pointerdown', 1);
    for (let i = 0; i < 220; i++) {
      e('pointermove', 1);
      await new Promise((r) => setTimeout(r, 11));
    }
    e('pointerup', 0);
  });
  await waitTitle(p, '3.');
  await stroke(p, new Array(180).fill(0.5), 12);
  await p.waitForTimeout(300);
  const said = (await p.locator('.cal-card').innerText()).replace(/\s+/g, ' ');
  R.flatPenIsToldSo = /one fixed pressure/i.test(said);
  R.flatPenSkipsFirm = await waitTitle(p, '5.'); // 3 light, 4 firm (skipped), 5 fast circles
}

// 3. Firm writing that is no firmer than the light writing is asked for again, not accepted.
{
  const p = await open();
  await p.evaluate(() => {
    const pad = document.querySelector('.cal-pad');
    const r = pad.getBoundingClientRect();
    pad.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, pointerType: 'pen', clientX: r.left + 60, clientY: r.top + 60, button: -1, buttons: 0, pressure: 0, bubbles: true }));
  });
  await waitTitle(p, '2.');
  await p.evaluate(async () => {
    const pad = document.querySelector('.cal-pad');
    const r = pad.getBoundingClientRect();
    const e = (t, b) => pad.dispatchEvent(new PointerEvent(t, { pointerId: 11, pointerType: 'pen', clientX: r.left + 200 + (Math.random() - 0.5), clientY: r.top + 200, button: t === 'pointermove' ? -1 : 0, buttons: b, pressure: 0.5, bubbles: true, cancelable: true }));
    e('pointerdown', 1);
    for (let i = 0; i < 220; i++) {
      e('pointermove', 1);
      await new Promise((r) => setTimeout(r, 11));
    }
    e('pointerup', 0);
  });
  await waitTitle(p, '3.');
  const spread = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
  await stroke(p, spread(0.1, 0.35, 180), 13); // light
  await waitTitle(p, '4.');
  await stroke(p, spread(0.12, 0.37, 180), 14); // "firm" but no firmer
  await p.waitForTimeout(500);
  const said = (await p.locator('.cal-card').innerText()).replace(/\s+/g, ' ');
  R.weakFirmIsRefused = /hardly firmer/i.test(said) && (await title(p)).startsWith('4.');
}

await browser.close();
console.log(R);
process.exit(Object.values(R).every(Boolean) ? 0 : 1);
