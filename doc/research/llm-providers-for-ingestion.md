# LLM providers for Ingestion and Ingredient matching

Researched 2026-11-15 against first-party documentation, SDK source, and the npm registry, for wayfinder ticket #32. No code, credentials, or live API calls were involved. Latency figures are vendor positioning labels, not measurements, and every cost figure is an estimate calculated from list prices.

## Question

Which providers and models suit two jobs:

- **(a) Extraction:** turning a pasted-text Source into a structured Recipe (Ingredient Lines with amount, unit, Ingredient, and Preparations; Steps; Sections; Yield; times).
- **(b) Matching:** deciding whether an Ingredient Line's Ingredient matches an existing Ingredient in the global catalog or needs a new one.

The comparison covers structured-output support (ideally driven from Zod), TypeScript SDK maturity, current model ids, latency, cost per Ingestion, the identifiers Provenance could record, and, briefly, embeddings.

## Summary

- All three providers can now constrain output to a JSON Schema, and all three ship a TypeScript SDK that works with the repo's Zod 4 (`4.4.3`). Anthropic and OpenAI provide **first-party Zod helpers** that convert the schema and return a typed, validated result. With Google you convert the schema yourself (`z.toJSONSchema`) and validate the result yourself. [A2][O2][G3][Z1]
- The schema dialects differ in ways that matter for the Recipe schema. OpenAI requires every property to be `required`, with optional fields written as `null` unions. Anthropic rejects numeric and string-length constraints (the Zod helper moves them into descriptions and re-checks them client-side). Gemini silently strips some keywords. **If the Recipe schema stays plain (objects, arrays, enums, nullable fields, no min/max), it is portable across all three.** [A2][O3][G3]
- On list price at the cheap tier, **Claude Haiku 5.5** and **GPT-6 Luna** cost the same ($0.10 / $0.50 per MTok), about **$0.001 per extraction**. A mid-tier model (Sonnet 5.5, GPT-6.1 Sol) costs about $0.02–0.03. Gemini's cheapest current text model costs more than either at this size. [A1][O1][G1]
- Every provider returns a response id, the model id, and token usage. Anthropic and OpenAI also return a separate per-request id header that the SDKs expose as `_request_id`. Google's Interactions API documents no request-id header. [A4][A5][O4][O5][G2]
- The Vercel AI SDK (`ai@7`) normalises Zod structured output, usage, and response id/model across providers. It is mature and actively released. The trade is an extra abstraction layer that lags provider-specific features. A thin, app-owned `IngestionModel` port is enough for pluggability. [V1][V2][N1]

## Current models (verified 2026-11-15)

Prices are standard-tier list prices per million tokens (input / output). Batch is 50% off for both Anthropic and Gemini. [A1][G1]

| Provider  | Model id                | Vendor positioning                                                                                          | Price ($/MTok in / out)                        |
| --------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Anthropic | `claude-haiku-5-5`      | "high-volume, latency-sensitive tasks such as classification, extraction, and routing"; latency **Fastest** | 0.10 / 0.50 (prompts ≤100k tokens)             |
| Anthropic | `claude-sonnet-5-5`     | "best combination of speed and intelligence"; latency **Fast**                                              | 2 / 10                                         |
| Anthropic | `claude-opus-5-5`       | general default; latency **Moderate**                                                                       | 4 / 20                                         |
| Anthropic | `claude-fable-5-2`      | demanding reasoning; latency **Moderate**                                                                   | 8 / 40                                         |
| OpenAI    | `gpt-6-luna`            | "most efficient model for focused, high-volume tasks"                                                       | 0.10 / 0.50                                    |
| OpenAI    | `gpt-6.1-terra`         | "fast, efficient model"                                                                                     | 1 / 5                                          |
| OpenAI    | `gpt-6.1-sol`           | "near-Astra performance … at a lower cost"                                                                  | 2 / 10                                         |
| OpenAI    | `gpt-6-astra`           | flagship                                                                                                    | 10 / 50                                        |
| Google    | `gemini-3.5-flash-lite` | "fastest and most cost-effective 3.5 model" (stable)                                                        | 0.30 / 2.50                                    |
| Google    | `gemini-3.8-flash`      | general-purpose Flash, described as "previous-generation" (stable)                                          | 0.75 / 3.75 until 2026-12-31, then 1.50 / 7.50 |
| Google    | `gemini-4-hydrogen`     | "fast and efficient for everyday coding and agentic workflows"                                              | 1.50 / 7.50                                    |
| Google    | `gemini-4-argon`        | efficient frontier reasoning                                                                                | 2 / 10 until 2026-11-30, then 4 / 20           |

Sources: [A1][A3][O1][O6][G1][G4]. Every Anthropic model id from the 4.6 generation on is a pinned snapshot, and the dateless id is not a moving alias. [A3] OpenAI does not publish comparative latency labels. Its only speed claim is the word "fast" for Terra. [O6] Gemini 4 models carry no stable/preview label on the models page. [G4] Several Gemini prices are explicitly temporary, so re-check before you rely on them. [G1]

Anthropic notes that thinking is adaptive by default on current models. On `claude-haiku-5-5`, `thinking: {type: "disabled"}` is accepted (at effort `high` or below), which suits a low-latency extraction call. On Opus 5.5 thinking cannot be turned off, and on Sonnet 5.5 the lowest setting is `between_tools`. [A5] Thinking tokens are billed as output on every provider, so effort settings change the cost estimates below. [A1][G1]

## Structured output and Zod

| Provider  | Mechanism                                                                                                                                                                 | Zod path                                                                                                                      | Notable schema limits                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anthropic | `output_config.format` (JSON outputs) and `strict: true` tools. Both are constrained decoding, and both are stable on the Claude API, Bedrock, Google Cloud, and Foundry. | `zodOutputFormat(schema)` from `@anthropic-ai/sdk/helpers/zod` + `client.messages.parse()` → typed `parsed_output`            | No recursive schemas. No `minimum`/`maximum`/`minLength`/`maxLength` (the helper moves them into descriptions and re-validates them client-side). `minItems` only 0/1. `z.record()` becomes `{}`. Unsupported features return a 400. |
| OpenAI    | Responses API `text.format` with `json_schema` / strict.                                                                                                                  | `zodTextFormat(schema, name)` from `openai/helpers/zod` + `openai.responses.parse()` → `output_parsed`                        | Every property must be `required` (optional fields become `["type","null"]`). `additionalProperties: false` everywhere. Root must be an object, without `anyOf`. Max 10 nesting levels and 5,000 properties. Recursion is allowed.   |
| Google    | Interactions API `response_format` with `mime_type: "application/json"` and `schema`.                                                                                     | No helper. Build the schema with `z.toJSONSchema()` (Zod 4, stable) and validate with `schema.parse(JSON.parse(output_text))` | `minLength`, `maxLength`, `uniqueItems`, and others are silently stripped. Large or deep schemas return `400 INVALID_ARGUMENT`. The docs promise syntactically valid JSON but tell you to validate values yourself.                  |

Sources: [A2][O2][O3][G3][Z1].

Anthropic and OpenAI both document extra latency on the first request with a new schema while it compiles. Anthropic caches compiled grammars for 24 hours after last use. [A2][O2] Changing the schema also invalidates Anthropic's prompt cache. [A2]

Repo fit: the repo already pins `zod@4.4.3`, and both first-party SDKs declare `zod: ^3.25 || ^4.0` as a peer dependency. [R1][N1] Per architecture preferences, the Recipe/Ingredient Line Zod schemas in `@recipes/core` can double as the model output contract. The model's output is still a boundary, so it needs one more parse whatever helper is used.

## TypeScript SDK maturity

| Package                                    | Latest (npm, 2026-11-15) | Notes                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/sdk`                        | 1.8.0                    | Official, with typed errors, retries (2 by default), `_request_id`, a Zod helper, and dedicated Bedrock/Vertex/Foundry clients. [A5][A6]                                              |
| `openai`                                   | 7.57.0                   | Official. Its README names Responses as "the primary API" (Chat Completions remains supported). `_request_id` on responses, Zod helpers. [O5]                                         |
| `@google/genai`                            | 3.3.0                    | Official. The Interactions API (`client.interactions.create`, SDK ≥2.3.0) is "recommended for all new projects", while `generateContent` is legacy but supported. No Zod helper. [G2] |
| `ai` + `@ai-sdk/{anthropic,openai,google}` | 7.0.173 / 4.0.x          | Vercel AI SDK. Released constantly (all published within the last two days). Zod/Valibot/JSON Schema via `generateText({ output: Output.object({ schema }) })`. [V1][N1]              |

Sources: [N1] unless noted. Prod runs on AWS Lambda (ADR 0002). Claude is also reachable through Amazon Bedrock (`anthropic.claude-haiku-5-5` on bedrock-mantle) with IAM auth instead of a third-party API key, and structured outputs are stable there. [A2][A3] That is a deployment option worth weighing, not something this research verified end to end.

## Estimated cost per Ingestion

Assumptions:

- **Extraction:** about 1.5k tokens of recipe text, plus about 0.5k of instructions/schema overhead, for **2k input**. About 1.5k tokens of Recipe JSON plus about 0.5k of thinking gives **2k output**.
- **Matching:** one batched call per Recipe (about 12 Ingredient Lines, each with a shortlist of candidate Ingredients), for **3k input / 0.5k output**.

Tokenizers differ, so treat these as order-of-magnitude figures. Prices are standard tier, with no caching or batch discount.

| Model                   | Extraction | Matching | Total per Ingestion |
| ----------------------- | ---------- | -------- | ------------------- |
| `claude-haiku-5-5`      | $0.0012    | $0.0006  | **~$0.002**         |
| `gpt-6-luna`            | $0.0012    | $0.0006  | **~$0.002**         |
| `gemini-3.5-flash-lite` | $0.0056    | $0.0022  | ~$0.008             |
| `gpt-6.1-terra`         | $0.012     | $0.0055  | ~$0.018             |
| `gemini-4-hydrogen`     | $0.018     | $0.0083  | ~$0.026             |
| `claude-sonnet-5-5`     | $0.024     | $0.011   | ~$0.035             |
| `gpt-6.1-sol`           | $0.024     | $0.011   | ~$0.035             |
| `claude-opus-5-5`       | $0.048     | $0.022   | ~$0.070             |

Calculated from [A1][O1][G1]. Even at the mid tier, 1,000 Ingestions cost about $35. The bigger question is extraction quality on messy Sources, which needs a small eval set, not price.

## Identifiers Provenance could record

| Provider              | Response id                           | Model                                       | Request id                                                                                                                                  | Token usage                                                                                                                                                | Other                                                                                                                                                   |
| --------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic             | `id` (`msg_…`)                        | `model` (dateless ids are pinned snapshots) | `request-id` header (`req_…`), exposed as `_request_id` in the TS SDK. Also returned in error bodies as `request_id`.                       | `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`                                                            | `stop_reason` (including `refusal` with `stop_details`), `anthropic-organization-id`/`anthropic-workspace-id` headers. Bedrock adds `x-amzn-requestid`. |
| OpenAI                | `id`, `created_at` (Unix seconds)     | `model`                                     | `x-request-id` header → `_request_id`. You can also send `X-Client-Request-Id` (≤512 ASCII), which OpenAI logs and which survives timeouts. | `usage.input_tokens`, `input_tokens_details.cached_tokens`/`cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens` | `status`, `service_tier` (the tier actually used), `openai-processing-ms`, `openai-version` headers                                                     |
| Google (Interactions) | `id`, `created`, `updated` (ISO 8601) | `model`. No separate version field.         | None documented                                                                                                                             | `usage.total_input_tokens`, `total_output_tokens`, `total_thought_tokens`, `total_cached_tokens`, `total_tokens`                                           | `status` enum                                                                                                                                           |
| Vercel AI SDK (any)   | `finalStep.response.id`               | `finalStep.response.modelId`                | Raw `finalStep.response.headers` only                                                                                                       | `usage.inputTokens`, `inputTokenDetails.cacheReadTokens`, `outputTokens`, `outputTokenDetails.reasoningTokens`, `usage.raw`                                | `finishReason`, `warnings`, `providerMetadata`                                                                                                          |

Sources: [A4][A5][A7][O4][O5][O7][G2][V2].

Provenance also needs things no provider returns, and the app must record them itself: provider name, the requested model id (which may differ from the returned one when an alias or fallback applies), prompt/schema version, effort/thinking settings, timestamps, latency, outcome (succeeded/failed with error class), and an estimated cost computed from usage. For failed Ingestions, Anthropic's error bodies carry `request_id`, and OpenAI's client-supplied id covers requests that timed out. [A5][O4]

## Is a provider-agnostic layer worth it?

**For the Vercel AI SDK:**

- It gives one Zod-driven structured-output call across all three providers.
- It normalises usage and response metadata, the shape Provenance needs.
- `NoObjectGeneratedError` keeps the raw text, usage, and response metadata, so a failed Ingestion still has evidence. [V1][V2]
- It reduces swapping a model to a config change, which fits the "Ingestion Methods must be pluggable" goal for the photo/video methods later.

**Against it:**

- It is a second fast-moving dependency (`ai` is at major 7, and fields like top-level `response`/`providerMetadata` are already deprecated in favour of `finalStep.*`). [V2][N1]
- Provider-specific features arrive later or only through `providerOptions`: Anthropic `effort`/thinking modes, refusal fallbacks, grammar-constrained strict tools, OpenAI `X-Client-Request-Id`.
- The request id is not surfaced directly, only through raw headers. [V2]
- The README keeps AI libraries out until there is a need, and adding two layers (framework plus provider) makes that need harder to justify.

**Middle path:** define an app-owned port in the functional-core style, e.g. `extractRecipe(source) → Result<RecipeDraft, IngestionError> & ProvenanceFacts`, with one adapter built on one first-party SDK. The Zod schema stays in `@recipes/core`. Adding a second provider later means writing one more adapter. That is the pluggability actually needed for v1. Switching to the AI SDK later is cheap if the port is respected.

## Matching notes (job b)

Matching is a classification over a shortlist, which fits Haiku-/Luna-class models ("classification, extraction, and routing"). [A3][O6] An LLM should not see the whole global catalog. A plausible shape, still to be decided in #37:

1. Normalise and exact-match first.
2. Shortlist candidates (trigram/`ILIKE` in Postgres today, embeddings later).
3. Ask the model to choose from an enum of the candidate ids plus `"new"`, with a proposed canonical name.

Both Anthropic and OpenAI structured outputs support `enum`, so the choice can be schema-constrained. OpenAI caps total enum values at 1,000. [A2][O3]

## Embedding options (for the future search map; not a decision)

| Provider            | Model ids                                                                     | Price ($/MTok input)                                                                     | Notes                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic           | none                                                                          | —                                                                                        | Anthropic "does not offer its own embedding model" and points to Voyage AI (MongoDB). [A8]                                                                                                            |
| Voyage AI (MongoDB) | `voyage-4-large`, `voyage-4`, `voyage-4-lite`, `voyage-4-nano` (open weights) | 0.12 / 0.06 / 0.02 (200M free tokens) per the Voyage pricing page                        | 1024 dimensions by default (256–2048 Matryoshka). Keys now come from MongoDB Atlas. The pricing page has inconsistencies and Anthropic now links MongoDB's billing page, so re-verify there. [A8][Y1] |
| OpenAI              | `text-embedding-3-small`, `text-embedding-3-large`                            | 0.02 / 0.13                                                                              | [O1]                                                                                                                                                                                                  |
| Google              | `gemini-embedding-2`, `gemini-embedding-001`                                  | 0.20 / 0.15. Free tier available, but free-tier data is used to improve Google products. | [G1]                                                                                                                                                                                                  |

Aurora PostgreSQL vector support (pgvector) and embedding storage belong to the search map and were not checked here.

## Implications for decisions

This is input to the user's decisions, not a decision.

- **#37 Matching policy:** shortlist the catalog in code, then make a cheap schema-constrained classification call (Haiku 5.5 / GPT-6 Luna class, about $0.0006 per Recipe). Keep the candidate set small and pass it as an `enum`. Embedding-based shortlisting can wait for the search map.
- **#38 Pipeline:** two calls (extract, then match) cost little at any tier, so the split can be made for clarity and testability rather than cost. Plan for first-schema compile latency, `refusal`/incomplete stop states, and a final Zod parse at the boundary. Keep the Recipe output schema plain (nullable fields instead of optional, no min/max) so it stays portable across providers.
- **#39 Provenance:** record provider, requested and returned model id, response id, request id (where available), token usage including cached and reasoning tokens, stop/finish reason, effort/thinking settings, prompt/schema version, latency, and estimated cost. Store the raw usage object too, since field names differ by provider.
- **ADR:** adding an AI SDK dependency is the "concrete need" the README anticipates, and that should be recorded in `doc/adr`.

**Suggested default, for the user to confirm or override:** use **Anthropic `claude-haiku-5-5` through the first-party `@anthropic-ai/sdk`**, with `zodOutputFormat` and `messages.parse` behind an app-owned port, for both extraction and matching. Escalate extraction to `claude-sonnet-5-5` if a small eval of real pasted recipes shows quality gaps. Haiku 5.5 ties GPT-6 Luna on price, is the fastest Anthropic tier, has a first-party Zod helper, exposes `_request_id`, and is also reachable through Bedrock if IAM-only auth on Lambda is wanted. OpenAI `gpt-6-luna` with `zodTextFormat` is an equally viable alternative at the same price. Choose it if its schema dialect (recursion, numeric constraints) matters more. Defer the Vercel AI SDK until a second provider is actually needed.

**Open questions worth tickets:**

- A small extraction eval set (about 10–20 real pasted recipes with expected Ingredient Lines) to choose between the Haiku and Sonnet tiers.
- Whether to use Bedrock or the direct Anthropic API from Lambda, which affects secrets management versus IAM and the repo's "no broad env management" constraint.
- Data handling: free tiers that train on inputs (Gemini) versus paid-tier terms.

## Sources

Anthropic:

- A1. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing): model price table, Haiku 5.5 tiers, Batch 50%.
- A2. [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs): supported models and platforms, `zodOutputFormat`/`messages.parse`, schema limits, grammar caching.
- A3. [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview): current ids, comparative latency, descriptions, pinned snapshots, Bedrock ids.
- A4. [API overview: response headers](https://platform.claude.com/docs/en/api/overview): `request-id`, `anthropic-organization-id`, `anthropic-workspace-id`.
- A5. [Errors: request ID, thinking-mode errors](https://platform.claude.com/docs/en/api/errors): `_request_id` in the TS SDK, `request_id` in error bodies, retries, Haiku 5.5 `disabled` thinking, Sonnet 5.5 `between_tools`.
- A6. Anthropic SDK TypeScript reference bundled with the `claude-api` skill (`typescript/claude-api/README.md`): client, typed errors, `usage` cache fields.
- A7. Same skill reference, prompt-caching section: `usage.cache_creation_input_tokens` / `cache_read_input_tokens`.
- A8. [Embeddings](https://platform.claude.com/docs/en/build-with-claude/embeddings): no Anthropic embedding model, Voyage 4 lineup and dimensions.

OpenAI:

- O1. [Pricing](https://developers.openai.com/api/docs/pricing): text and embedding prices.
- O2. [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs): `zodTextFormat` from `openai/helpers/zod`, `responses.parse`, first-request latency, refusals.
- O3. Same guide, "Supported schemas": required/null unions, `additionalProperties`, limits.
- O4. [API reference overview: debugging requests](https://developers.openai.com/api/reference/overview): `x-request-id`, `openai-processing-ms`, `X-Client-Request-Id`.
- O5. [openai-node README](https://github.com/openai/openai-node/blob/master/README.md): `_request_id`, Responses as the primary API.
- O6. [Models](https://developers.openai.com/api/docs/models): GPT-6 lineup and positioning.
- O7. [openai-node `src/resources/responses/responses.ts`](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts): `Response.model`/`status`/`service_tier`, `ResponseUsage` fields.

Google:

- G1. [Gemini API pricing](https://aistudio.google.com/docs/pricing): text and embedding prices, dated price changes, free-tier data use, Batch 50%.
- G2. [Interactions API](https://aistudio.google.com/docs/interactions) and [API reference: Interaction resource](https://aistudio.google.com/api-reference/interactions-api): recommended API, `id`/`model`/`status`/`usage` fields.
- G3. [Structured output](https://aistudio.google.com/docs/structured-output): `response_format`, supported and stripped keywords, validation guidance.
- G4. [Models](https://aistudio.google.com/docs/models): Gemini 4 and 3.x lineup and positioning.

Other:

- V1. [AI SDK: generating structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data): `Output.object`, `NoObjectGeneratedError`.
- V2. [AI SDK: `generateText` reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text): `usage`, `finalStep.response`, deprecations.
- Z1. [Zod: JSON Schema](https://zod.dev/json-schema): `z.toJSONSchema` (stable) and `z.fromJSONSchema` (experimental).
- Y1. [Voyage AI pricing](https://docs.voyageai.com/docs/pricing).
- N1. npm registry (`npm view`, 2026-11-15): latest versions and peer dependencies of `@anthropic-ai/sdk`, `openai`, `@google/genai`, `ai`, `@ai-sdk/*`, `voyageai`.

Repo sources (relative to repo root):

- R1. `packages/core/package.json`, `packages/api/package.json`: `zod` pinned to `4.4.3`.
- R2. `doc/adr/0002-deploy-serverless-aws-behind-cloudflare-access.md`: prod on API Gateway + Lambda.
