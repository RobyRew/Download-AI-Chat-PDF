# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-17

### Added

- The floating button is a split pill: **PDF** exports, the **⚙** half opens a PDF
  options card (same style as the progress card) with colours, paper size (A4 / Letter
  / chosen in the dialog), orientation, margins (normal / narrow / none), text size,
  header on/off, images on/off, the ⌘P / Ctrl+P takeover, reset button position and a
  Save PDF button. Paper, orientation and margins are written as an `@page` rule only
  while a print is staged.
- Userscript-manager menu: **PDF options…** (the individual toggles moved into the card).

### Changed

- ChatGPT printed a blank PDF: on `beforeprint` ChatGPT mounts its own print document,
  and its `body:has(> .printDocument) > :not(.printDocument) { display: none !important }`
  rule sits in a cascade layer, which outranks an unlayered `!important`. The script's
  `beforeprint` listener (registered at document-start) now stops the sites' print
  handlers while it prints, the page is hidden with inline `!important` styles, and
  anything mounted into `<body>` during the print is hidden as well.
- Gemini lines overlapped and the end of the chat was cut: Chrome split tall column
  flexboxes badly across pages. Each copied message is now rewritten from the live
  computed layout — tall column flex / stacked grid containers become blocks (child
  alignment, gaps and blockified display kept), inline wrappers around in-flow blocks
  become blocks, scroll boxes get `overflow: visible`, masks and sticky/fixed
  positioning are dropped. Gemini's fade mask on the chat scroller no longer reaches the
  PDF.
- Claude's chat sat in a narrow column on one side: the outer app wrappers carried the
  sidebar width as `padding-left`. Wrappers at or above the chat's scroll container now
  lose their side padding and margins in the copy.
- Claude's answer action bar (copy / read aloud / rating / retry) was printed: its icons
  are icon-font glyphs, so the buttons were not empty. Private-use and format characters
  no longer count as button text, and buttons whose `aria-label` is a known action are
  dropped too.
- Grok code blocks were light text on a light background after switching to the light
  theme (tokens coloured for dark only). Code blocks where both the text and the
  background are light get a dark background in the PDF.
- Colours are read through a 1×1 canvas, so `oklch()` / `color()` values are understood;
  plain `rgb()` parsing is the fallback when canvas reads are blocked.
- The fallback stylesheet (managers without `GM_addStyle`) waits for `<html>` to exist
  instead of throwing at document-start.

## [1.0.0] - 2026-10-17

### Added

- Floating **PDF** button on ChatGPT (`chatgpt.com`, `chat.openai.com`), Gemini
  (`gemini.google.com`), Claude (`claude.ai`) and Grok (`grok.com`). Drag to move;
  the position is remembered per site.
- **⌘P / Ctrl+P** runs the same full-chat export instead of printing only the
  messages currently on screen.
- Full-chat capture: scrolls the chat to the top until no older messages arrive,
  then sweeps down one screen at a time copying every message as it renders.
  Covers lazy-loaded history (Gemini) and virtualized lists that keep only the
  visible messages in the page (ChatGPT, Claude, Grok).
- Print copy keeps the site's own styling: messages are deep-copied and wrapped in
  shallow copies of their original ancestors so the page CSS keeps applying.
- Long prompts that the site collapses behind "Show more" are printed in full;
  copy / edit / rating buttons are left out.
- Light theme for printing (default) or the page's current theme, PDF header with
  title / site / export date / link, and the tab title set to the chat title so the
  saved file is named after the chat.
- Progress card with Cancel (and Esc); export pauses while the tab is in the
  background because hidden tabs stop rendering.
- Browser-menu printing (File ▸ Print…) prints the messages already loaded, merged
  with the last full capture of the same chat.
- Tampermonkey menu: export, theme, header, ⌘P takeover, button visibility,
  reset button position.

[1.1.0]: https://github.com/RobyRew/Download-AI-Chat-PDF/releases/tag/v1.1.0
[1.0.0]: https://github.com/RobyRew/Download-AI-Chat-PDF/releases/tag/v1.0.0
