---
# Generated from examples/nextjs/content/docs/benchmarks.md by scripts/sync-example-docs.mjs. Edit that file instead.
title: 'Benchmarks'
description: 'Index size, cold start, memory and query latency at 1,000, 10,000 and 50,000 chunks.'
---

# Benchmarks

`pnpm bench` in the repository builds the package and measures it on synthetic, documentation-shaped corpora. These are the numbers the rest of these docs quote.

## Method

The corpora have a Zipf-distributed vocabulary and chunks of 600 to 1,000 characters grouped into pages, with 512-dimension embeddings clustered around shared topics, as one site's embeddings are. Query latency covers hybrid retrieval end to end, BM25, the cosine scan and fusion, and excludes the embedding API call, which is network-bound and the same for any design. The runs below are from an Apple M1 Max on Node 24.18, with 1,000 queries per size after warm-up.

## Results

Size and load, per server instance:

| Chunks |   Index |    gzip | As float JSON | Cold load | Heap retained | Process memory (peak) |
| -----: | ------: | ------: | ------------: | --------: | ------------: | --------------------: |
|  1,000 |  1.6 MB |  0.9 MB |        7.5 MB |     32 ms |        3.2 MB |       +23 MB (+31 MB) |
| 10,000 | 15.7 MB |  8.5 MB |       75.4 MB |    339 ms |       32.8 MB |     +238 MB (+294 MB) |
| 50,000 | 78.7 MB | 42.6 MB |      377.1 MB |    1.72 s |      123.9 MB |   +759 MB (+1,130 MB) |

Query latency and recall:

| Chunks |      p50 |      p95 |      p99 | Recall@10 |
| -----: | -------: | -------: | -------: | --------: |
|  1,000 |  0.71 ms |  0.76 ms |  0.91 ms |     99.9% |
| 10,000 |  6.96 ms |  7.32 ms |  7.84 ms |     99.1% |
| 50,000 | 37.11 ms | 39.01 ms | 44.03 ms |     98.5% |

At 10,000 chunks, the BM25 half of a query takes 2.3 ms and the vector scan 4.6 ms at the median. Cold load is a one-time cost per server instance: parse the file, decode the vectors and build the inverted index. Heap retained is what the loaded index holds. Process memory is how much a fresh Node.js process grows to load the index from its JSON text, once the text is collected and at the peak of parsing: that, not the heap, counts against a platform's memory limit, so on a 128 MB Cloudflare Worker keep the index to a few thousand chunks. Process memory was measured later, on the same machine. Recall@10 is the overlap between the int8 top 10 and the exact float32 top 10.

## How fast is search

Search over 1,000 chunks takes under a millisecond, 0.71 ms at the median, and about 7 ms over 10,000 chunks. Everything is linear in corpus size, so a site's numbers can be read off the table: roughly 1.6 MB of index, 32 ms of cold load and 0.7 ms per query for every 1,000 chunks.

In a real request, retrieval is the small part: nearly all of the time goes to the embedding call for the question and the model's answer, which are network calls to your provider.

## Bundle size

Each page carries only the dialog's button and shortcut; the dialog loads the first time it is wanted (see [when the dialog's code loads](/ask-dialog#when-the-dialogs-code-loads)). Measured in headless Chrome on the example sites with `node scripts/js-weight.mjs`, as the JavaScript a docs page loads before any interaction, gzipped at level 9, in KB of 1,024 bytes:

| Site                       | The site on its own | With ondocs | When the dialog opens |
| -------------------------- | ------------------: | ----------: | --------------------: |
| Docusaurus 3.10            |            173.8 KB |    177.7 KB |              +26.6 KB |
| Starlight 0.42             |             33.7 KB |     36.1 KB |              +92.6 KB |
| VitePress 1.6              |             58.7 KB |     61.7 KB |              +96.1 KB |
| Script tag on a plain page |                   0 |      3.2 KB |              +97.1 KB |

Starlight's and VitePress's dialogs bring their own React, as the script tag's does; Docusaurus's shares the site's. Before the dialog loaded on demand, the Docusaurus, Starlight and script tag pages carried 192.7 KB, 121.2 KB and 91.2 KB. CI measures the example sites the same way, with `node scripts/js-weight.mjs --check`, and fails a change that goes over each site's budget, or that stops a shortcut pressed while the dialog loads from opening it with focus in its input, or focus from coming back when it closes. The handler adds no client code at all.

## Answer quality

These numbers are speed and size. How often search finds the right page is measured with `ondocs eval`, on the audit's questions and on real questions people asked on Stack Overflow about Docusaurus, Astro and Vitest, checked in CI: see [Measure and improve answers](/quality#real-questions-from-stack-overflow).

## Run it yourself

```sh
pnpm install
pnpm bench
```

The [benchmark source](https://github.com/dgesteves/ondocs/blob/main/bench/run.mjs) documents the method.
