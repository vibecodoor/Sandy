# Sandy

A Markdown editor for Windows 11. You see the finished page, not the markup — and the file on disk stays exactly as you wrote it.

- **You see the page.** No `**stars**`, no `#` — not even with the cursor inside a bold word or a table. `Ctrl+/` shows the raw Markdown of one block when you want it. Find reads that same page: `Ctrl+F` never stops on a word hidden inside a link's address.
- **Your files stay yours.** Plain `.md` in a plain folder. Edit one line, save, and every other byte is untouched — line endings included. (A file that *mixes* CRLF and LF is the one exception, and Sandy tells you when it opens one.)
- **A folder is a vault.** Tree, `[[wiki-links]]`, backlinks, search. No database, no account, no sync.
- **Quietly safe.** Atomic saves, deletes go to the Recycle Bin, and where git is installed, a quiet local history of every version — Sandy says so when it can't find it.
- **Nothing to configure.** There is no settings screen. First launch is the finished thing.

## Install

Download `Sandy_x.y.z_x64-setup.exe` from [Releases](https://github.com/vibecodoor/sandy/releases) and run it. About 4 MB, no bundled browser, works offline.

Builds aren't signed yet, so SmartScreen may grumble the first time: *More info* → *Run anyway*.

## Shortcuts

| Keys | Does |
| --- | --- |
| `Ctrl+N` | New note, in the folder you're reading |
| `Ctrl+O` / `Ctrl+Shift+O` | Open a file · open a folder as a vault |
| `Ctrl+P` | Quick-open a note (type `#` to jump to a heading) |
| `Ctrl+F` / `Ctrl+H` | Find · find and replace |
| `Ctrl+Shift+F` | Search the vault |
| `Alt+←` / `Alt+→` | Back and forward through notes |
| `Alt+Enter` | Follow the link under the cursor |
| `Ctrl+/` | Show the Markdown of this block |
| `Ctrl+Shift+V` | Paste raw |
| `Ctrl+\` | Show or hide the sidebar |
| `F2` / `Delete` | In the tree: rename · send to the Recycle Bin |

Everything else lives under the dot in the bottom-right corner: how long the note is — words, characters, paragraphs, reading time, and the same for whatever you've selected — plus PDF export, show in Explorer, and three switches: typewriter, focus, smart typography.

## What it doesn't do

No plugins, no sync, no accounts, no AI, no theme store, no tabs, no settings screen. Leaving them out is the point.

## License

MIT — see [LICENSE](LICENSE).
