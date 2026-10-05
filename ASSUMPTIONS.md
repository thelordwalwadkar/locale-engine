# ASSUMPTIONS

Every assumption made while building `locale-engine`, in the order it was made. The build ran without interruption (spec §9.1): where information was missing, the most conservative reasonable default was chosen and logged here.

Format: **ID · timestamp (local, 2026-09-30) · phase** — assumption. *Reason.* `Revert:` how to undo it.

---

### A-001 · 15:36 · Phase 0 — Implementation stack is TypeScript on Node 24, not Python
The spec's default `{{STACK}}` is Python 3.11+ (Typer, FastAPI, Pydantic v2, MCP Python SDK, httpx, trafilatura, lingua, openpyxl, pytest). This machine has **no Python interpreter** (`python.exe` is the Microsoft Store launcher stub and exits with "Python was not found"), but has Node v24.18.0 / npm 11.16.0 / git 2.54. The spec allows a stack change "if you have a reason; log it". Installing a language runtime machine-wide was not part of the request, and Python code I cannot execute could not satisfy success criterion 1 (tests must actually pass).

Mapping used throughout the repo:

| Spec (Python) | Used here (TypeScript / Node) |
|---|---|
| Python 3.11+ | Node ≥ 22.12 (built and tested on 24.18), TypeScript, ESM |
| Typer | commander |
| FastAPI | Fastify |
| Pydantic v2 | Zod 4 (validation **and** JSON Schema generation) |
| official MCP Python SDK | official `@modelcontextprotocol/sdk` (stdio + streamable HTTP) |
| httpx | built-in `fetch` (undici) |
| trafilatura | cheerio + purpose-built main-content heuristics |
| lingua-language-detector | a Node language detector chosen in Phase 4 (see the Phase 4 entry) |
| openpyxl | exceljs |
| pytest | vitest |
| python-docx | mammoth (docx → HTML) |

*Reason:* see above. `Revert:` the architecture (modules, contracts, YAML config, prompts) is language-neutral; a Python port would re-implement `src/` against the same `config/`, `prompts/` and `tests/fixtures/`.

### A-002 · 15:36 · Phase 0 — Project lives in a sub-folder `locale-engine/`
The spec says "at the root of an empty repository". The working folder (`Claude Sessions`) is neither empty nor a git repository (it holds unrelated SEO work). The repo was created as `Claude Sessions/locale-engine/` (the spec default `{{PROJECT_NAME}}`) with its own `git init`. Nothing outside that folder is touched. `Revert:` move the folder anywhere; it is self-contained.

### A-003 · 15:36 · Phase 0 — Git identity is repo-local
No global git identity exists. Commits use a repo-local identity (`Shubham Walwadkar <work e-mail omitted>`, taken from the session's user profile) and carry a `Co-Authored-By: Claude` trailer. `Revert:` `git config user.name/user.email` inside the repo; history can be rewritten with `git filter-repo` if desired.

### A-004 · 15:36 · Phase 0 — Brand spelling "Funnelling Revenue"
The spec writes "Funneling Revenue". The user's brand guidelines (session memory) fix the brand name with UK spelling, "Funnelling". Docs in this repo use "Funnelling Revenue". No behaviour depends on it.

### A-005 · 15:36 · Phase 0 — `src/` is flat, not `src/<project>/`
The spec's Python layout uses `src/{{PROJECT_NAME}}/…`. The TypeScript equivalent is `src/…` directly (package name is `locale-engine`). Sub-folder names are unchanged. Test files are `tests/*.test.ts` instead of `tests/test_*.py`.

### A-006 · 15:36 · Phase 0 — The spec is stored verbatim in `docs/SPEC.md`
Kept for requirement traceability and so later sessions can re-read the requirements instead of relying on a summary. Not part of the spec's repository tree; harmless to delete.

### A-007 · 15:36 · Phase 0 — Dependency installation is part of the build
The spec requires adapters to be written against the installed SDK's real interface ("install it and inspect"), so npm dependencies are installed into the project folder only (`node_modules/`, git-ignored). Versions are pinned by `package-lock.json`. No global installs.

### A-008 · 16:10 · Phase 1 — Shared rules live in `config/locales/_common.yaml`
The spec lists seven locale files. Rules that apply to every locale (integrity, SEO, currency policy, terminology, back-translation drift), the entity patterns, the market-claim data and two shared lexicons (British spelling for en-NL/en-GB, German ß and quotation marks for de-DE/de-AT) are data, not code, so they need a home. `_common.yaml` is merged into every profile at load time (`effective_rules` = common rules, then locale rules). *Revert:* inline the shared content into each locale file.

### A-009 · 16:10 · Phase 1 — Penalty is normalised per 100 words with a floor of 100 words
Spec §6.6: "minor = 1, major = 5, critical = 25, normalized per 100 words; quality_score = max(0, 100 − penalty)". Taken literally, one major error in a 27-word segment would score 100 − 5×100/27 ≈ 81, but the golden exemplar (§5.1, one major, 27 words) shows `quality_score: 95`. The only reading that reproduces the golden is `penalty = Σ weights × 100 / max(words, 100)`. That is implemented (`scoring.words_floor: 100` in stages.yaml) and asserted by a test on the golden. Segment and locale scores use the same formula, so a long page is judged per 100 words and a short segment is not over-penalised. *Revert:* set `scoring.words_floor: 1`.

### A-010 · 16:10 · Phase 1 — The LLM judge reports a confidence; glossary forms are lemmas with plural tolerance
Spec §6.6 makes "judge confidence < 0.7" a HUMAN_REVIEW trigger but the golden validation output shows no confidence field, so the judge's output schema adds `confidence` (0–1, required). Glossary cells hold singular lemmas; matching tolerates regular plurals (-en, -s, -es) and Italian nouns list singular|plural forms.

### A-011 · 16:10 · Phase 1 — Market-claim semantics
A source claim that names a country as a scope of service ("levering in heel Nederland") is retained in a target whose *region* equals that country (nl-NL → en-NL keeps "across the Netherlands"), because the claim is about that very market. For every other target it is neutralised unless `market_facts.<locale>.delivery` supplies the phrase, and the segment is always sent to HUMAN_REVIEW. Scope words without a country name ("landelijk", "nationwide") are treated as claims of the source market. The deterministic detector is regex-based (`_common.yaml → market_claims`) and intentionally covers whole-country scope and delivery/service-to-country phrasing only; company-origin statements ("a Dutch company") are not claims.

### A-012 · 16:10 · Phase 1 — Reformatting converts existing separators only
The normaliser rewrites separators, currency position and numeric date shape; it never adds or removes digit grouping (`1250` stays `1250`, so years and codes are safe) and never converts currencies or units (amounts stay EUR, metric stays metric). Ambiguous single separators (`1.250`) are resolved with the SOURCE locale's convention. Numbers are compared by value; separators are judged by the locale's `format` rules.

### A-013 · 16:10 · Phase 1 — Verdict gap
Spec §6.6 defines PASS (≥ threshold, no majors), PASS_WITH_NOTES (≥ threshold, minors only) and FAIL (below threshold after repairs), but not "score ≥ threshold with an unresolved major". Resolved as HUMAN_REVIEW with the reason "unresolved major finding after repair". Precedence when several apply: FAIL > HUMAN_REVIEW > PASS_WITH_NOTES > PASS; a critical finding that survives the repair loops is FAIL.

### A-014 · 16:10 · Phase 1 — Deliberate deviation from spec §9.2: SSRF guard is ON by default
URL ingestion refuses loopback, private-range and link-local addresses by default (`ingest.block_private_networks: true`). It is a security default for a tool that fetches arbitrary URLs from a REST API and an MCP server (an MCP client can be steered by prompt injection into fetching internal addresses). Spec §9.2 asks for additions to be disabled by default; this one is enabled and listed in PROPOSED_ADDITIONS.md so it can be switched off with one flag. Tests that use a local HTTP server switch it off explicitly.

### A-015 · 16:10 · Phase 1 — Native-speaker review is still required for the seeded linguistics
The glossary (≈70 terms × 7 locales) and the Helvetism / Austriacism / anglicism lists were written from professional knowledge, not reviewed by native speakers. Cells that are regional judgement calls (de-CH *Pikettdienst*, *Lieferfrist*, *Unterhalt*, *Inbetriebsetzung*; de-AT *Angebot* rather than *Offert*; it-IT tu-imperative list) should be confirmed by reviewers before the rules are treated as authoritative. The spec itself asks for [HYPOTHESIS] framing on anything regulatory; linguistic rules are enforced as written.

### A-016 · 20:30 · Phase 5 — A prompt for the language-detection fallback (`prompts/detect.v1.md`)
The spec lists five prompt templates (translate, localize, validate, backtranslate, repair) but also requires an LLM fallback for language detection when confidence is below 0.8 (Phase 4). That fallback needs a prompt, so a sixth template in the same v3.0 structure was added. It is only used for the fallback and only when a provider for the `language_detection` stage is available.

### A-017 · 20:30 · Phase 5 — Translate-only and localize-only results are "not validated"
`translate_content` and `localize_content` stop before validation, so their segments carry no validation block and their verdict is HUMAN_REVIEW with the reason `NOT_VALIDATED` (score 100 means "no findings", not "verified"). Exporters should show the stage switches of the run (`options.stages`) next to the score.

### A-018 · 20:30 · Phase 5 — `validate_content` defaults to no repair; `run` defaults to repair
`repair`, `backtranslate` and `write_outputs` are optional request options. Undefined means: repair on for `run`, off for `validate`; back-translation on; outputs written. A request can override each.

### A-019 · 20:30 · Phase 5 — No usable provider fails the run early
Before any work starts, the provider of every stage the run needs is resolved. If a stage has no provider with credentials (and the default provider has none either), the run stops with `PROVIDER_UNAVAILABLE` naming the environment variable to set, instead of failing segment by segment. A routed provider without credentials but with a usable default is not an error: the registry falls back and notes `PROVIDER_FALLBACK` (and `JUDGE_NOT_INDEPENDENT` when the judge then equals the translator).

### A-020 · 20:30 · Phase 5 — Judge failures degrade to deterministic validation, flagged for review
If the judge (or back-translation) call fails, the segment is still linted deterministically, the run log records `JUDGE_UNAVAILABLE` / `BACKTRANSLATION_SKIPPED`, and a judge failure adds the review reason `JUDGE_UNAVAILABLE` so the segment is HUMAN_REVIEW rather than silently PASS.

### A-021 · 20:30 · Phase 5 — Back-translation language
English for every non-English target (as in the golden exemplar); for English targets the segment's own source language. The deterministic similarity check only runs when the back-translation language equals the source language and the source has at least 6 words; otherwise the judge assesses drift.

### A-022 · 20:30 · Phase 5 — Unvalidated LLM tags, ids and sentinels
Model output without an `[EVIDENCE: …]`/`[HYPOTHESIS]` tag is kept but tagged `[HYPOTHESIS]` and logged as `EVIDENCE_TAG_ADDED`; a localization change without a rule id gets the rule `UNSPECIFIED`; terminology entries whose GLOSS id is not among the segment's glossary hits are dropped.

### A-023 · 01 Oct 01:20 · Phase 2 — Usage and cost semantics
`input_tokens` excludes cache reads; `cached_input_tokens` counts them. When a model has no cached-input price, cached tokens are billed at the normal input price, so the cost ceiling never under-counts. Usage and cost are summed over every attempt of a call (transport retries and the schema-repair retry). A call that fails after spending tokens (invalid JSON twice, truncation) carries that spend on `ProviderError` (`usage`, `cost_usd`, `attempts`) and the stage runner records it, so failures count toward the ceiling too.

### A-024 · 01 Oct 01:20 · Phase 2 — Sampling parameters the vendors reject
Claude 5.x models reject `temperature`/`top_p` (HTTP 400), Haiku 4.5 rejects `top_p` together with `temperature`, the GPT-6 family drops both, Gemini 3 drops `temperature` (Google recommends 1.0). These are listed in `unsupported_params`; the adapter drops them and logs `PARAM_UNSUPPORTED` exactly as spec §0.2 foresees. Consequence: the judge's temperature 0 is **not honoured** on those models — repeatability then rests on the deterministic layer, the MQM-derived score (DDR-005) and, if needed, a judge model that accepts temperature (e.g. via `openai_compatible`).

### A-025 · 01 Oct 01:20 · Phase 2 — Adapter choices
OpenAI is called through the Responses API (strict `json_schema`, `store: false`); Ollama through its REST `/api/chat` with `fetch` (the `ollama` package's non-streaming chat takes no abort signal); Anthropic through `output_config.format`. Anthropic has no JSON mode, so `json_mode` is sent as prompted there. Clients never read vendor environment variables implicitly (only `api_key_env`, `base_url`, `base_url_env` from YAML). A schema a dialect cannot express (records, tuples, recursion) is sent in prompted mode for that call with `NATIVE_JSON_UNAVAILABLE`. A call that is still truncated after the repair retry fails with `TRUNCATED` (not `SCHEMA_INVALID`) so the orchestrator splits the batch. Anthropic's server-side refusal `fallbacks` are not enabled: they would let the vendor switch models outside providers.yaml; refusals surface as `CONTENT_FILTER`.

### A-026 · 01 Oct 01:20 · Phase 2 — Retry policy and request mode
Backoff starts at 1 s, caps at 30 s, with jitter; a `Retry-After` above 60 s stops retrying. Requests are non-streaming (fine for ≈ 8k output tokens; much larger `max_tokens` would need streaming because Node's fetch has a ≈ 5-minute header timeout). `testProviders` uses `max_tokens: 1024` because thinking cannot be switched off on Opus 5.5 and GPT-6.

### A-027 · 01 Oct 01:20 · Phase 2 — Registry behaviour
Unknown provider ref → `INPUT_INVALID`; unknown model key → `CONFIG_INVALID`. `describe()` lists each provider's default model first (`testProviders` relies on it). Ollama needs no key, so it always counts as configured (`testProviders` reports `NETWORK` when no local server runs). `kind: custom` modules are imported eagerly by `createProviderRegistryAsync` (R1 proof: `tests/fixtures/providers/echo-adapter.mjs`).

### A-028 · 01 Oct 01:20 · Phase 2 — Prices and model ids
Prices and model ids in `config/providers.yaml` were checked on 2026-09-30 against the claude-api skill's model table and the vendors' price pages, except where `pricing_verified: false`: the Mistral `-latest` alias mapping and the OpenRouter ids/prices (each with a URL in `notes`). DeepSeek uses peak prices (off-peak is half); Gemini 3.8 Flash is at an introductory price until 2026-12-31. Anyone relying on the cost ceiling should re-verify prices before use.

### A-029 · 01 Oct 01:40 · Phase 3 — robots.txt semantics (RFC 9309)
A robots.txt answering 4xx, or redirecting more than 5 times, counts as unavailable: the fetch is allowed, `origin.robots` is `unknown` and a warning is recorded. A 5xx or an unreachable server after the retries gives `ROBOTS_DISALLOWED`. Only the first 512 KiB are parsed and the rules are matched on the product token `locale-engine` taken from `ingest.user_agent`.

### A-030 · 01 Oct 01:40 · Phase 3 — Segmentation conventions
A list gets one group id per outermost list; nested items share it and carry their own `depth` and `ordered`. An `anchor` block is a run that consists of exactly one link (optionally wrapped in span/button/font, including `<p><a>`); a button without a link is dropped. Unsafe link targets (`javascript:`, `vbscript:`, `data:`) are dropped at ingest and the link text stays. Table cells are flattened to one segment per cell with `<br/>` between their blocks; empty cells keep their column index. `.docx` images have no `src` (image data is never inlined).

### A-031 · 01 Oct 01:40 · Phase 3 — Source slug, keyword and "no content" rules
The source slug is lower-cased: URL path, else front-matter slug, else a path-like name, else the head of the title (up to 8 words). It is omitted for `/`, index files, numeric ids and malformed percent-escapes. "No translatable content found" means no translatable BODY segment — meta text alone does not count, so a JS-rendered page fails clearly. `doc_id` is `doc-` plus a hash of origin, segment ids and hashes (deterministic).

### A-032 · 01 Oct 01:40 · Phases 3–4 — Source locale and language confidence
`<html lang>` / `og:locale` are ignored when they contradict the detected language. ccTLDs only supply a region hint for the detected language (`nl`→NL, `uk`→GB, `de`/`at`/`ch` for German, `it`/`ch` for Italian); an unknown language gives `und`. A declared language (0.9) or an agreeing `<html lang>` (0.7) is combined with the detector's confidence as independent evidence; disagreement keeps the detector's answer and adds a warning.

### A-033 · 01 Oct 01:40 · Phase 4 — Language detector: ELD
The spec names `lingua-language-detector` (Python). Benchmarked on 164 short B2B strings (nl/en/de/it/fr/es) with identical cleaning and whitelist: ELD large 100 %, **ELD medium 99.4 % (kept)**, ELD small 99.4 %, tinyld heavy 97.0 %, tinyld normal 96.3 %, tinyld light 91.5 %, lande 89.0 % (lande is confidently wrong). Medium over large saves ≈ 134 MB RSS and 0.37 s load. ELD scores are not probabilities, so the confidence is a softmax (temperature 0.04) over the whitelisted scores: correct answers have a median of 0.99 and a 10th percentile of 0.95, the one wrong answer scored 0.50. The LLM fallback also accepts `fr` and `es` so French text is not mislabelled German. `tinyld` and `lande` were only candidates and are removed from the dependencies.

### A-034 · 01 Oct 01:40 · Phase 3 — Hardening of untrusted pages and known limits
Pages nested more than 1000 levels are refused (`INPUT_INVALID`); whitespace-free runs over 256 characters are ignored by the detector and the translatable check; all clean-up passes are linear (100 000 inline elements in one paragraph: 86 s → ≈ 4 s). **Known limitation:** the SSRF guard resolves the host once for the check and once inside `fetch`, so a DNS-rebinding window remains; closing it needs a pinned undici dispatcher, which is not a declared dependency (listed in PROPOSED_ADDITIONS.md).

### A-035 · 01 Oct 02:10 · Phase 8 — Comparison: who pays for what, and what counts
Cost rows are attributed by stage: translation / localization / repair belong to the candidate, validation / backtranslation to the judge (aggregated over all candidate runs and labelled with the judge ref), language detection to a third role `pipeline`. A candidate's `all` row totals the candidate stages only; there is no judge `all` row (the judge may also be a candidate, so two `all` rows would be indistinguishable) — the workbook shows the judge total and the grand total below the table. Score rows count OPEN findings including document-level ones so they reconcile with the Findings tab and the verdicts. Latency is the sum of call latencies (calls overlap, so it exceeds wall-clock time).

### A-036 · 01 Oct 02:10 · Phase 8 — Comparison: failures, independence and ranking
Tables hold successful candidates only; failures live in `notes` (`CANDIDATE_FAILED`, `CANDIDATE_INCOMPLETE`, `TARGETS_DIFFER`, `ROUTING_MISMATCH` = silent provider fallback, `SOURCE_DIFFERS`, `PRICING_UNKNOWN`, `SEGMENTS_WITHOUT_OUTPUT`, `LOCALE_NOT_VALIDATED`, `JUDGE_COST_SHARED`). Judge independence is per vendor: same provider and model → `JUDGE_NOT_INDEPENDENT: candidate <ref> is also the judge`; same provider, other model → "shares provider". An empty locale intersection still returns a valid report so the spend stays on record. Provider problems (unknown ref, missing credentials — including of the default judge) stop the comparison BEFORE any model call, and the output folder is created first so a bad path fails before money is spent. Ranking uses the quality score only (ties → lower cost → first listed); a provider that skipped segments can still win, but is flagged in a column, a note and a caution on the "best" row. Workbook strings starting with `= + - @` get a leading apostrophe (no formulas are ever written); costs are stored at 6 decimals. The workbook structure was verified by re-reading with exceljs, not by opening desktop Excel.

### A-037 · 01 Oct 02:40 · Phase 6 — What the report files show
Open-finding counts in the Summary tab and the executive summary are computed from findings with `status: open` (not from `counts.findings_*`). Validation_Findings lists `validation.findings` plus `document_findings` (segment column shows `(document)`); judge MQM errors appear there because the pipeline turns them into findings (`origin: llm_judge`). Repair records also appear in Localization_Changes with origin `repair` (and a `note` column naming loop and kind); per-segment judge recommendations that are not already locale recommendations are added to Market_Recommendations. The Segments tab shows texts exactly as stored, inline placeholders included, so a dropped tag is visible. Unvalidated runs (`options.stages.validate` false, or a `NOT_VALIDATED` reason) show "n/a (not validated)" instead of score and penalty; the verdict stays HUMAN_REVIEW and the summary adds a banner and a "run validation" next step.

### A-038 · 01 Oct 02:40 · Phase 6 — Safe rendering of untrusted page content
HTML and Markdown exports drop inline attributes outside a small allowlist (`href`, `title`, `target`, `rel`, `lang`, `dir`, `hreflang`, `class`), turn `javascript:`, `vbscript:` and `data:` URLs into `#` (HTML keeps the original in `data-blocked-href`/`data-blocked-src`; `data:image/*` on images is kept), escape Markdown control characters and table pipes, and write the HTML title from the title segment, else the H1, else "Untitled". Workbook cells are always strings; a string starting with `= + - @ TAB CR` gets one leading space (exceljs cannot set `quotePrefix`) and text over 32,000 characters is cut with a visible marker. `writeRunArtifacts` does not validate the report it is given (the engine always passes a valid one); the workbook is not byte-identical between runs (zip timestamps), all text files are.

### A-039 · 01 Oct 06:05 · Phase 7 — Interface decisions (CLI, REST, MCP)
JSON Schema is draft-07 everywhere (the MCP SDK hard-codes it in `tools/list`; REST, the OpenAPI document and the parity test use the same dialect). Exit codes: 0 ok, 1 failed (run status `FAILED`, no credentials), 2 usage, 3 cost ceiling (`HALTED_COST_CEILING`), 4 `--strict` and a locale is `FAIL` (`--strict-review` adds `HUMAN_REVIEW`; a locale with `NOT_VALIDATED` does not count as review); a `PARTIAL` run exits 0; when several apply FAILED beats the ceiling beats `--strict`. REST accepts JSON only (415 otherwise), maps engine codes to statuses (400 input, 404 run, 413 size, 422 URL/robots/ceiling/route, 502 fetch, 503 no credentials; `CONFIG_INVALID` and `INTERNAL` are 500 with a generic message). The MCP HTTP server is stateless (a fresh server per POST; GET and DELETE answer 405); tool failures are `isError` with `{code, message}` text and no `structuredContent` (SDK clients validate it against the output schema). Neither server has authentication; on loopback a Host/Origin allow-list guards against DNS rebinding (`LOCALE_ALLOWED_HOSTS` extends it). *Revert:* see PROPOSED_ADDITIONS PA-02, PA-12, PA-13.

### A-040 · 01 Oct 06:30 · Phase 9 — Real-page test when the site refuses this machine and no API key exists
A client site answers HTTP 403 ("IP address of the client has been rejected", header `X-403-status-by: dw.inj.check`, IIS) to this machine for every page, for the crawler and for the in-app browser alike; robots.txt allows the path. The engine does not disguise itself, change its identity or route around the block. The user pasted the page text in chat; the layout (heading levels, buttons, brand list, the one inline link, the form table, image alt text, head metadata) was read from the Internet Archive snapshot of 13 Mar 2026 and the page was rebuilt as a local HTML file with the pasted wording kept word for word, typos included. No API key exists here (only a base-URL variable, which was not used), so the six drafts were written by Claude in the chat session and replayed through the engine's offline `mock` provider as fixtures, under the provider name `claude-session` and the model label "claude-sonnet-5-5 (written in the chat session, no API call)", so every report names its author. The translation stage returns the neutral text (the de-DE text for de-CH), the localization stage the final text with its logged changes (derived by a token diff), the validation stage the author's self-review (scores follow a fixed convention, 96 = nothing found, 90 = a minor note; they are not measurements). The judge is therefore the author (`JUDGE_NOT_INDEPENDENT` is logged), back-translation is off, and every locale is `HUMAN_REVIEW` because two business claims need a person. *Revert:* delete `examples/`; with keys, run the normal CLI.

### A-041 · 01 Oct 06:35 · Phase 9 — Glossary terms with a second sense
`config/glossary.csv` gains two optional columns, `skip_after` and `skip_before` (regex fragments, case-insensitive, matched against up to 80 characters after or before a hit). A hit is dropped when they match. Set for `lager` (bearing; skipped before `gelegen`, `liggend…`, `geplaatst`, `staand…`, `dan`) and `druk` (pressure; skipped after `verkeer`, `bezet`, `bezig`, `agenda`, `periode` and before `erg`, `zeer`, `te`, `zo`, `heel`, `best`, `nogal`). Without this the real page produced a false `TERM-GLOSSARY-01` finding in all six locales and a wrong glossary hint in the prompts. The lists are deliberately short: a missed adjective use costs a false finding, a too-wide skip would hide a real one. *Revert:* empty the two columns.

### A-042 · 01 Oct 06:40 · Phase 9 — An unconfirmed language guess does not route a segment
Per-segment detection below `detection_confidence_min` goes to the model fallback. When the fallback is absent, fails, or answers `und` / `other` / nothing, the segment now takes the document language (method `inherited`) instead of keeping the library's weak guess. Reason: the real page's title "Werking centrifugaalpompen | Industrial Pump Group" was read as English (p = 0.74) and routed `ADAPT_ONLY` for the English targets, which would have left Dutch in the English title without a flag. Translating text that is already in the target language is harmless; not translating text that is not, is not. The warning texts changed accordingly. *Revert:* `src/detect/document.ts`, function `inheritDocumentLanguage`.

### A-043 · 01 Oct 06:45 · Phase 9 — Slug from a saved page, crawler identity
The source slug is taken, strongest first, from the fetched URL, a front-matter slug, the page's own `<link rel="canonical">` (when its path yields a usable slug), a path-like caller label, the title head. The default `ingest.user_agent` is `locale-engine/0.1 (content localization tool)`; `; contact: <LOCALE_CONTACT>` is appended when set (the earlier default carried the sentence "+set LOCALE_CONTACT in .env for a contact address"). Neither change was enough to get past the site's 403 (it is not a User-Agent block), and none was meant to. *Revert:* `sourceSlug` in `src/ingest/segmenter.ts`; `config/stages.yaml`.

### A-044 · 01 Oct 06:50 · Phase 9 — Deterministic autofix does not wait for a repair trigger
ARCHITECTURE DDR-006 started a repair loop only for a finding with `repair_trigger` (default: not minor) or a score under the threshold, so a lone minor finding with a known free fix (`30 September` → `30. September`, rule DEDE-DATE-02, `autofix: true`) stayed open and unfixed. Autofixes now run for every segment that has one (`hasAutofix` in `src/pipeline/repair.ts`); the model-based span repair is still gated by the trigger, so no model call is spent on minor findings. `--no-repair` and `--max-repair-loops 0` still switch all repair off. *Revert:* `src/pipeline/repair.ts`.

### A-045 · 01 Oct 06:55 · Phase 9 — REST compare route, `--out` semantics
The spec's REST list has six routes while the CLI and MCP also expose compare; rubric R6 asks for equivalent capabilities, so `POST /v1/compare` was added (PROPOSED_ADDITIONS PA-09). The CLI flag `--out <dir>` sets the run folder itself (`options.output_dir`), not a parent that receives `<run_id>/`; the help text said the latter and was corrected. Without it the default is `output/<run_id>/` (`LOCALE_OUTPUT_DIR` sets the parent). *Revert:* remove the route from `REST_ROUTES`.

### A-046 · 01 Oct 07:00 · Phase 9 — Housekeeping
The mock provider answers the `providers test` connectivity check (it failed with "the user message is not a JSON payload", so a fresh checkout reported a configured provider as broken). The language-detector libraries `tinyld` and `lande` (benchmark candidates only; ELD is used) were uninstalled. The targets schema names the valid locales in its error. Forms are still dropped by the parser on purpose; the real page showed a form can hold a marketing line and labels, listed as PROPOSED_ADDITIONS PA-21 with suggested texts in the example README.

### A-047 · 05 Oct 15:30 · Web app — browser interface, database, logins
`locale-web` (`src/web/`) is a second HTTP server next to the REST API, not an extension of it: the REST API stays unauthenticated and local; the web app has accounts. Database: SQLite through Node's built-in `node:sqlite` (no native dependency; experimental in Node 22/24 but stable in practice), one file in `LOCALE_DATA_DIR`, schema versioned with `PRAGMA user_version`. Passwords: scrypt (Node crypto), sessions: random 256-bit tokens stored only as SHA-256 hashes, 7-day cookie. Jobs run inside the web process (concurrency 1 by default) and are not resumable: a restart marks queued and running jobs failed. Job input is a URL or pasted text only (a file upload is read by the browser and sent as text), so a user can never make the server read its own files; the SSRF guard stays on. Spend control: per-job ceiling (default USD 2) and per-user daily limit (default USD 10, UTC day); queued and running jobs count at their reserved ceiling, finished jobs at their real cost; failures release the reservation. Failed-login lock-out is in memory (resets on restart). Demo mode routes every stage to the mock provider. *Not verified:* the Docker image (no Docker here), behaviour behind a real reverse proxy, any real provider call. *Revert:* delete `src/web/`, `tests/web.test.ts`, the `locale-web` bin and the Dockerfile.

*(Further entries are appended below as the build proceeds.)*
