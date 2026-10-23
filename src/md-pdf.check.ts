// Run: node src/md-pdf.check.ts [out.pdf] — a Markdown note becomes PDF pages without errors, and
// a long one breaks across pages.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { drawMarkdown } from './md-pdf.ts';

// 1×1 PNG, as a note's picture (data URL)
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const long = Array.from(
  { length: 60 },
  (_, i) =>
    `Line ${i + 1} of a long paragraph that needs wrapping across the page width again and again.`,
).join('\n\n');
const md = `# Week 4 notes

Some **bold**, some *italic*, ~~struck~~, \`inline code\` and a [link](https://example.com/a/very/long/address/that/will/not/fit/on/one/line/at/all/really/not).

- first
- second
  - nested *item*
    - deeper
1. one
2. two

- [ ] todo item
- [x] done item

> a quote that
> spans lines
>> and a nested one

\`\`\`python
print("hi")  # a long line ${'x'.repeat(120)}
\`\`\`

| Name | Score |
| --- | --- |
| Ada | 10 |
| Bob with a rather long name that wraps in its cell | 7 |

---

![dot](data:image/png;base64,${PNG})

Café, naïve, 日本語 and ✓ print as ? where the font can't.

## Second heading

${long}
`;

const doc = await PDFDocument.create();
const cache = new Map<string, Awaited<ReturnType<typeof doc.embedFont>>>();
const names = {
  regular: StandardFonts.Helvetica,
  bold: StandardFonts.HelveticaBold,
  italic: StandardFonts.HelveticaOblique,
  boldItalic: StandardFonts.HelveticaBoldOblique,
  mono: StandardFonts.Courier,
};
const keys = Object.keys(names) as (keyof typeof names)[];
for (const k of keys) cache.set(k, await doc.embedFont(names[k]));
const fonts = {
  get: (o: { bold?: boolean; italic?: boolean; mono?: boolean }) =>
    cache.get(
      o.mono
        ? 'mono'
        : o.bold && o.italic
          ? 'boldItalic'
          : o.bold
            ? 'bold'
            : o.italic
              ? 'italic'
              : 'regular',
    )!,
  printable: (f: { encodeText(s: string): unknown }, s: string) =>
    [...s]
      .map((ch) => {
        try {
          f.encodeText(ch);
          return ch;
        } catch {
          return '?';
        }
      })
      .join(''),
};
const pages = await drawMarkdown(doc, md, fonts, rgb);
assert.ok(pages >= 3, `expected a long note to break across pages, got ${pages}`);
assert.equal(doc.getPageCount(), pages);
// empty and odd input doesn't throw
const d2 = await PDFDocument.create();
for (const k of keys) cache.set(k, await d2.embedFont(names[k]));
assert.equal(await drawMarkdown(d2, '', fonts, rgb), 1);
assert.ok((await drawMarkdown(d2, '<div>html</div>\n\n***\n\n| a |\n|---|\n', fonts, rgb)) >= 1);
if (process.argv[2]) writeFileSync(process.argv[2], await doc.save());
console.log('md-pdf checks passed (' + pages + ' pages)');
