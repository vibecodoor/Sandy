---
title: Welcome to Sandy
tags: [getting-started, markdown]
related: [[Wiki Links]]
---

# Welcome to Sandy

A quiet place to write. Everything on this page is **plain Markdown**, and it keeps looking like this while you write in it. Click into a table, a heading, the middle of a *bold word* — nothing turns back into markup under your cursor.

![A calm gradient](/sample-cover.svg)

## What is this?

Sandy is a Markdown editor for Windows 11 with a small vault built in. It opens ready to write, with its type, spacing and colours already chosen. The short version:

- You see the document, not the markup.
- Open any folder and it turns into a vault: a tree of notes with wiki-links, backlinks, and search.
- Your notes are plain `.md` files on disk. Bytes you didn't touch stay byte-for-byte the same, line endings included.
- Every save is atomic — a note is never half-written. Where git is installed, a quiet local history keeps every version you've ever had, and Sandy says so when it can't.
- It opens on the note you left, at the line you left it.

> A page, a caret, and the room around them.
> Everything else waits at the edges until you ask for it.

## A two-minute tour

### Write

Make text **bold**, *italic*, or ~~cross it off~~. Mark what matters with a ==highlight==. Inline code like `git commit -m "atomic"` sits quietly in the line, while blocks get room to breathe:

```ts
function save(doc: string, path: string) {
  // temp + fsync + rename, every save is atomic
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, doc);
  renameSync(tmp, path);
}
```

Typography is handled for you. Type `"straight quotes"`, `--`, and `...`, and the page shows "curly quotes", – and …, while the file on disk keeps exactly the characters you typed. Write a line in Russian and the quotes come out « » instead, because Sandy follows the script you're writing in. %%This sentence is a private note; it never shows up on the page, but it never leaves the file either.%% Press `Ctrl+/` on this line to see all of it as it really is.

Lists keep themselves in order:

- [x] Open Sandy
- [x] Read the welcome note
- [ ] Write something of your own

And when a thought deserves a frame, give it a callout:

> [!tip] When you do want the markup
> Everything stays rendered while you edit, so the syntax is out of your way — but sometimes you need it: a link's address, a table's columns, the type of this callout. `Ctrl+/` shows the raw Markdown of the block you're in, and puts it back the moment you leave.

### Build a vault

Press `Ctrl+Shift+O` and open any folder. It becomes your vault. The sidebar shows your notes as a tree, and nothing is indexed, synced, or locked in: the folder is the vault.

Connect thoughts with [[Wiki Links]]. Click one to follow it, or to create the note if it doesn't exist yet. Alias them like [[2026-07-18|today's note]], link out with [regular links](https://example.com), and see what points back in the Backlinks panel. Rename a note from the sidebar and every link to it is rewritten for you; delete one and it lands in the Recycle Bin, not into thin air.

`Ctrl+N` starts a new note in the folder you're reading. The tree takes the keyboard as well: Tab into it, arrow keys to walk it, `Enter` to open, `F2` to rename, `Delete` to send a note to the Recycle Bin. Renaming to `Projects/Ideas` moves the note into that folder — the row tells you where it's about to land, and the folder is made if it isn't there yet.

Give a note a properties block when you want a little structure. The calm card at the top of this page is plain YAML frontmatter. Keep tags or a status there, and any `[[link]]` inside it works like the rest. A `true` or `false` becomes a checkbox you can click. The card stays a card while you type in it; `Ctrl+/` shows the plain YAML underneath.

### Find your way

| Keys | Action |
| --- | --- |
| `Ctrl+N` | New note, in the folder you're reading |
| `Ctrl+O` | Open a file |
| `Ctrl+Shift+O` | Open a folder as a vault |
| `Ctrl+P` | Quick-open a note · type `#` to jump to a heading |
| `Ctrl+F` / `Ctrl+H` | Find · find and replace |
| `F3` / `Ctrl+D` | Next match · select the next occurrence too |
| `Ctrl+Shift+F` | Search inside notes |
| `Alt+←` / `Alt+→` | Back and forward through notes |
| `Alt+Enter` | Follow the link under the cursor |
| `Ctrl+S` | Save now — it saves itself anyway |
| `Ctrl+\` | Show or hide the sidebar |
| `F2` / `Delete` | In the sidebar: rename · to the Recycle Bin |
| `Ctrl+B` / `Ctrl+I` | Bold · italic |
| `Ctrl+Shift+X` / `Ctrl+Shift+C` | Strikethrough · inline code |
| `Ctrl+K` | Turn the selection into a link |
| `Ctrl+1` … `Ctrl+6` / `Ctrl+0` | Heading level · back to plain text |
| `Ctrl+Shift+8` / `7` / `9` | Bullet list · numbered list · quote |
| `Ctrl+Enter` | Tick a task on and off |
| `Tab` / `Shift+Tab` | Indent · outdent a list item |
| `Ctrl+Shift+V` | Paste as-is, with nothing made smart |
| `Ctrl+/` | Show the Markdown of the block you're in |
| `Shift+Right-click` | Spelling suggestions for the word under the cursor |

The sun-and-moon button up top switches between warm paper and warm ember. The quiet dot in the corner holds word count and PDF export. Right-click anywhere for the rest.

---

That's the whole manual. Paste an image, cross a few things off, follow a link. Notice how the text underneath never changes unless you change it.

One more thing, since it's your writing: nothing but Sandy ever runs against your notes — no plugin API, no extension store, no code from anyone else, and no AI reading along. Just you and the files.
