// The Tiptap editor behind Markdown notes, in its own chunk: loaded on the first note shown.
import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

export function createEditor(
  el: HTMLElement,
  md: string,
  on: { onUpdate: () => void; onSelection: () => void },
  editable = true,
): Editor {
  el.replaceChildren();
  return new Editor({
    element: el,
    editable,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image,
      Placeholder.configure({
        placeholder: 'Type here — # for a heading, - for a list, [ ] for a checkbox',
      }),
      Markdown,
    ],
    content: md,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'md-doc', spellcheck: 'true' } },
    onUpdate: on.onUpdate,
    onSelectionUpdate: on.onSelection,
    onTransaction: on.onSelection,
  });
}
