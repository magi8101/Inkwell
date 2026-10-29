// "Report a problem" is reachable from the notebook menu (and About), and its text holds device facts
// and never note contents. Chromium, Firefox, WebKit.
// Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:menus
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const fails = [];
for (const [engine, type] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  const browser = await type.launch();
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  p.setDefaultTimeout(15000);
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  const R = {};
  // Something private on the page, to prove the report does not carry it.
  await p.keyboard.press('t');
  await p.mouse.click(500, 400);
  await p.keyboard.type('SECRET-NOTE-TEXT-12345');
  await p.keyboard.press('Escape');
  await p.locator('.nb-switch').click();
  await p.getByText('Report a problem…').click();
  const box = p.locator('.cal-card textarea.report-text');
  await box.waitFor();
  const text = await box.inputValue();
  R.menuOpensTheReport = text.startsWith('Inkwell problem report');
  R.reportHasDeviceFacts = /DEVICE/.test(text) && /SPEED/.test(text) && /PEN FEEL/.test(text);
  R.reportNeverHasNoteText = !text.includes('SECRET-NOTE-TEXT-12345');
  R.reportCountsTheContent = /1 text boxes/.test(text);
  R.noErrors = errors.length === 0;
  await browser.close();
  const bad = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${engine}: ${bad.length ? 'FAIL' : 'ok'}`, bad.length ? bad : '', errors.length ? errors : '');
  if (bad.length) fails.push(engine);
}
process.exit(fails.length ? 1 : 0);
