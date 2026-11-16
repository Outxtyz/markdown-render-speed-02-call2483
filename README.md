# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Outxtyz/markdown-render-speed-02-call2483/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Outxtyz/markdown-render-speed-02-call2483/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

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
