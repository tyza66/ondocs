---
# Generated from examples/nextjs/content/docs/quality.md by scripts/sync-example-docs.mjs. Edit that file instead.
title: 'Measure and improve answers'
description: "Score retrieval in CI with ondocs eval, collect readers' feedback, and keep a log of the questions your docs do not answer."
sidebar:
  order: 26
---

Three tools tell you how well your docs answer: `ondocs eval`, which scores retrieval against questions whose answers you know, in CI; readers' thumbs up and down in the dialog; and a log of the questions the docs did not answer, the content gaps to write next. None of them sends anything anywhere unless you wire it to.

## Score retrieval with eval

Write down questions your readers ask, with the pages that answer them, and a few your docs should not answer:

```yaml
# ask-eval.yaml
thresholds:
  hit@3: 0.8
  refusalRecall: 1

questions:
  - question: How do I deploy to GitHub Pages?
    expect: /docs/deployment/github-pages
  - question: How do I add a tip or warning callout?
    expect: [/docs/markdown-features/admonitions, /docs/markdown-features]
  - question: Why is each vector stored as int8?
    expect: /docs/index-format#vectors
  - question: What will the weather be in Lisbon tomorrow?
    unanswerable: true
```

Then run it against the index your build wrote:

```sh
npx ondocs eval ask-eval.yaml --index build/ask-index.json
```

For each question it prints where the first expected page came among the pages found, or that the gate refused it, with the best keyword coverage and similarity it saw, then the scores. A miss lists the first five pages found, and a refused question the words of it that no page has: if the docs lack the reader's word, embeddings, which match meaning, are the fix; if they have it too thinly, a lower `minKeywordCoverage`. The eval of docusaurus.io's docs that this repository runs in CI, shortened:

```console
$ npx ondocs eval docusaurus.io.yaml --index ask-index.json
ondocs eval: 28 questions against ask-index.json (1070 chunks, keyword-only search)

  ✓ 1         How do I highlight specific lines in a code block?         cov 0.78
  ✗ refused   How do I add a tip or warning callout box?                 cov 0.36  expected /docs/markdown-features/admonitions; not in the docs: callout
  ✓ 3         How do I change the site's primary color?                  cov 0.79  → /docs/migration/v2/manual, /docs/api/themes/configuration, /docs/styling-layout, /docs/search
  ✓ refused   Write me a poem about the sea                              cov 0.16

  hit@1              0.64  (14/22)
  hit@3              0.86  (19/22)  threshold 0.8 ✓
  hit@5              0.86  (19/22)
  MRR                0.73  (16.17/22)
  refusal precision  0.86  (6/7)  threshold 0.75 ✓
  refusal recall     1.00  (6/6)  threshold 1 ✓
```

The scores:

- **hit@1**, **hit@3** and **hit@5**: the share of answerable questions whose expected page came first, in the top three, or in the top five. An `expect` with a `#anchor` must match that section.
- **MRR**, mean reciprocal rank: 1 for an expected page found first, 1/2 for second, 1/3 for third, and so on, 0 for one not found, averaged over the answerable questions. It moves when a page climbs from fifth to second, which no hit@ score sees.
- **Refusal precision**: of the questions the gate refused, the share that should have been refused. Under 1, the gate turns away questions your docs answer.
- **Refusal recall**: of the questions marked `unanswerable`, the share it refused. Under 1, off-topic questions reach the model.

`eval` exits 1 when a score is under its threshold, so it fails CI, and `--json` prints the report for other tools. The file's `thresholds` take `hit@1`, `hit@3`, `hit@5`, `mrr`, `refusalPrecision` and `refusalRecall`, which `--min-hit-at-1`, `--min-hit-at-3`, `--min-hit-at-5`, `--min-mrr`, `--min-refusal-precision` and `--min-refusal-recall` override, and `retrieval` in the file takes the handler's retrieval settings, so the eval scores what the endpoint runs.

It runs what the endpoint runs before the model, embedding each question as the index was, so it calls no language model. With an embedded index it makes one embedding call per question, with the key the index's model needs; `--keyword-only` makes none. An index built with a config module's model, such as Gemini's, Cohere's or one you host, is scored with the same module: `npx ondocs eval ask-eval.yaml -c ask.config.mjs` embeds the questions with its `embeddingModel` and `embeddingProviderOptions`, and stops if that is not the model the index records. It measures retrieval and the relevance gate, not the wording of the answers.

This repository runs five eval files in CI: one of this site's own questions against the website's index; one of the 22 questions and 6 off-topic ones the 2026-10-10 audit asked of docusaurus.io's docs, where keyword search scores hit@1 14 of 22, hit@3 19 of 22, and refuses all 6 off-topic questions and 1 it should answer; and three of [real questions from Stack Overflow](#real-questions-from-stack-overflow). The audit's questions were written with the docs at hand, so they are a best case, not what your readers' own wording will score. Copy `test/eval/docusaurus.io.yaml` from the repository as a start. When you change `minSimilarity` or `minKeywordCoverage`, the eval shows what moved.

## Real questions from Stack Overflow

The audit's questions, and the 22 agent searches the [MCP page](/integrations/mcp/#keyword-only-or-hybrid-search) counts, were written by this project knowing the docs, and their words are often the docs' own. Readers' are not. So CI also scores questions people asked on Stack Overflow about Docusaurus, Astro and Vitest, as they titled them, each against that project's docs at a pinned commit. A question's expected pages are the ones its accepted answer, or a maintainer's, links, mapped onto the pinned docs by code; two links needed judgement and were mapped by an AI reviewer, and no person labelled the questions. Each file adds 15 off-topic questions: the five most-voted of each of three unrelated tags. [`test/eval/README.md`](https://github.com/dgesteves/ondocs/blob/main/test/eval/README.md) lists every question with a link to it, how it was chosen and labelled, and its licence: the questions are Stack Overflow's, under CC BY-SA 4.0.

Keyword-only, no API key, as CI measures them on every change:

| Docs, and the questions about them     | Right page first | Right page in the top 3 | Right page in the top 5 | MRR  | Off-topic questions answered | Answerable questions refused |
| -------------------------------------- | ---------------- | ----------------------- | ----------------------- | ---- | ---------------------------- | ---------------------------- |
| docusaurus.io's docs, 33 questions     | 5 of 33          | 8 of 33                 | 10 of 33                | 0.21 | 2 of 15                      | 3 of 33                      |
| Astro's docs, in English, 95 questions | 10 of 95         | 21 of 95                | 22 of 95                | 0.16 | 1 of 15                      | 8 of 95                      |
| Vitest's docs, 26 questions            | 5 of 26          | 7 of 26                 | 7 of 26                 | 0.22 | 3 of 15                      | 4 of 26                      |

On the same docusaurus.io docs, the audit's questions have the right page in the top three for 19 of 22; these, for 8 of 33. A title names the asker's problem in the asker's words, and each question counts only the pages one answer linked, so where another page answers it as well, finding that page counts as a miss: the answer to "Docusaurus CNAME file is deleted after each build" links the deployment page, and search finds the GitHub Pages one. The scores are a lower bound. Each file's thresholds sit just under these scores, so a change that loses a question fails CI, and has to say why. That is the check to keep these numbers honest; they are not a benchmark against other tools.

These are the scores of a site with no API key. With one, the plugins and `ondocs index` embed the pages with OpenAI's `text-embedding-3-small` at 512 dimensions, the default, and the Ask box searches by meaning as well as by keywords. Scores with embeddings come from the [retrieval eval workflow](#with-openais-embeddings), which scores these three files as well, by hand; this page quotes none until it has run.

## With OpenAI's embeddings

The evals in CI search by keywords only, since embedding needs a key. The [retrieval eval workflow](https://github.com/dgesteves/ondocs/blob/main/.github/workflows/retrieval-eval.yml) measures them with embeddings, run by hand: it indexes the same three docs folders, at the same pinned commits, with OpenAI's `text-embedding-3-small` at 512 dimensions, the plugins' default, and runs `ondocs eval` with the audit's 22 questions and 6 off-topic ones and the three Stack Overflow files. It scores the relevance gate at a `minSimilarity` of 0.15, 0.20, 0.25 (the default for OpenAI's models), 0.30, 0.35 and 0.40, and reports how close each question's nearest chunk is, to check that 0.25 suits this model. It counts each folder's chunks before it embeds any and stops if one has more than 5,000 (they have 1,070, 4,805 and 2,233), and it keeps the report and the indexes with the run. `node scripts/retrieval-eval.mjs --stub` runs the same steps against a local stand-in for OpenAI's API, with no key and no cost.

> **Not run yet.** The results go here after the first run, with its date, the ondocs version and the commits of the docs. Until then, the numbers on this page are keyword-only.

On the audit's questions, keyword-only:

| Search        | Right page first | Right page in the top 3 | Off-topic questions answered | Answerable questions refused |
| ------------- | ---------------- | ----------------------- | ---------------------------- | ---------------------------- |
| Keywords only | 14 of 22         | 19 of 22                | 0 of 6                       | 1 of 22                      |

## Feedback from readers

Give the handler an `onFeedback`, and the dialog asks "Was this helpful?" under each answer, with thumbs up and down, and then offers a comment:

```ts
export const POST = createAskHandler({
  index,
  model,
  onFeedback: ({ rating, comment, id, question }) => {
    console.log(JSON.stringify({ feedback: rating, comment, id, question }));
  },
});
```

The dialog posts the rating to the same endpoint, with the question, the answer and its sources as the reader saw them, and a comment as a second call with the same `id`. That `id` is the answer's, the one `onFinish` gets, so you can join a rating to everything else about the answer. Without `onFeedback` the dialog shows no thumbs, and a posted rating gets a 400. A rating counts against the rate limit like a question, and costs no model call.

## Questions your docs do not answer

`onFinish` runs after every answer. Two of its fields mark the questions worth reading:

- **`refused`**: nothing in the docs cleared the relevance gate, so the reader got "I don't know" and the model was not called.
- **`lowConfidence`**: the model answered but cited none of its sources, which usually means it said the sources do not cover the question.

Together they are the content gaps: the questions to write pages for, or the words your pages should use. Log them wherever suits you. To a file, on a server you run:

```ts
import { appendFile } from 'node:fs/promises';

onFinish: async ({ question, refused, lowConfidence, followUp, retrieval }) => {
  if (!refused && !lowConfidence) return;
  const line = { at: new Date().toISOString(), question, asked: followUp?.question, refused, best: retrieval.best };
  await appendFile('unanswered.jsonl', `${JSON.stringify(line)}\n`);
},
```

To a KV store, in a Cloudflare Worker with a KV namespace bound as `GAPS`:

```ts
onFinish: async ({ id, question, refused, lowConfidence }) => {
  if (refused || lowConfidence) {
    await env.GAPS.put(`${new Date().toISOString().slice(0, 10)}:${id}`, question, { expirationTtl: 90 * 86_400 });
  }
},
```

Or to a webhook, such as a Slack channel's:

```ts
onFinish: async ({ question, refused, lowConfidence }) => {
  if (refused || lowConfidence) {
    await fetch(process.env.GAPS_WEBHOOK_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Unanswered: ${question}` }),
    });
  }
},
```

`onFinish` runs after the answer has streamed, so a slow log never delays the reader, and if it throws the error goes to `onError`. Then read the log now and then: `jq -r .question unanswered.jsonl | sort | uniq -c | sort -rn` lists the questions asked most. The ones that should be answerable, but are not, go in your eval file next.

## What leaves your site

Nothing, unless you send it. The questions and ratings reach your endpoint, and go no further than the code you write in `onFinish` and `onFeedback`; ondocs sends no telemetry and keeps no store. A question is what a reader typed, so it can hold personal details: log only what you need, with no IP address, and keep it only as long as you use it. See [Rate limits and security](/guides/security/#privacy-what-leaves-your-servers).
