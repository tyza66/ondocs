---
title: Configuration
description: The options in acme.config.ts.
---

# Configuration

Acme reads `acme.config.ts` in the project's root.

## Base path

Set `base` when the site is served under a path, such as `/docs`. Every link and asset is written under it.

## Themes

`theme` picks the look: `light`, `dark` or `auto`, which follows the visitor's system setting.

## Redirects

List old paths in `redirects`, each with the page it moved to. Acme writes a small HTML file at the old path that sends visitors on.
