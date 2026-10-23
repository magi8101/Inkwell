import { marked, type Token, type Tokens } from 'marked';
import type { PDFDocument, PDFFont, PDFImage, PDFPage, rgb as Rgb } from 'pdf-lib';

// A Markdown note as PDF pages: headings, paragraphs with bold/italic/code/links, nested lists and
// checkboxes, code blocks, quotes, tables, pictures and rules, with page breaks. Uses the standard
// PDF fonts the rest of the export uses (Western European text only). pdf-lib is passed in, so this
// module has no value import of it and can be checked in Node (md-pdf.check.ts).

export interface MdFonts {
  /** One of the four text faces, or the monospaced one. */
  get(o: { bold?: boolean; italic?: boolean; mono?: boolean }): PDFFont;
  /** The text with whatever the font can't print replaced by "?". */
  printable(f: PDFFont, s: string): string;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  strike: boolean;
  link: boolean;
}
interface Seg {
  text: string;
  font: PDFFont;
  size: number;
  run: Run;
}

const BODY = 11;
const HEAD = [22, 17, 14, 12.5, 11.5, 11];
const LEADING = 1.4;
const INDENT = 16;

/** Adds the note's pages to `doc`; returns how many. */
export async function drawMarkdown(
  doc: PDFDocument,
  md: string,
  fonts: MdFonts,
  rgb: typeof Rgb,
  pageSize: [number, number] = [595.28, 841.89],
  margin = 56,
): Promise<number> {
  const [pageW, pageH] = pageSize;
  const textW = pageW - margin * 2;
  const ink = rgb(0.1, 0.1, 0.12);
  const dim = rgb(0.4, 0.4, 0.45);
  const blue = rgb(0.1, 0.35, 0.8);
  const faint = rgb(0.93, 0.93, 0.95);
  const line = rgb(0.78, 0.78, 0.82);
  let page!: PDFPage;
  let y = 0;
  let pages = 0;
  const newPage = () => {
    page = doc.addPage(pageSize);
    y = pageH - margin;
    pages++;
  };
  const ensure = (h: number) => {
    if (y - h < margin) newPage();
  };
  newPage();

  // --- Inline content → styled runs → wrapped lines ---

  const runsOf = (tokens: Token[] | undefined, base: Partial<Run> = {}): Run[] => {
    const out: Run[] = [];
    const style = (over: Partial<Run>): Run => ({
      text: '',
      bold: false,
      italic: false,
      mono: false,
      strike: false,
      link: false,
      ...base,
      ...over,
    });
    for (const t of tokens ?? []) {
      switch (t.type) {
        case 'strong':
          out.push(...runsOf((t as Tokens.Strong).tokens, { ...base, bold: true }));
          break;
        case 'em':
          out.push(...runsOf((t as Tokens.Em).tokens, { ...base, italic: true }));
          break;
        case 'del':
          out.push(...runsOf((t as Tokens.Del).tokens, { ...base, strike: true }));
          break;
        case 'link':
          out.push(...runsOf((t as Tokens.Link).tokens, { ...base, link: true }));
          break;
        case 'codespan':
          out.push(style({ text: (t as Tokens.Codespan).text, mono: true }));
          break;
        case 'br':
          out.push(style({ text: '\n' }));
          break;
        case 'checkbox':
          break; // the list draws its own [ ] / [x] marker
        case 'image':
          out.push(style({ text: `[${(t as Tokens.Image).text || 'image'}]`, italic: true }));
          break;
        case 'html':
        case 'escape':
        case 'text': {
          const x = t as Tokens.Text;
          if (x.tokens?.length) out.push(...runsOf(x.tokens, base));
          else out.push(style({ text: decode(x.text ?? (t as { raw: string }).raw) }));
          break;
        }
        default: {
          const x = t as { text?: string; raw?: string };
          out.push(style({ text: decode(x.text ?? x.raw ?? '') }));
        }
      }
    }
    return out;
  };

  const lineBreaks = (runs: Run[], size: number, width: number): Seg[][] => {
    const lines: Seg[][] = [[]];
    let used = 0;
    const put = (seg: Seg, w: number) => {
      const cur = lines[lines.length - 1]!;
      const last = cur[cur.length - 1];
      if (last && last.font === seg.font && last.run === seg.run) last.text += seg.text;
      else cur.push(seg);
      used += w;
    };
    for (const run of runs) {
      const font = fonts.get({ bold: run.bold, italic: run.italic, mono: run.mono });
      const sz = run.mono ? size * 0.92 : size;
      const parts = run.text.split(/(\n|\s+)/).filter((s) => s !== '');
      for (const part of parts) {
        if (part === '\n') {
          lines.push([]);
          used = 0;
          continue;
        }
        const text = fonts.printable(font, part);
        const w = font.widthOfTextAtSize(text, sz);
        const space = /^\s+$/.test(part);
        if (space) {
          if (used > 0) put({ text: ' ', font, size: sz, run }, font.widthOfTextAtSize(' ', sz));
          continue;
        }
        if (used + w > width && used > 0) {
          lines.push([]);
          used = 0;
        }
        if (w > width) {
          // A word wider than the line (a long URL): break it by characters.
          let piece = '';
          for (const ch of text) {
            if (font.widthOfTextAtSize(piece + ch, sz) > width && piece) {
              put({ text: piece, font, size: sz, run }, font.widthOfTextAtSize(piece, sz));
              lines.push([]);
              used = 0;
              piece = '';
            }
            piece += ch;
          }
          if (piece) put({ text: piece, font, size: sz, run }, font.widthOfTextAtSize(piece, sz));
        } else put({ text: text, font, size: sz, run }, w);
      }
    }
    // Trailing spaces make lines look uneven; trim them.
    for (const l of lines) {
      const last = l[l.length - 1];
      if (last) last.text = last.text.replace(/\s+$/, '');
    }
    return lines;
  };

  /** Draws wrapped runs at `x`, `width` wide, one line at a time (so it can break across pages). */
  const paragraph = (runs: Run[], x: number, width: number, size: number, quotes: number) => {
    const lh = size * LEADING;
    for (const ln of lineBreaks(runs, size, width)) {
      ensure(lh);
      let cx = x;
      for (const seg of ln) {
        if (!seg.text) continue;
        const w = seg.font.widthOfTextAtSize(seg.text, seg.size);
        const baseline = y - seg.size * 0.95;
        if (seg.run.mono)
          page.drawRectangle({
            x: cx - 1,
            y: baseline - 2.5,
            width: w + 2,
            height: seg.size + 1.5,
            color: faint,
          });
        page.drawText(seg.text, {
          x: cx,
          y: baseline,
          size: seg.size,
          font: seg.font,
          color: seg.run.link ? blue : ink,
        });
        if (seg.run.link || seg.run.strike) {
          const ly = seg.run.strike ? baseline + seg.size * 0.3 : baseline - 1.5;
          page.drawLine({
            start: { x: cx, y: ly },
            end: { x: cx + w, y: ly },
            thickness: 0.6,
            color: seg.run.link ? blue : ink,
          });
        }
        cx += w;
      }
      for (let q = 0; q < quotes; q++)
        page.drawRectangle({
          x: margin + q * 10 + 2,
          y: y - lh,
          width: 2,
          height: lh,
          color: line,
        });
      y -= lh;
    }
  };

  // --- Blocks ---

  const images = async (tokens: Token[] | undefined, x: number, width: number) => {
    for (const t of tokens ?? []) {
      if (t.type !== 'image') continue;
      const src = (t as Tokens.Image).href;
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(src);
      if (!m) continue;
      try {
        const bytes = Uint8Array.from(atob(m[2]!), (c) => c.charCodeAt(0));
        const img: PDFImage = /png/i.test(m[1]!)
          ? await doc.embedPng(bytes)
          : await doc.embedJpg(bytes);
        const k = Math.min(1, width / img.width, 420 / img.height) * 0.75;
        const w = img.width * k;
        const h = img.height * k;
        ensure(h + 6);
        page.drawImage(img, { x, y: y - h, width: w, height: h });
        y -= h + 6;
      } catch {
        // A picture that won't embed is skipped; its alt text is already in the paragraph.
      }
    }
  };

  const block = async (
    tokens: Token[],
    x: number,
    width: number,
    quotes: number,
  ): Promise<void> => {
    for (const t of tokens) {
      switch (t.type) {
        case 'space':
        case 'checkbox': // a task item's own marker is drawn by the list
          break;
        case 'heading': {
          const h = t as Tokens.Heading;
          const size = HEAD[Math.min(5, h.depth - 1)]!;
          ensure(size * LEADING * 2);
          y -= h.depth <= 2 ? 8 : 4;
          paragraph(runsOf(h.tokens, { bold: true }), x, width, size, quotes);
          y -= 3;
          break;
        }
        case 'paragraph': {
          const p = t as Tokens.Paragraph;
          paragraph(runsOf(p.tokens), x, width, BODY, quotes);
          await images(p.tokens, x, width);
          y -= 5;
          break;
        }
        case 'text': {
          const p = t as Tokens.Text;
          paragraph(runsOf(p.tokens ?? [t]), x, width, BODY, quotes);
          await images(p.tokens, x, width);
          y -= 2;
          break;
        }
        case 'list': {
          const l = t as Tokens.List;
          let n = Number(l.start) || 1;
          for (const item of l.items) {
            const marker = item.task ? (item.checked ? '[x]' : '[ ]') : l.ordered ? `${n++}.` : '•';
            const f = fonts.get({});
            ensure(BODY * LEADING);
            page.drawText(fonts.printable(f, marker), {
              x: x + 2,
              y: y - BODY * 0.95,
              size: BODY,
              font: f,
              color: dim,
            });
            await block(
              item.tokens,
              x + INDENT + (item.task ? 6 : 0),
              width - INDENT - (item.task ? 6 : 0),
              quotes,
            );
          }
          y -= 3;
          break;
        }
        case 'code': {
          const c = t as Tokens.Code;
          const f = fonts.get({ mono: true });
          const size = 9.5;
          const lh = size * 1.35;
          const wrapW = width - 12;
          y -= 2;
          for (const raw of c.text.replace(/\t/g, '    ').split('\n')) {
            const text = fonts.printable(f, raw);
            const chunks: string[] = [];
            let piece = '';
            for (const ch of text) {
              if (f.widthOfTextAtSize(piece + ch, size) > wrapW && piece) {
                chunks.push(piece);
                piece = '';
              }
              piece += ch;
            }
            chunks.push(piece);
            for (const chunk of chunks) {
              ensure(lh);
              page.drawRectangle({ x, y: y - lh, width, height: lh, color: faint });
              page.drawText(chunk, { x: x + 6, y: y - size * 1.05, size, font: f, color: ink });
              y -= lh;
            }
          }
          y -= 6;
          break;
        }
        case 'blockquote':
          await block((t as Tokens.Blockquote).tokens, x + 12, width - 12, quotes + 1);
          break;
        case 'hr':
          ensure(10);
          y -= 5;
          page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.8, color: line });
          y -= 7;
          break;
        case 'table': {
          const tb = t as Tokens.Table;
          const cols = tb.header.length;
          const cw = width / cols;
          const pad = 4;
          const row = (cells: Tokens.TableCell[], head: boolean) => {
            const laid = cells.map((c) =>
              lineBreaks(runsOf(c.tokens, { bold: head }), BODY - 1, cw - pad * 2),
            );
            const lh = (BODY - 1) * LEADING;
            const h = Math.max(...laid.map((l) => l.length)) * lh + pad * 2;
            ensure(h);
            if (head) page.drawRectangle({ x, y: y - h, width, height: h, color: faint });
            laid.forEach((lines, i) => {
              let ly = y - pad;
              for (const ln of lines) {
                let cx = x + i * cw + pad;
                for (const seg of ln) {
                  if (!seg.text) continue;
                  page.drawText(seg.text, {
                    x: cx,
                    y: ly - seg.size * 0.95,
                    size: seg.size,
                    font: seg.font,
                    color: ink,
                  });
                  cx += seg.font.widthOfTextAtSize(seg.text, seg.size);
                }
                ly -= lh;
              }
              page.drawRectangle({
                x: x + i * cw,
                y: y - h,
                width: cw,
                height: h,
                borderColor: line,
                borderWidth: 0.6,
              });
            });
            y -= h;
          };
          row(tb.header, true);
          for (const r of tb.rows) row(r, false);
          y -= 8;
          break;
        }
        default: {
          const x2 = t as { text?: string; raw?: string };
          const text = decode(x2.text ?? x2.raw ?? '').trim();
          if (text)
            paragraph(
              [{ text, bold: false, italic: false, mono: false, strike: false, link: false }],
              x,
              width,
              BODY,
              quotes,
            );
        }
      }
    }
  };

  await block(marked.lexer(md), margin, textW, 0);
  return pages;
}

/** Marked leaves a few HTML entities in text tokens. */
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
