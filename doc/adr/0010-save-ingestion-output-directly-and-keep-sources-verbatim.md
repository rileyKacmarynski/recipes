# 0010. Save Ingestion output directly as a Recipe and keep Sources verbatim

Date: 2026-11-16

## Status

Accepted

## Context

Ingestion uses AI to turn an unstructured Source (pasted text, a web page, a photo, a video) into a structured Recipe. A common pattern is to land AI output as a draft that a person reviews before it is saved. The extracted structure will also improve over time as models, prompts, and matching get better, and later AI features may need the original input.

## Decision

A successful Ingestion saves its output directly as a Recipe, with no draft or review step. The User fixes mistakes by editing the Recipe afterwards. The Source is always kept verbatim and is never changed by edits to the Recipe. Every attempt to process a Source is its own Ingestion with its own Provenance, and re-ingesting a Source produces a new Recipe rather than overwriting an edited one.

## Consequences

- AI mistakes reach the library unreviewed, so editing a Recipe, including its Ingredient Lines and Ingredient matches, needs to come soon after the first slice.
- Sources must be stored durably alongside Recipes, which grows storage with every Ingestion.
- Because Sources and Provenance are kept, Recipes can be re-ingested with better models later and the data can feed future AI features and search.
- Merging a re-ingested Recipe into an edited one is not supported until it is designed.
