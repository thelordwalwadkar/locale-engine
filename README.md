# locale-engine

Multi-locale content population engine for B2B web content: **ingest → detect → translate → localize → validate → repair → export**.

It takes a page (URL, `.html`, `.md`, `.txt`, `.docx`), Dutch or English, and produces one reviewed version per target market: **en-NL, en-GB, de-DE, de-AT, de-CH, it-IT** (nl-NL is built in and switched off by default). Translation, market localization and SEO adaptation are separate steps, every locale rule lives in a YAML file, deterministic linters run before and after the language model, and every finding says whether it is evidence or a hypothesis.

Four entry points over one engine: a **CLI** (`locale`), a **REST API** (`locale-api`), an **MCP server** (`locale-mcp`, stdio and streamable HTTP) and a **web app** (`locale-web`: browser interface, SQLite database, logins and spending limits). Five provider adapters (Anthropic, OpenAI, Google, any OpenAI-compatible endpoint, Ollama) plus an offline `mock` provider.

> **Honest status.** The whole suite (1,770+ tests) runs offline and passes. The provider adapters are tested against fake SDK clients; **no live model call was made while building** (no API keys were available), so adapter behaviour against the real vendor APIs, and the linguistic quality of real model output, are not yet verified. Linguistic rules were written without native-speaker review (see `ASSUMPTIONS.md`, A-015).

## Quick start

Requires **Node 22.12 or newer** (developed on Node 24). No Python.

```bash
npm install
npm run build
cp .env.example .env        # then fill in only the providers you use (Windows: copy .env.example .env)
node dist/interfaces/cli.js locales                    # list the supported locales (needs no key)
node dist/interfaces/cli.js providers test             # sends one tiny request to every configured provider
```

(`providers test` treats Ollama as configured because it needs no key, so without a running Ollama it reports it unreachable and exits 1. Name the providers you care about, for example `providers test anthropic openai`.)

Run a page (needs at least `ANTHROPIC_API_KEY`; judging defaults to OpenAI, so also `OPENAI_API_KEY`, or route it elsewhere, see below):

```bash
node dist/interfaces/cli.js run --input https://example.nl/pompen/centrifugaalpompen --targets all
node dist/interfaces/cli.js run --input ./page.html --targets de-CH,it-IT --out ./out
```

Try everything **offline** (no key, placeholder text, proves the plumbing): route every stage to the mock provider.

```bash
node dist/interfaces/cli.js run --input tests/fixtures/ingest/pumps-nl.html --targets all \
  --provider language_detection=mock --provider translation=mock --provider localization=mock \
  --provider validation=mock --provider backtranslation=mock --provider repair=mock --out ./demo
```

`npm run locale -- run ...` does the same through `tsx` without building. After `npm link` the commands are simply `locale`, `locale-api` and `locale-mcp`.

## What a run produces

`output/<run_id>/` (or `--out <dir>`, which then **is** the run folder):

| File | Content |
| --- | --- |
| `<locale>/page.json` | structured segments: source, translation, localized text, findings, changes, repairs |
| `<locale>/page.md`, `<locale>/page.html` | structure-preserving render (headings, lists, tables, links, image alt text) |
| `localization_report.xlsx` | 8 tabs: Summary, Segments, Validation_Findings, Localization_Changes, Market_Recommendations, SEO_Meta, Format_Changes, Run_Log |
| `executive_summary.md` | one page for stakeholders: verdicts, decisions needed from the business, what changed, cost |
| `run.json` | the full machine-readable report (every call, cost, log entry) |
| `model_comparison.xlsx` | `compare` runs only: Scores_by_Provider, Findings_by_Provider, Cost_Latency, Segment_Diff |

Verdicts per locale: `PASS`, `PASS_WITH_NOTES`, `HUMAN_REVIEW` (a business claim, a legal page, low judge confidence), `FAIL` (a critical rule or a score under the threshold after the repair loops). Scores are MQM-style penalties per 100 words (minor 1, major 5, critical 25).

## The three interfaces

All three validate with the same Zod schemas and call the same service, so they cannot drift apart (tests compare the JSON Schemas and the request each interface hands to the engine).

| Capability | CLI | REST | MCP tool |
| --- | --- | --- | --- |
| full pipeline | `locale run` | `POST /v1/pipeline` | `run_pipeline` |
| translate only | `locale translate` | `POST /v1/translate` | `translate_content` |
| localize | `locale localize` | `POST /v1/localize` | `localize_content` |
| validate an existing translation | `locale validate` | `POST /v1/validate` | `validate_content` |
| compare providers | `locale compare` | `POST /v1/compare` | `compare_models` |
| list locales and their rules | `locale locales` | `GET /v1/locales` | `list_locales` |
| read an earlier run | (open `run.json`) | `GET /v1/runs/{run_id}` | `get_run_report` |

Also: `locale providers test`, `GET /health`, `GET /openapi.json`.

### CLI

```bash
locale run --input <url|file> --targets all|de-CH,it-IT [--provider translation=openai:gpt] [--keyword <text>]
           [--pass-threshold 90] [--max-repair-loops 2] [--cost-ceiling 5] [--no-backtranslate] [--no-repair]
           [--out <dir>] [--json] [--quiet] [--strict | --strict-review]
locale translate --input ./page.md --targets de-DE            # writes a page.json per locale
locale localize --input ./output/<run_id>/de-CH/page.json     # a page.json goes back in by path
locale validate --source "Vraag een offerte aan" --target "Fordern Sie ein Angebot an" --target-locale de-CH
locale compare --input ./page.html --targets de-CH --providers anthropic,openai --judge anthropic
```

Exit codes: `0` ok, `1` failed (including no provider credentials), `2` usage error, `3` the cost ceiling halted the run, `4` `--strict` and a locale is `FAIL` (with `--strict-review` also `HUMAN_REVIEW`). `--json` prints the full result and nothing else.

### REST

```bash
node dist/interfaces/api.js --port 8787           # binds 127.0.0.1; there is no authentication built in
curl -s localhost:8787/v1/pipeline -H 'content-type: application/json' \
  -d '{"input":{"kind":"url","url":"https://example.nl/pompen"},"targets":["de-CH","it-IT"]}'
curl -s localhost:8787/v1/runs/<run_id>
```

JSON only. Errors have one shape, `{ "code": "...", "message": "..." }` (400 invalid request, 404 run not found, 413 body too large, 422 input cannot be processed, 502 fetch failed, 503 no provider credentials, 500 internal). On loopback only `localhost`, `127.0.0.1` and `[::1]` are accepted as Host/Origin (DNS-rebinding guard); `LOCALE_ALLOWED_HOSTS=a.example,b.example` adds names for a reverse proxy on the same machine. `/openapi.json` is generated from the same schemas.

### MCP

```bash
node dist/interfaces/mcp_server.js                    # stdio (Claude Desktop, Claude Code, other MCP clients)
node dist/interfaces/mcp_server.js --http --port 8788 # streamable HTTP at http://127.0.0.1:8788/mcp (stateless)
```

Claude Desktop / any client that takes a JSON server list (use absolute paths; keys can also stay in `.env`):

```json
{
  "mcpServers": {
    "locale-engine": {
      "command": "node",
      "args": ["C:/path/to/locale-engine/dist/interfaces/mcp_server.js"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-...", "OPENAI_API_KEY": "sk-..." }
    }
  }
}
```

Streamable HTTP client entry: `{ "mcpServers": { "locale-engine": { "type": "http", "url": "http://127.0.0.1:8788/mcp" } } }`. Claude Code: `claude mcp add locale-engine -- node C:/path/to/locale-engine/dist/interfaces/mcp_server.js` or `claude mcp add --transport http locale-engine http://127.0.0.1:8788/mcp`.

Tool failures come back as `isError` with `{code, message}` in the text block. Each tool's input and output schema is generated from the Zod models (JSON Schema draft-07, which is what the MCP SDK advertises).

## The web app (browser interface, database, logins)

```bash
npm run build
LOCALE_WEB_DEMO=1 node dist/web/server.js      # try it without keys: placeholder text   (PowerShell: $env:LOCALE_WEB_DEMO=1; node dist/web/server.js)
node dist/web/server.js                        # real run: needs the keys in .env
```

Open http://127.0.0.1:8080. The first start creates the administrator from `LOCALE_ADMIN_USER` / `LOCALE_ADMIN_PASSWORD` (or prints a random password once). Users paste a URL, paste text or upload an `.html/.md/.txt` file, pick languages, and watch the job; the result page shows the original beside every language with the flagged points, and offers a .zip, the Excel report and each page as HTML or Markdown. The administrator adds users, sets each user's **daily spending limit** and can disable or reset accounts.

What it stores: one SQLite file (`data/locale.db`: users with scrypt password hashes, login sessions, jobs) and one folder per job (`data/jobs/<id>/`). Spend is capped per job (`LOCALE_WEB_JOB_CEILING_USD`, default 2) and per user per UTC day (default 10 USD, the administrator can change it per user); a queued or running job counts at its reserved ceiling. The browser app only accepts URLs and pasted text, never server file paths; the crawler's private-network guard stays on. Sessions are `HttpOnly`, `SameSite=Strict` cookies; cross-site POSTs are refused; five failed logins per user and address lock them out for 15 minutes.

**Hosting it for other people.** GitHub stores the code; a host runs it. Any host that runs Node 24 or a Docker image works (Render, Railway, Fly.io, a VPS): use the included `Dockerfile`, set `LOCALE_ADMIN_PASSWORD`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` as the host's secret variables, and **mount a persistent disk at `/data`** (without one the database and results disappear on every restart). The host provides HTTPS; keep `LOCALE_WEB_SECURE=1`. Everyone who can sign in spends your API credits, within the limits above: create accounts only for people you trust, and keep the daily limits low. The Docker image was written but not built or run here (no Docker on the build machine).

## Configuration (everything is a file, nothing is hard-coded)

| File | What it holds |
| --- | --- |
| `.env` | credentials only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, ...), `OLLAMA_HOST`, `LOCALE_OUTPUT_DIR`, `LOCALE_COST_CEILING_USD`, `LOCALE_CONTACT` (put your address in the crawler's User-Agent). Loaded automatically; real environment variables win. Keys are redacted from every log. |
| `config/providers.yaml` | every vendor, its models (id, price, structured-output mode, unsupported parameters) and the **routing**: which provider runs which stage. Switching a stage is an edit here or `--provider stage=name[:model]`. |
| `config/stages.yaml` | per-stage temperature, top_p, max_tokens (with the reason for each), batching, concurrency, thresholds (pass score 90, repair loops 2, judge confidence 0.7, detection 0.8), scoring, cost ceiling (5 USD), crawler settings, legal-page URL patterns, locale matrix. |
| `config/locales/*.yaml` | one file per locale plus `_common.yaml`: the profile, the rules (id, severity, type, message, fix, **tests**), market checks. 14 rule types. Every rule carries test strings that are executed by the test suite. |
| `config/glossary.csv` | the termbase (one row per term, one column per locale, `\|` separates variants, brands marked do-not-translate). Optional `skip_after` / `skip_before` regexes tell the matcher when a word is used in another sense (Dutch *lager* = bearing, or "lower"). |
| `config/market_facts.yaml` | facts you supply per market (delivery scope, phone, ...). Without a fact, a market-specific claim ("delivery across the Netherlands") is neutralized and raised for human review. |
| `config/brand_voice.md` | optional brand voice text injected into the localization prompt. |
| `prompts/*.v1.md` | the runtime prompt chain (translate, localize, validate, back-translate, repair, detect) with golden and edge exemplars in `prompts/exemplars/`. |

### Choosing models per stage

```bash
locale run --input page.html --targets all --provider translation=openai:gpt --provider validation=anthropic:opus
```

The judge (`validation`, `backtranslation`) should not be the model that translated; the engine warns with `JUDGE_NOT_INDEPENDENT` when they match. A provider without credentials falls back to the default provider and the run log says so (`PROVIDER_FALLBACK`).

## Add a provider

**An OpenAI-compatible endpoint (DeepSeek, Mistral, Groq, OpenRouter, Together, vLLM, LM Studio, ...): YAML only.**

```yaml
# config/providers.yaml
providers:
  myvendor:
    kind: openai_compatible
    base_url: https://api.myvendor.example/v1
    api_key_env: MYVENDOR_API_KEY
    default_model: big
    models:
      big:
        id: myvendor-big-1
        pricing: { input_per_mtok: 1.0, output_per_mtok: 3.0 }
        pricing_verified: false
        structured_output: json_mode      # native | json_mode | prompted
        unsupported_params: [seed]
routing:
  stages:
    translation: myvendor
```

Add `MYVENDOR_API_KEY=` to `.env.example` (a test checks that the names match). Done: no pipeline code changes.

**Anything else: one adapter file.** Point the YAML at a module that exports `createProvider(args)` returning an object with `name`, `info` and `complete(system, messages, params, schema)`:

```yaml
providers:
  myhost:
    kind: custom
    module: adapters/myhost.mjs        # relative to the project root
    default_model: m1
    models: { m1: { id: my-model, structured_output: native } }
```

`tests/fixtures/providers/echo-adapter.mjs` is a complete working example, and `tests/providers.testcmd.test.ts` proves it runs through the registry, `providers test` and the pipeline unchanged. `BaseProvider` (`src/providers/base.ts`) gives you structured output, one schema-repair retry, parameter dropping, retries and cost accounting for free.

## Add a locale

1. Create `config/locales/<xx-YY>.yaml` (copy the closest locale: profile, rules with tests, market checks; shared rules come from `_common.yaml`).
2. Add the code to `LOCALES` in `src/schemas/common.ts`.
3. Add a column with that code to `config/glossary.csv`.
4. Add it to `locale_matrix.default_targets` in `config/stages.yaml`.
5. Optionally add an edge exemplar in `prompts/exemplars/` and list it in the profile.

`npm test` then verifies the new file (every rule has an id, severity and tests; every test string behaves as declared).

## Tests, offline

```bash
npm run verify     # type-check + the whole suite; needs no network and no key
npm test           # vitest only
```

The `mock` provider replays fixtures (the golden nl-NL → de-CH exemplar of the spec and the six edge-case exemplars), so the pipeline, the linters, the exports and the three interfaces are all exercised without a model.

## Iteration plan (when a result is not good enough)

- **Judge too lenient** → temperature is already 0; add more critical-severity rules to the deterministic linter, and route `validation` to a different provider.
- **Over-localization (meaning drift)** → raise `thresholds.back_translation_similarity_min` in `stages.yaml`; set the localization temperature to 0.2.
- **Under-localization (reads like de-DE in de-CH)** → add lexical rules to the locale profile and an exemplar.
- **JSON failures on a provider** → set that model's `structured_output` to `json_mode` or `native`, or lower `batching.max_segments` so each call returns less.
- **A glossary term is flagged in a sentence where the word means something else** → add `skip_after` / `skip_before` to its glossary row.
- **A locale keeps a Dutch phrase** → check the run log for `INGEST_WARNING` about language detection; the segment may have been routed as already being in the target language.

## Safety and behaviour worth knowing

- **Polite crawling.** `robots.txt` is honoured (RFC 9309), the crawler identifies itself (`locale-engine/0.1`, plus `LOCALE_CONTACT`), retries with backoff and caps the size. A site that refuses the crawler (HTTP 403) is reported as such; the engine does not disguise itself. Save the page as `.html` and use `--input file.html`, or ask the site owner to allow the crawler.
- **SSRF guard, on by default.** URLs that resolve to private, loopback or link-local addresses are refused (a deliberate addition, see `PROPOSED_ADDITIONS.md`).
- **Cost ceiling.** `--cost-ceiling` / `LOCALE_COST_CEILING_USD` halts the run gracefully at the next call and still writes every finished locale.
- **Nothing is silently dropped.** A segment a provider could not produce is reported (`PROVIDER_ERROR` or `NOT_PROCESSED`), never shown as passed. Forms are skipped on purpose (their text is not part of the page body).
- **Secrets.** Only in `.env` or the environment; redacted from logs, reports and error messages.

## Windows notes

Use the Node 24 LTS installer. `npm install` may print an `allow-scripts` warning about `esbuild` or `protobufjs` install scripts; it is harmless here. In PowerShell use `copy .env.example .env`. Paths with spaces need quotes. The MCP JSON above wants forward slashes or doubled backslashes.

## Project map

```
src/schemas      Zod schemas: the single source of truth for every shape that crosses a boundary
src/config       YAML/CSV loaders (frozen locale and glossary files are read, never redefined)
src/ingest       fetch (robots, SSRF), parse, segment (typed blocks, stable ids)     src/detect  per-segment language detection
src/providers    adapters, registry, mock, `providers test`                          src/lint    deterministic rule engine, autofix
src/pipeline     translate, localize, validate, repair, scoring, orchestrator, engine
src/export       page.json/md/html, the 8-tab workbook, executive summary             src/compare  provider comparison
src/interfaces   CLI, REST, MCP (thin adapters over the engine)                      src/telemetry  redaction, run log, cost ceiling
ARCHITECTURE.md  principles, design decisions (DDR-001...), the Excellence Rubric
ASSUMPTIONS.md   every decision made without asking          PROPOSED_ADDITIONS.md  everything added beyond the spec
docs/SPEC.md     the requirements, verbatim                    
```
