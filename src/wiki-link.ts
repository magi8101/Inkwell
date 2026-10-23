// [[Page name]] links in Markdown notes, as in Obsidian: typing [[Name]] makes a link, clicking it
// opens the page with that name (the note module creates it when there is none), and the note
// still saves as plain [[Name]] text, so the .md file reads the same in any other app. An alias,
// [[Name|shown text]], shows the text and is written back unchanged.
import { mergeAttributes, Node, nodeInputRule, nodePasteRule } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

const SYNTAX = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/;
// The rules below must have no capture group: with one, Tiptap replaces only the captured text and
// leaves the brackets behind. Name and alias are read from the whole match instead.
const WHOLE = /\[\[[^\]\n|]+(?:\|[^\]\n]+)?\]\]/;
const attrsOf = (m: RegExpMatchArray) => {
  const x = SYNTAX.exec(m[0]);
  return { target: x?.[1]?.trim() ?? '', alias: x?.[2]?.trim() ?? '' };
};

export interface WikiLinkOptions {
  onOpen: (name: string) => void;
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ onOpen: () => {} }),
  // `alias` is the text shown when the file says [[Name|shown text]].
  addAttributes: () => ({ target: { default: '' }, alias: { default: '' } }),
  parseHTML: () => [
    {
      tag: 'a[data-wikilink]',
      getAttrs: (el) => ({
        target: (el as HTMLElement).getAttribute('data-wikilink'),
        alias: (el as HTMLElement).getAttribute('data-alias') ?? '',
      }),
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => [
    'a',
    mergeAttributes(HTMLAttributes, {
      class: 'wikilink',
      'data-wikilink': node.attrs.target,
      'data-alias': node.attrs.alias || null,
    }),
    node.attrs.alias || node.attrs.target,
  ],
  // Markdown: [[Name]] and [[Name|shown text]] in the file.
  markdownTokenizer: {
    name: 'wikiLink',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize: (src: string) => {
      const m = new RegExp(`^${SYNTAX.source}`).exec(src);
      return m
        ? { type: 'wikiLink', raw: m[0], target: m[1]!.trim(), alias: m[2]?.trim() ?? '' }
        : undefined;
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode('wikiLink', { target: token.target, alias: token.alias ?? '' }),
  renderMarkdown: (node) =>
    `[[${node.attrs?.target ?? ''}${node.attrs?.alias ? `|${node.attrs.alias}` : ''}]]`,
  addInputRules() {
    return [
      nodeInputRule({
        find: new RegExp(`${WHOLE.source}$`),
        type: this.type,
        getAttributes: attrsOf,
      }),
    ];
  },
  addPasteRules() {
    return [
      nodePasteRule({
        find: new RegExp(WHOLE.source, 'g'),
        type: this.type,
        getAttributes: attrsOf,
      }),
    ];
  },
  addProseMirrorPlugins() {
    const open = (name: string) => this.options.onOpen(name);
    return [
      new Plugin({
        props: {
          handleClick: (_view, _pos, event) => {
            const el = (event.target as HTMLElement).closest?.('a.wikilink');
            if (!el) return false;
            open(el.getAttribute('data-wikilink') ?? '');
            return true;
          },
        },
      }),
    ];
  },
});
