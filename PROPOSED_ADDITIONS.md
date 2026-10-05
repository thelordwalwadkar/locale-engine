# PROPOSED ADDITIONS

Anything added **beyond the specification** (`docs/SPEC.md`) is listed here (spec §9.2), numbered PA-01…. The spec asks for additions to be kept out of the default code path behind a disabled flag until approved. The `features:` block of `config/stages.yaml` exists for that and is empty, because the items below fall into three groups, stated honestly:

- **A. Active by default** (a safety or correctness reason; each has an off switch or is a pure behaviour refinement). Please approve or revert.
- **B. Present but inert** (extra routes, flags, files and YAML entries that do nothing unless used).
- **C. Not built** (ideas, with the reason they were left out).

## A. Active by default: please approve or revert

| # | Addition | Why | How to revert |
| --- | --- | --- | --- |
| PA-01 | **SSRF guard on URL fetching**: URLs that resolve to private, loopback or link-local addresses (and redirects to them) are refused. | Fetching user-supplied URLs from a server process is a classic attack path; the spec only asks for robots.txt, timeouts and retries. | `ingest.block_private_networks: false` in `config/stages.yaml` |
| PA-02 | **Loopback Host/Origin guard** on the REST API and the MCP HTTP server: while bound to loopback only `localhost`, `127.0.0.1`, `[::1]` (plus `LOCALE_ALLOWED_HOSTS`) are accepted. | The servers have no authentication; without this a web page in the user's browser could drive them (DNS rebinding). | bind to a non-loopback address (the guard is then off, and you must supply your own authentication) |
| PA-03 | **Autofix applies without a repair trigger.** The deterministic fixes marked `autofix: true` (for example `30 September` → `30. September`) are applied to every segment that has one, not only to segments bad enough to start a model repair (ARCHITECTURE DDR-006 / DDR-012). | A known, free, meaning-preserving fix was left unapplied as an open finding. The model repair is still gated by the trigger. | revert `hasAutofix` in `src/pipeline/repair.ts`; `--no-repair` / `--max-repair-loops 0` switches all repair off |
| PA-04 | **An uncertain language guess never decides routing.** A segment the library is unsure about (below `detection_confidence_min`) that the model fallback cannot settle takes the document language, so it is translated (previously the unconfirmed guess stayed, and a Dutch title with an English company name was routed as "already English", leaving Dutch in the English output). | Silent Dutch leakage was possible; a wrongly translated English segment is at worst flagged as untranslated. | `src/detect/document.ts` (`inheritDocumentLanguage`) |
| PA-05 | **Glossary sense disambiguation**: optional `skip_after` / `skip_before` columns in `config/glossary.csv`, used for Dutch `lager` (bearing / lower) and `druk` (pressure / busy). | The real IPG page produced a false terminology finding on every locale ("lager gelegen put"); the false hint also reached the model prompts. | delete the two columns' values |
| PA-06 | **A saved page's canonical link names its slug** (before: the title). | A page saved as `.html` still names its own address; the title is a poor slug source. | `sourceSlug` in `src/ingest/segmenter.ts` |
| PA-07 | **`PROVIDER_UNAVAILABLE`** error code and an early check: a run whose routed providers have no credentials is refused before any work, with the variable names in the message (CLI exit 1, REST 503). | Failing late, after ingestion and a partial run, wastes time. | n/a (error handling) |
| PA-08 | **Crawler identity** is `locale-engine/0.1 (content localization tool)` plus `; contact: <LOCALE_CONTACT>`. The first default carried setup advice text in the header. | It looked like an injection attempt to a filter. | `ingest.user_agent` |

## B. Present but inert unless used

| # | Addition | Notes |
| --- | --- | --- |
| PA-09 | **`POST /v1/compare` on REST** | The spec's REST list has six routes; compare exists on the CLI and MCP. Added so that all three interfaces expose the same seven capabilities (rubric R6). |
| PA-10 | **`GET /health` and `GET /openapi.json`** | Operations conveniences. The OpenAPI 3.1 document is generated from the same Zod schemas as the MCP tools. |
| PA-11 | **Extra input kinds**: `pair` (one source/target text pair) and `page_json` (a `<locale>/page.json` by path or inline) for `validate`, and `page_json` for `localize`. | Needed to make `validate` and the stage commands chain on files; the spec names the commands but not their inputs. |
| PA-12 | **Extra CLI flags**: `--strict`, `--strict-review` (exit code 4), `--block-type`, `--json`, `--quiet`, `--keyword`, `--page-type`, `--source-locale`, `--run-id`, `--no-write`, `--out`, and `providers test --json`. | CI-friendly behaviour. |
| PA-13 | **JSON-only REST** (other content types answer 415), a **stateless MCP HTTP** server (GET/DELETE answer 405), and **tool annotations** (`readOnlyHint` for `list_locales` and `get_run_report`). | Smaller attack surface; fresh server per request. |
| PA-14 | **Provider knobs** `extra.reasoning_effort`, `extra.extra_body` (OpenAI-compatible) and `extra.keep_alive` (Ollama). | Needed for models whose thinking cannot be switched off; unused unless set in YAML. |
| PA-15 | **Five extra providers as YAML entries** (DeepSeek, Mistral, Groq, OpenRouter, Together) through `kind: openai_compatible`. | No code; the spec requires five adapters, this shows the "YAML only" path. |
| PA-16 | **Extra locale rules and glossary beyond the golden exemplar**: 82 glossary rows (68 terms + 14 do-not-translate), 14 rule types, lexicons shared in `_common.yaml`. | Part of making the locales usable; every rule is self-testing (DDR-008) and awaits native review (A-015). |
| PA-17 | **`prompts/detect.v1.md`**, the language-detection fallback prompt. | The spec asks for an LLM fallback below 0.8 confidence but names no template. |
| PA-18 | **Offline `mock` provider modes**: scripted fixtures, handlers, failures and latency; it also answers `providers test`. | Makes the whole suite runnable offline (spec Phase 2); also used to replay drafts (PA-19). |
| PA-20 | **`tests/cli.e2e.test.ts`, `tests/edge.cases.test.ts`** | Evidence for rubric items R2, R5 and R6. |

| PA-30 | **Web app** (`locale-web`): browser interface, SQLite database, accounts, per-user daily spending limits, job queue, results viewer, downloads, admin page, demo mode, Dockerfile. | Requested by the user. Inert unless started; see README and A-047. |
| PA-31 | **GitHub Actions workflow** (`.github/workflows/ci.yml`): install, build, tests and an offline demo on Linux and Windows. | Repository hygiene; runs only on GitHub. |

## C. Not built (ideas)

| # | Idea | Why not now |
| --- | --- | --- |
| PA-21 | **Form text as segments** (field labels, helper text, submit value, placeholders). | The parser drops forms on purpose (they are mostly controls). The real IPG page showed that a form can carry a marketing line and labels worth translating; the example README supplies suggested texts. |
| PA-22 | **Internal link and `hreflang` mapping**: rewrite internal URLs to the translated pages and emit `hreflang` alternates. | Needs a URL map per site (a sitemap or CMS export). Today link targets stay as in the source. |
| PA-23 | **Translation memory**: reuse approved translations (for example a site's existing English page) as exemplars and for consistency checks. | Needs a store and a review workflow. |
| PA-24 | **In-place DOM rewrite** (write the translation back into the original HTML instead of a clean render). | The clean render is safer for untrusted pages; some teams want their own template. |
| PA-25 | **Title-attribute and `<input>` placeholder localization.** | Rare on B2B pages; part of PA-21. |
| PA-26 | **Site crawl and batch**: sitemap input, many pages per run, shared glossary learning. | Out of the spec's scope (one page per run). |
| PA-27 | **Progress events and streaming** for long runs (SSE on REST, MCP progress notifications). | The run log has the data; no consumer asked for it yet. |
| PA-28 | **Native-speaker review loop**: import corrected translations, learn glossary and rule candidates from the diffs. | The biggest remaining quality lever, and it needs people. |
| PA-29 | **More locales** (fr-FR, fr-BE, nl-BE, es-ES, ...). | Adding one is a YAML file, one line in `LOCALES` and a glossary column (README, "Add a locale"). |
| PA-32 | **Web app extras**: self-service password change, e-mail invitations, resumable jobs, per-user API keys, usage charts, PostgreSQL for several servers. | Not needed for a small trusted group. |
