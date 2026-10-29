// What to tell a person when a OneNote section will not open. The importer's own messages are about
// the file format ("Root file node list did not contain a node with the root ID"); this turns the
// ones we understand into plain advice. Pure, so onenote-errors.check.ts can run it in Node.

const HOW =
  'Open it in OneNote, let it finish syncing, then export it (File → Export → Section) and try that copy.';

export function explainOneNoteError(raw: string, name: string): string {
  if (/did not contain a node with the root ID/i.test(raw)) {
    return `“${name}” is an empty OneNote section (it has no pages), or a placeholder OneNote has not finished downloading. ${HOW}`;
  }
  if (/malformed|unknown node|more bytes than declared|not a OneNote/i.test(raw)) {
    return `“${name}” could not be read: its OneNote data is damaged, cut short, or uses something Inkwell does not know yet. ${HOW} (Detail: ${raw.slice(0, 160)})`;
  }
  return `Couldn't open ${name}: ${raw || 'unknown error'}`;
}
