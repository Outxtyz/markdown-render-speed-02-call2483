# markdown-render-speed-02

[![competition](https://make.fun/api/competitions/markdown-render-speed-02/badge.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![rank](https://make.fun/api/competitions/markdown-render-speed-02/leaderboard/Outxtyz/badge.svg)](https://make.fun/competitions/markdown-render-speed-02)
[![reward](https://make.fun/api/competitions/markdown-render-speed-02/reward/badge.svg)](https://make.fun/competitions/markdown-render-speed-02)

A fast, dependency-free Markdown parser whose output is byte-for-byte identical
to marked 18.1.3 (`marked.parse`, default options: GFM on, breaks off).

- `parse.js` — the parser: a block lexer (headings, paragraphs, lists, tables,
  code fences, blockquotes, HTML blocks, thematic breaks, setext headings,
  link reference definitions) plus an inline lexer (emphasis, strong, code
  spans, links, images, autolinks, strikethrough, entities, backslash escapes,
  inline HTML, hard breaks). Written from scratch for this bounty.
- `main.ts` — the driver: reads `/input/cases.json`, renders each case with
  `parse`, writes `/output/html.json`.

Built for [make.fun](https://make.fun).
