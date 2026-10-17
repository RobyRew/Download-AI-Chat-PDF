# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/RobyRew/Download-AI-Chat-PDF/releases/tag/v1.0.0
