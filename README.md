# Download AI Chat PDF

A userscript that adds a **PDF** button to **ChatGPT, Gemini, Claude and Grok** and
saves or prints the **entire** current conversation — not just the part that happens
to be on screen — with the same look the chat has on the page.

It also takes over **⌘P / Ctrl+P** on those sites, so the shortcut you already use
prints the whole chat.

| Site | Address |
| --- | --- |
| ChatGPT | `chatgpt.com`, `chat.openai.com` |
| Gemini | `gemini.google.com` |
| Claude | `claude.ai` |
| Grok | `grok.com` |

## Why a plain ⌘P is not enough

Long chats are not fully in the page:

- **ChatGPT, Claude and Grok** use *virtualized* lists: only the messages near the
  viewport exist in the DOM, everything else is an empty block of the right height.
  Printing the page gives you a few real messages and large blank gaps.
- **Gemini** loads older turns only when you scroll to the top.
- The chat sits inside a fixed-height scroll container, which browsers print as a
  single clipped screen.

## Install

1. Install a userscript manager:
   [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari, Opera),
   [Violentmonkey](https://violentmonkey.github.io/),
   [ScriptCat](https://scriptcat.org/), or on Safari also
   [Userscripts](https://github.com/quoid/userscripts) (its menu has no script commands;
   use the ⚙ button for the options).
   On Chrome/Edge with Tampermonkey 5+, also enable **Allow User Scripts** for the
   extension (`chrome://extensions` → Tampermonkey → Details).
2. Open
   **[download-ai-chat-pdf.user.js](https://github.com/RobyRew/Download-AI-Chat-PDF/releases/latest/download/download-ai-chat-pdf.user.js)**
   and confirm the install.
3. Reload any open ChatGPT / Gemini / Claude / Grok tab.

The manager checks the latest GitHub release for updates (`@updateURL`).

## Use

- Open a conversation and click **PDF** on the pill at the top-right (drag the pill
  anywhere — the position is remembered per site), **or** press **⌘P** (macOS) / **Ctrl+P**.
- The **⚙** half of the pill opens the PDF options.
- A small card shows progress while the script loads the history and collects every
  message. Keep the tab in front; **Cancel** or **Esc** stops it.
- The print dialog opens. Choose **Save as PDF** as the destination.
  The file name defaults to `‹chat title› - ‹site› - ‹date›`.

Long chats take a while: the script has to scroll through the conversation once,
roughly one screen every few hundred milliseconds.

Printing from the browser menu (**File ▸ Print…**) cannot wait for loading, so it
prints the messages that are already in the page, merged with the last full capture of
the same chat. Use the button or the shortcut for the complete chat.

## PDF options

Click the **⚙** half of the button. Changes are saved right away (per browser, shared by
all four sites); **Save PDF** in the card starts an export.

| Option | Default | Effect |
| --- | --- | --- |
| Colours | Light | *Light* switches the site to its light theme while printing; *Same as page* keeps your current theme (dark PDF if you use dark mode) |
| Paper | Choose in dialog | *A4* / *Letter* fix the paper size; *Choose in dialog* leaves it to the print dialog |
| Orientation | Portrait | Portrait or landscape pages |
| Margins | Normal | Normal (12 mm), Narrow (6 mm) or None |
| Text size | Normal | Small (85 %), Normal, Large (115 %) |
| Title, date and link on top | On | Header block at the top of the first page |
| Images | On | Off leaves pictures out of the PDF |
| ⌘P / Ctrl+P prints the full chat | On | Off = the shortcut prints the page normally |
| Reset button position | — | Moves the button back to the top-right corner |

The userscript-manager menu (Tampermonkey, Violentmonkey) has **Save full chat as PDF**,
**PDF options…** and a switch to hide or show the floating button.

## How it works

1. Finds the chat's own scroll container and scrolls it to the top until no older
   messages arrive (this is what loads Gemini's history).
2. Sweeps down one screen at a time. At each step it deep-copies every message that is
   currently rendered, keyed by the site's message id, so messages from virtualized
   lists are captured while they are on screen. Claude's numbered rows are sorted by
   their index; the expected count (`aria-setsize`) triggers a second sweep if something
   was missed.
3. Builds one print copy at the end of `<body>`: the copied messages, wrapped in
   shallow copies of their original ancestors so the site's own CSS — fonts, bubbles,
   code blocks, tables, math — keeps applying. Fixed heights, scroll clipping,
   sidebar offsets, "Show more" clamps and copy / edit / rating buttons are removed.
4. Rewrites the layouts Chrome splits badly across printed pages, using each element's
   live computed layout: tall column flexboxes become plain blocks (keeping each item's
   alignment and gap), inline wrappers around blocks become blocks, scroll boxes lose
   their clipping, fade masks and sticky positioning are dropped.
5. Hides the rest of the page, switches to the light theme (optional), sets the tab title
   (the PDF file name), writes the `@page` size and margins, and opens the print dialog.
   The sites' own print handlers are stopped while this runs (ChatGPT, for one, mounts a
   print view of its own), and the critical styles are inline `!important` because the
   sites ship their print CSS in cascade layers. When the dialog closes, everything is
   restored.

Everything happens in your browser: no requests, no external libraries, no data
leaves the page. The script never uses `innerHTML` (Gemini enforces Trusted Types).

## Troubleshooting

- **The card says "Paused".** The tab is in the background or the window is
  covered/minimized. Browsers stop rendering hidden tabs, so the virtualized list stops
  producing messages. Bring the tab to the front and it continues.
- **The button doesn't appear.** It only shows inside a conversation. If a site changed
  its markup, the message selectors in `SITES` (top of the script) need an update —
  please [open an issue](https://github.com/RobyRew/Download-AI-Chat-PDF/issues) with
  the site and what you see.
- **Colours or bubbles are missing in the PDF.** The script asks for exact colours, but
  if your print dialog has *Background graphics* unchecked, tick it.
- **Code lines are wrapped.** Long code lines are wrapped on purpose so nothing is cut
  off at the page edge.

## Development

```
download-ai-chat-pdf.user.js   the userscript (single file, no build step)
scripts/build-release.mjs      header/syntax checks + release assets in dist/
.github/workflows/ci.yml       runs the checks on every push / PR
.github/workflows/release.yml  publishes a GitHub release when a v* tag is pushed
```

Each site is an entry in `SITES` near the top of the script:

| Field | Purpose |
| --- | --- |
| `turns` | Selectors for one message / turn, tried in order |
| `skip` | Optional filter for rows that match `turns` but are not messages |
| `key` | Stable id of a turn (used to de-duplicate while scrolling) |
| `index` | Optional numeric position for a strict sort |
| `expected` | Optional total message count, used to re-sweep |
| `scroller` | Selector for the chat's scroll container |
| `strip` | Elements removed from the copy |
| `fix` | Optional clean-up of each copied turn |
| `light` | Switches the site to its light theme; returns an undo function |
| `title` | Strips the site suffix from `document.title` |

Validate locally:

```bash
node scripts/build-release.mjs --check
```

### Releasing

1. Bump `@version` in the header **and** `const VERSION` in the script.
2. Add a `## [x.y.z]` section to `CHANGELOG.md`.
3. Commit, then tag and push the tag:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

The release workflow checks that the tag matches `@version`, attaches
`download-ai-chat-pdf.user.js` and `download-ai-chat-pdf.meta.js`, and uses the
changelog section as the release notes.

## License

[Apache-2.0](LICENSE) © 2026 [RobyRew](https://github.com/RobyRew) — see [NOTICE](NOTICE).
