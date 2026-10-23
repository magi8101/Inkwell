// Markdown note features in Chromium, Firefox and WebKit: [[links]] and the contents page.
// Usage: npm run web:build && npm run preview (another terminal), then npm run e2e:notes
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
let failed = 0;
for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  const browser = await engine.launch();
  const p = await (await browser.newContext({ viewport: { width: 1368, height: 912 } })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  const R = {};
  const state = () =>
    p.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 150));
      return new Promise((res) => {
        const q = indexedDB.open('inkwell');
        q.onsuccess = () => {
          const g = q.result.transaction('kv').objectStore('kv').get('inkwell:state');
          g.onsuccess = () => {
            const s = g.result;
            const pages = s.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages);
            res({ cur: pages.find((x) => x.id === s.pageId), titles: pages.map((x) => x.title), pages });
          };
        };
      });
    });
  // A note with a link to a page that doesn't exist yet.
  await p.locator('[aria-label="New Markdown note"]').click();
  await p.waitForSelector('.md-doc');
  await p.click('.md-doc');
  await p.keyboard.type('See [[Target page]] later');
  await p.waitForTimeout(800);
  R.typedLinkBecomesLink = (await p.locator('.md-doc a.wikilink').first().textContent()) === 'Target page';
  const s1 = await state();
  R.savesAsPlainMarkdown = s1.cur.md.includes('[[Target page]]') && !s1.cur.md.includes('\\[');
  const sourceId = s1.cur.id;
  // An alias is kept: [[Name|shown text]] shows the text and saves back unchanged.
  await p.keyboard.type(' and [[Target page|the target]]');
  await p.waitForTimeout(800);
  R.aliasShownAndKept =
    (await p.locator('.md-doc a.wikilink').allTextContents()).includes('the target') &&
    (await state()).cur.md.includes('[[Target page|the target]]');
  // Clicking it creates and opens that page.
  await p.locator('.md-doc a.wikilink').first().click();
  await p.waitForTimeout(700);
  const s2 = await state();
  R.linkCreatesPage = s2.cur.title === 'Target page' && s2.cur.md !== undefined && s2.cur.id !== sourceId;
  // Going back and clicking again opens the same page, not a second one.
  await p.locator(`.row.page[data-id="${sourceId}"]`).click();
  await p.waitForSelector('.md-doc a.wikilink');
  await p.locator('.md-doc a.wikilink').first().click();
  await p.waitForTimeout(600);
  const s3 = await state();
  R.linkReopensSamePage = s3.cur.id === s2.cur.id && s3.titles.filter((t) => t === 'Target page').length === 1;
  // The link survives a reload (it is read back from the Markdown).
  await p.locator(`.row.page[data-id="${sourceId}"]`).click();
  await p.waitForTimeout(500);
  await p.reload();
  await p.waitForSelector('.md-doc a.wikilink', { timeout: 15000 });
  R.linkSurvivesReload = (await p.locator('.md-doc a.wikilink').first().textContent()) === 'Target page';
  // Contents page for the folder.
  await p.locator('.row.section [aria-label="Folder options"]').first().click();
  await p.getByText('Make a contents page', { exact: true }).click();
  await p.waitForSelector('.md-doc a.wikilink');
  const links = await p.locator('.md-doc a.wikilink').allTextContents();
  const s4 = await state();
  R.contentsListsPages = s4.cur.title.endsWith('— contents') && links.includes('Target page') && links.length >= 2;
  await p.waitForTimeout(800); // the sidebar list refreshes when idle
  const first = await p.$eval('.row.page .name', (e) => e.textContent);
  R.contentsFirstInFolder = first.endsWith('— contents');
  R.noErrors = errors.length === 0;
  await browser.close();
  console.log(`${name}: ${Object.values(R).every(Boolean) ? 'ok' : 'FAIL'}`);
  for (const [k, v] of Object.entries(R)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (!Object.values(R).every(Boolean)) failed++;
}
process.exit(failed ? 1 : 0);
