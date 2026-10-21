---
'ondocs': patch
---

`ondocs eval` scores an index built with a config module's embedding model: `ondocs eval ask-eval.yaml -c ask.config.mjs` embeds the questions with the module's `embeddingModel` and `embeddingProviderOptions`, as `ondocs index -c` embedded the pages, so an index embedded with Gemini, Cohere or a model you host no longer stops at "which ondocs dev cannot load". It stops instead if the module's model is not the one the index records.

The report adds hit@5 and MRR (mean reciprocal rank), with thresholds of their own (`hit@5` and `mrr` in the file, `--min-hit-at-5` and `--min-mrr`). A result lists the first five pages found, not three, so a miss shows what ranked fourth and fifth, and the report gives each question's words that no page has (`absent` in `--json`), which it prints after a refused question: when the docs lack the reader's word, embeddings are the fix; when they have it too thinly, a lower `minKeywordCoverage`.
