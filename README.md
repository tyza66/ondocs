# ondocs

**Open-source Ask AI for your docs.** Cited answers on your own model key, and an MCP server for coding agents, from one index built with your Starlight, Docusaurus or VitePress site. No vendor, no vector database.

For teams that run their own developer docs, at product, API and platform companies, who want Ask AI without a hosted assistant.

[![CI](https://img.shields.io/github/actions/workflow/status/dgesteves/ondocs/ci.yml?branch=main&label=CI&style=flat-square&labelColor=181c22)](https://github.com/dgesteves/ondocs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ondocs?style=flat-square&labelColor=181c22&color=0e7490)](https://www.npmjs.com/package/ondocs)
[![Script tag: 3.2 KB gzipped](https://img.shields.io/badge/script_tag-3.2_KB_gzipped-0e7490?style=flat-square&labelColor=181c22)](https://ondocs.vercel.app/docs/script-tag)
[![License: MIT](https://img.shields.io/badge/license-MIT-0e7490?style=flat-square&labelColor=181c22)](./LICENSE)
[![Types](https://img.shields.io/badge/types-included-0e7490?style=flat-square&labelColor=181c22)](https://ondocs.vercel.app/docs/api)

**Answers with**
[![OpenAI](https://img.shields.io/badge/OpenAI-181c22?style=flat-square)](https://ondocs.vercel.app/docs/model-providers#openai)
[![Anthropic](https://img.shields.io/badge/Anthropic-181c22?style=flat-square&logo=anthropic&logoColor=white)](https://ondocs.vercel.app/docs/model-providers#anthropic-and-claude)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-181c22?style=flat-square&logo=googlegemini&logoColor=white)](https://ondocs.vercel.app/docs/model-providers#google-gemini)
[![xAI Grok](https://img.shields.io/badge/xAI_Grok-181c22?style=flat-square)](https://ondocs.vercel.app/docs/model-providers#xai-and-grok)
[![Workers AI](https://img.shields.io/badge/Workers_AI-181c22?style=flat-square&logo=cloudflare&logoColor=white)](https://ondocs.vercel.app/docs/model-providers#workers-ai)
[![any AI SDK provider](https://img.shields.io/badge/any_AI_SDK_provider-181c22?style=flat-square)](https://ondocs.vercel.app/docs/model-providers#any-other-ai-sdk-provider)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dgesteves/ondocs/tree/main/templates/cloudflare-worker)

**Ask these docs from your editor**, over this site's MCP server:
[![Cursor](https://img.shields.io/badge/Cursor-Add_server-181c22?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=ondocs&config=eyJ1cmwiOiJodHRwczovL29uZG9jcy52ZXJjZWwuYXBwL2FwaS9tY3AifQ%3D%3D)
[![VS Code](https://img.shields.io/badge/VS_Code-Add_server-007ACC?style=flat-square)](https://insiders.vscode.dev/redirect/mcp/install?name=ondocs&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fondocs.vercel.app%2Fapi%2Fmcp%22%7D)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Add_server-b4532a?style=flat-square&logo=claude&logoColor=white)](https://ondocs.vercel.app/docs/mcp)
[![Claude](https://img.shields.io/badge/Claude-Add_connector-b4532a?style=flat-square&logo=claude&logoColor=white)](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=ondocs&connectorUrl=https%3A%2F%2Fondocs.vercel.app%2Fapi%2Fmcp)

**Website: [ondocs.vercel.app](https://ondocs.vercel.app)**, whose [docs](https://ondocs.vercel.app/docs) answer with OpenAI and serve agents at `/api/mcp`. Formerly `ask-my-site` ([what changed](https://ondocs.vercel.app/docs/migrating)).

<!-- npm-readme:video -->

https://github.com/user-attachments/assets/2491c5ea-de70-471c-b11e-30591c074e6f

<sub>The <a href="https://ondocs.vercel.app">live demo</a>: a streamed answer with citations, one opening the section it came from, then the one-line setups.</sub>

<!-- npm-readme:image
<p align="center">
  <a href="https://ondocs.vercel.app"><img src=".github/assets/demo.webp" width="100%" alt="The live demo: a question about the docs, a streamed answer with numbered citations, a citation opening the exact section of the FAQ page, then the Ask button on that page answering how to add it to Starlight with the exact config. Last, the one-line setup for Docusaurus, Starlight and any other site."></a>
</p>

<sub>The <a href="https://ondocs.vercel.app">live demo</a>: a streamed answer with citations, one opening the section it came from, then the one-line setups.</sub>
-->

## What you get

One index, `ask-index.json`, built with your site, feeds three things:

- **An Ask box for people.** A ⌘I dialog that streams a short answer from your model, with numbered citations to the exact section. Most off-topic questions get "I don't know" before the model is called. A page loads only the button; the dialog loads on first use.
- **An MCP server for agents.** `search`, `fetch` and `list_pages` over the same index, for coding agents and ChatGPT. Agents bring their own model, and keyword search, the default, calls no model at all.
- **`llms.txt`, `llms-full.txt` and a `.md` copy of every page**, written with the build.

Search runs in memory inside one function you deploy: BM25 and vectors, merged with reciprocal rank fusion.

## Pick your setup

| Your site                          | What you add                                       | Guide                                                       |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| Starlight, or any Astro site       | A plugin, or an integration                        | [Astro and Starlight](https://ondocs.vercel.app/docs/astro) |
| Docusaurus 3                       | A plugin                                           | [Docusaurus](https://ondocs.vercel.app/docs/docusaurus)     |
| VitePress                          | One wrapper in its config                          | [VitePress](https://ondocs.vercel.app/docs/vitepress)       |
| Next.js or another React app       | A route and a component                            | [Next.js and React](https://ondocs.vercel.app/docs/nextjs)  |
| Fumadocs                           | A route and a component                            | [Fumadocs](https://ondocs.vercel.app/docs/fumadocs)         |
| Nextra                             | A route and a component                            | [Nextra](https://ondocs.vercel.app/docs/nextra)             |
| Hugo, Jekyll, MkDocs or plain HTML | One script tag; for plain HTML, `init --out <dir>` | [Script tag](https://ondocs.vercel.app/docs/script-tag)     |

Each answers from an endpoint you deploy as one function next to the site, rate-limited by default. `npx ondocs init` writes it for Vercel, Netlify, Cloudflare or GitHub Pages (as a Worker answering with Workers AI, no API key): see [Deploying](https://ondocs.vercel.app/docs/deployment).

**Live demos:** [Starlight](https://ondocs-starlight.vercel.app), [Docusaurus](https://ondocs-docusaurus.vercel.app), [VitePress](https://ondocs-vitepress.vercel.app).

**Starlight.** `npm i ondocs ai @ai-sdk/openai`, then:

```js
// astro.config.mjs
import starlight from '@astrojs/starlight';
import ondocs from 'ondocs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [starlight({ title: 'Acme Docs', plugins: [ondocs()] })],
});
```

After `astro build`, it indexes the pages into `dist/ask-index.json`, writes `llms.txt` and the `.md` pages, and adds an "Ask AI" button with ⌘I. Static site? `npx ondocs init`. SSR adapter? Nothing to do.

**Docusaurus.** `npm i ondocs ai @ai-sdk/openai @radix-ui/react-dialog cmdk`, then:

```ts
// docusaurus.config.ts
export default { plugins: ['ondocs/docusaurus'] };
```

It does the same after `docusaurus build`, into `build/`.

**Next.js.** With `OPENAI_API_KEY` set, index your content with `npx ondocs index ./content --base-url /docs --llms-txt public`, then:

```ts
// app/api/ask/route.ts
import { openai } from '@ai-sdk/openai';
import { createAskHandler } from 'ondocs/server';
import index from '../../../ask-index.json';

export const POST = createAskHandler({
  index,
  model: openai('gpt-5.4-mini'),
  embeddingModel: openai.embedding('text-embedding-3-small'),
});
```

and render the dialog in your layout, with its two stylesheets:

```tsx
// app/layout.tsx
import { AskDialog } from 'ondocs/react';
import 'ondocs/react/styles.css';
import 'ondocs/embed/launcher.css';
// …then <AskDialog launcher /> in the body
```

**Any other site.** Index the HTML it builds, write the endpoint with `npx ondocs init`, and add the script tag:

```sh
npx ondocs index public -o public/ask-index.json   # embeds with OPENAI_API_KEY, best for the Ask box; -e none for keyword-only
npx ondocs init --out public                       # plain HTML needs --out; Hugo, Jekyll, MkDocs and Eleventy are detected
# For the Workers AI Worker (init --host github-pages), index with -e workers-ai:@cf/baai/bge-small-en-v1.5
# and CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN set, or -e none: it can't embed questions for an OpenAI index
```

On a GitHub Pages project site, at `https://user.github.io/repo`, add `--base-url /repo` to the index command.

```html
<script src="https://cdn.jsdelivr.net/npm/ondocs@0.13/dist/embed.global.js" defer></script>
```

**Try it without a key.** `npx ondocs index ./docs -e mock`, then `npx ondocs dev`, serves the ask endpoint and MCP server on localhost, with a mock model that quotes your docs. See [Try it locally](https://ondocs.vercel.app/docs/local-development).

## For agents

The same index, served to agents with `createMcpHandler`:

```ts
// app/api/mcp/route.ts
import { createMcpHandler } from 'ondocs/server';
import index from '../../../ask-index.json';

const handler = createMcpHandler({ index, siteName: 'the Acme docs' });
export { handler as POST, handler as GET, handler as DELETE, handler as OPTIONS };
```

```sh
claude mcp add --transport http acme-docs https://docs.acme.dev/api/mcp               # Claude Code
codex mcp add acme-docs --url https://docs.acme.dev/api/mcp                           # Codex
gemini mcp add --transport http --scope user acme-docs https://docs.acme.dev/api/mcp  # Gemini CLI
```

- **Protocol.** MCP 2026-07-28, and 2025-11-25 back to 2024-11-05 for clients that start with `initialize`, tested with the official TypeScript client.
- **Tools.** `search` returns ranked sections with a snippet and an anchor URL, and `fetch` a page or section as Markdown, as ChatGPT's connectors expect.
- **Quality.** On docusaurus.io's docs, keyword search puts the right page in the top three for 22 of 22 agent-style queries we wrote in the docs' terms, and 20 of 22 asked as a person asks: a best case, checked in CI ([the queries](https://github.com/dgesteves/ondocs/blob/main/test/corpus.test.ts)). A reader's own words find it less often ([real Stack Overflow questions](https://ondocs.vercel.app/docs/quality#real-questions-from-stack-overflow)).
- **On your docs.** With the plugins' `mcp` option, a page can show an "Add to Cursor / VS Code / Claude" block.
- **llms.txt.** The plugins write it by default, and the CLI with `--llms-txt <dir>`.

See [MCP server](https://ondocs.vercel.app/docs/mcp) and [llms.txt and Markdown pages](https://ondocs.vercel.app/docs/llms-txt).

## Cost and safety defaults

- **A question costs** one embedding call and one model call, with at most 8,000 characters of sources in and 800 tokens out, and a follow-up one more short call to rewrite it. Most questions your docs don't cover stop before the model; one that shares enough words with your pages, such as a general programming question, can still reach it.
- **An agent's search costs** no model call, or one embedding call with an `embeddingModel`.
- **Rate limits are on by default**: 10 questions and 60 tool calls a minute per client IP, per server instance. Name your platform's client IP header outside Vercel.
- **`budget`** caps questions and model tokens per UTC day for the whole endpoint, **`answerCache`** answers repeated questions without a model call, and **`challenge`** adds an optional Turnstile bot check.
- **Requests** must be JSON and bodies are capped; model errors are masked, and answers render as text, never HTML, with links allow-listed.
- **Set a spend limit with your model provider.** It is the only hard cap. See [Rate limits and security](https://ondocs.vercel.app/docs/security).

## How it compares

- **Kapa.ai and Inkeep** are hosted, take more sources than your docs (forums, issues, chat) and have analytics dashboards; several hosted assistants now serve an MCP endpoint for agents as well. ondocs has `ondocs eval`, readers' ratings and a log of unanswered questions to wire yourself.
- **Algolia DocSearch Ask AI** adds answers to DocSearch's search box, with your own LLM provider and key, from the index Algolia's crawler builds on its platform, under an Algolia account. Choose it if you already use DocSearch.
- **Context7, DeepWiki and DocSearch MCP** serve many projects' docs to agents from one server; if one indexes yours, keep it. Your own endpoint is the first-party copy: your docs as last deployed, at your site's URLs, and `onToolCall` shows what agents search for.
- **Fumadocs** has first-party AI chat and an MCP route, native to its framework.
- **docusaurus-plugin-mcp-server** builds a similar index for an MCP endpoint, more widely used today, with no Ask box.
- **The llms.txt plugins** (docusaurus-plugin-llms, starlight-llms-txt, vitepress-plugin-llms and others) have more output options. ondocs writes the basics, and steps aside when one is installed.

What ondocs adds: open source you host. The index is a file in your build, the endpoint a function on your host, the model key yours, with no vendor account. See [Limits and trade-offs](https://ondocs.vercel.app/docs/limits) for where it is the wrong tool.

## Links

- [Getting started](https://ondocs.vercel.app/docs/getting-started), [Deploying](https://ondocs.vercel.app/docs/deployment), [API](https://ondocs.vercel.app/docs/api), [CLI](https://ondocs.vercel.app/docs/cli), [Benchmarks](https://ondocs.vercel.app/docs/benchmarks) and [FAQ](https://ondocs.vercel.app/docs/faq)
- [Changelog](./CHANGELOG.md), [Contributing](./CONTRIBUTING.md), [Security](./SECURITY.md)

Requires Node.js 22.12 or later and AI SDK 7 (`ai@^7.0.95`); AI SDK 6 is not supported. [MIT](./LICENSE) © Diogo Esteves
