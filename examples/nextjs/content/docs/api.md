---
title: Package API
description: The package's imports, the core functions for building and searching an index, and what each entry point exports.
section: Reference
label: Package API
order: 29
---

The package has one CLI and these imports. Each is tree-shakeable, and only `ondocs/node`, `ondocs/integration`, the framework plugins and the CLI touch Node.js built-ins, so the rest runs on edge runtimes, in workers and in browsers.

| Import                          | For                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ondocs`                        | Loaders, chunking, `buildIndex`, `checkIndex`, `loadIndex`, `retrieve`, `buildLlmsFiles`, `mcpInstallLinks`                                                                          |
| `ondocs/node`                   | `loadDirectory`, `readIndexFile`, `writeIndexFile`, and the config module's types                                                                                                    |
| `ondocs/integration`            | The build helpers the plugins are made of, for [writing an integration](/docs/writing-an-integration)                                                                                |
| `ondocs/server`                 | `createAskHandler`, `createMcpHandler`, `remoteIndex`, the rate limiters, the budget and answer cache stores                                                                         |
| `ondocs/react`                  | `AskDialog`, `AskButton`, `useAsk`, `AskAnswer`, `McpInstall` and `loadAskDialog`; needs `@radix-ui/react-dialog` and `cmdk`                                                         |
| `ondocs/embed`                  | `mountAskDialog`: the dialog and its button without writing React; `openAskDialog`, to open any page's dialog. Needs the site's React, `@radix-ui/react-dialog` and `cmdk`           |
| `ondocs/embed/standalone`       | The same `mountAskDialog` and `openAskDialog`, with React, Radix and cmdk built into the dialog's chunk, for a site without React. The Astro, Starlight and VitePress plugins use it |
| `ondocs/docusaurus`             | The [Docusaurus plugin](/docs/docusaurus)                                                                                                                                            |
| `ondocs/astro`                  | The [Astro integration](/docs/astro)                                                                                                                                                 |
| `ondocs/starlight`              | The [Starlight plugin](/docs/astro)                                                                                                                                                  |
| `ondocs/vitepress`              | The [VitePress plugin](/docs/vitepress): `withOndocs`                                                                                                                                |
| `ondocs/astro/McpInstall.astro` | The "Add to Cursor / VS Code / Claude" block for an Astro or Starlight page                                                                                                          |
| `ondocs/mock`                   | `mockEmbeddingModel` and `mockLanguageModel`, for tests and offline demos                                                                                                            |
| `ondocs` (bin)                  | [`ondocs index`, `init`, `dev` and `eval`](/docs/cli)                                                                                                                                |

The handlers are documented in [The ask endpoint](/docs/ask-endpoint) and [MCP server](/docs/mcp), and the React components in [The ask dialog](/docs/ask-dialog).

## Build and search an index yourself

The plugins and the CLI are built on these functions, which work on content from anywhere:

```ts
import { buildIndex, fromMarkdown, loadIndex, retrieve, serializeIndexFile } from 'ondocs';

const doc = fromMarkdown(source, { id: 'guide.md', url: '/guide' });
const { index, stats } = await buildIndex({ documents: [doc], embeddingModel, previous });
const loaded = loadIndex(serializeIndexFile(index));
const { hits, answerable, best } = retrieve(loaded, { text: question, vector });
```

`buildIndex` takes the previous index as `previous`, to reuse the vectors of chunks whose text is unchanged. `retrieve` returns the hits that passed the [relevance gate](/docs/retrieval), whether any did, and the best raw signals, for tuning the gate's thresholds.

## Also exported

- **Loaders:** `fromHtml` (`root` picks the part of a page to read, as a selector such as `[data-pagefind-body]`, `ignore` what to leave out, and `markdown` keeps links and tables for a Markdown copy), `fromMarkdown` (`mdx`, `markdown`) and `fromDocuments`.
- **The index file:** `chunkDocument`, `checkIndex`, `parseIndexFile`, `validateIndexFile` and `serializeIndexFile`.
- **The relevance gate:** `gateHits`, which checks hits from anywhere (a reranker, a retriever of your own) against the index, as `createAskHandler` does after its [retrieval hooks](/docs/retrieval#rerank-or-retrieve-your-own-way).
- **Text:** `createSlugger`, to use in your renderer so citations' anchors always match your headings, and `tokenize` (experimental).
- **Search's building blocks:** `Bm25Index`, `VectorIndex`, `reciprocalRankFusion`, `quantizeInt8`, `encodeVector` and `decodeVector`, all experimental.
- **Bot check:** `turnstile` from `ondocs/server`, for the ask endpoint's `challenge`: see [Bot check with Turnstile](/docs/bot-challenge).
- **For agents:** `buildLlmsFiles` and `markdownPath`, which build `llms.txt`, `llms-full.txt` and the pages' `.md` copies from any list of pages, and `mcpInstallLinks`, the install links and commands for an MCP server's URL.

## Experimental

The rest of the package's API is stable: a minor version adds to it, and an option or export it renames keeps its old name working, with a warning, until 1.0. [Upgrading](/docs/upgrading) lists each rename. The exports below may still change in a minor version before 1.0:

- **From `ondocs`, the search's building blocks**, whose output follows the search as it improves: `Bm25Index`, `Bm25Options`, `Bm25Result`, `VectorIndex`, `reciprocalRankFusion`, `FusedResult`, `quantizeInt8`, `cosineSimilarity`, `encodeVector`, `decodeVector`, `encodeBase64`, `decodeBase64`, `tokenize`, `chunkSearchText`, `embeddingSettingsKey` and `CHUNKER_VERSION`.
- **From `ondocs/integration`, the plugins' own plumbing:** `consoleLogger`, `excluder`, `hintDevEndpoint`, `quietUseClient` and `warnMissingDialogPeers`, and `checkOptions` with `optionRules` (and their types `OptionRule`, `OptionRules`, `OptionRuleSet` and `OptionShapeExtras`), which check a plugin's options as its config gives them.

A new export, or an option added for one site's needs, starts in this list, and leaves it once its shape has settled.

Every import's exports, and every option they take, are in the package's API report, [`test/__snapshots__/api-report.txt`](https://github.com/dgesteves/ondocs/blob/main/test/__snapshots__/api-report.txt). The tests compare the source with it, so a change to the public API shows in the pull request that makes it.
