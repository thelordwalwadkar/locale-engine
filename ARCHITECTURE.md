# locale-engine — Architecture

> Status: living document. Section 1 was written **before any code** (Phase 0, step-back abstraction).
> Sections 2–6 are updated as the build progresses. The "Excellence Rubric" (section 4) was written and scored in Phase 9.
> Every decision below is traceable to a rule ID, a spec clause (`docs/SPEC.md`) or an entry in `ASSUMPTIONS.md` (`A-nnn`).

---

## 1. Principles (Phase 0 — step-back abstraction)

The question asked before writing code: *what makes any multilingual content pipeline reliable, regardless of languages or vendors?* Nine principles fall out. Each is mapped to the module that enforces it.

### P1. Translation ≠ localization ≠ keyword targeting
Three different jobs with three different failure modes.

- **Translation** moves meaning between languages. Failure mode: omission, mistranslation, false friends.
- **Localization** moves the *text into a market*: vocabulary, number/date/currency conventions, tone, business claims. Failure mode: a de-CH page that reads like de-DE, or a claim that is false in the target market.
- **Keyword targeting** is about what a market *searches for*. A translated head term is a hypothesis, not a keyword.

Consequences: separate stages with separate prompts, parameters and outputs; every translated primary keyword leaves the pipeline as `TRANSLATED_UNVERIFIED` + `[HYPOTHESIS]` (spec §4.3 rule 3), never as a recommendation.

| Enforced in | |
|---|---|
| `pipeline/translate.ts`, `pipeline/localize.ts` | separate stages, separate prompt templates |
| `config/stages.yaml` | separate temperature / top-p per stage |
| `export/*` (`SEO_Meta`) | `keyword_status` column, always `TRANSLATED_UNVERIFIED` |

### P2. Entity fidelity: what must not change is protected, verified, and any allowed change is logged
Product codes, brand names, URLs, e-mail addresses, numbers and units are facts. The pipeline never *hopes* a model preserved them.

- Entities are extracted deterministically from source and target and compared.
- The only permitted rewrites are separators, currency position and numeric date shape. Each one is recorded as a `FORMAT_CHANGE` with its rule ID.
- The model is told to keep numbers exactly as written; **code** performs the reformat (single point of responsibility, fully auditable).

| Enforced in | |
|---|---|
| `lint/entities.ts`, `lint/formats.ts` | extraction, comparison, reformat + `FORMAT_CHANGE` log |
| `config/locales/_common.yaml` | `INTEGRITY-ENTITY`, `INTEGRITY-URL`, `INTEGRITY-EMAIL` (critical) |

### P3. Structure is part of the content
Every block keeps its `segment_id`, block type and order. Inline markup (links, emphasis) travels as numbered placeholders so a link can move inside a German sentence without the model ever touching a URL.

| Enforced in | |
|---|---|
| `ingest/segmenter.ts`, `util/inline.ts` | typed blocks, stable IDs, placeholder codec |
| `lint` rule `INTEGRITY-TAGS` | placeholder multiset + nesting check |
| `export/html.ts`, `export/markdown.ts` | structure-preserving render from block metadata |

### P4. Judge independence
A model grading its own output is biased toward it. Validation therefore (a) runs deterministic linters *first*, (b) routes the LLM judge to a different provider than the translator whenever one is configured, (c) runs at temperature 0, and (d) records `JUDGE_NOT_INDEPENDENT` when it cannot honour (b).

| Enforced in | |
|---|---|
| `providers/registry.ts` | stage→provider routing, independence check |
| `pipeline/validate.ts` | lint → back-translation → judge → score |
| `config/providers.yaml` | `routing.stages.validation` ≠ `routing.stages.translation` by default |

### P5. Locale rules are data, read by both the prompts and the linter
A rule lives once, in `config/locales/<locale>.yaml`, with an ID, a severity and executable test strings. The runtime prompt renders the same rules the linter enforces; nothing locale-specific is hard-coded in TypeScript or in prompt prose.

| Enforced in | |
|---|---|
| `config/locales/*.yaml` | frozen rule set (Phase 1) |
| `tests/config-integrity.test.ts` | every rule has ID, severity and ≥1 test string |
| `tests/lint.rules.test.ts` | every rule's test strings behave as declared |
| `pipeline/prompt-context.ts` | renders profile + glossary hits into templates |

### P6. Graceful degradation across providers
Providers differ: some ignore temperature, some lack native JSON, some are down, keys go missing, budgets end. The pipeline keeps going and says what happened.

- Unsupported parameters are dropped and logged `PARAM_UNSUPPORTED`.
- Native structured output falls back to *instruct → parse → validate → one retry*; a single segment that still fails becomes `PROVIDER_ERROR` and the run continues.
- A stage whose provider has no credentials falls back to the default provider (`PROVIDER_FALLBACK`).
- A cost ceiling halts scheduling of new calls, exports a partial report and marks the run `HALTED_COST_CEILING`.

| Enforced in | |
|---|---|
| `providers/base.ts`, `providers/structured.ts` | capability flags, JSON extraction/validation/retry |
| `providers/registry.ts` | fallback and routing |
| `telemetry/cost.ts` | ceiling |
| `pipeline/orchestrator.ts` | partial-result handling |

### P7. A prompt chain is a typed pipeline
Translate → localize → validate → repair. Each link receives **only** the structured output of the previous link plus frozen config, never free-form prose. Schemas are the single source of truth for every JSON shape that crosses a boundary (LLM output, REST body, MCP tool input, report file).

| Enforced in | |
|---|---|
| `schemas/*.ts` (Zod) | one definition → validation + JSON Schema for native structured output, REST, MCP |
| `prompts/*.v1.md` | versioned templates rendered with named variables only |

### P8. Auditability and honesty
Every finding carries `[EVIDENCE: <rule_id|segment_id>]` or `[HYPOTHESIS]`. Every change has a rule ID. Business facts are never invented: a market claim with no supplied fact is neutralised and escalated to a human. Legal content is translated, never localised, and always reviewed. Legal and regulatory pointers are hypotheses to verify with counsel, not advice.

| Enforced in | |
|---|---|
| `pipeline/evidence.ts` | tag normalisation; untagged LLM output becomes `[HYPOTHESIS]` |
| `lint` rule `INTEGRITY-MARKET-CLAIM` + `config/market_facts.yaml` | claim handling |
| `pipeline/orchestrator.ts` | legal routing (`TRANSLATE_ONLY` + `HUMAN_REVIEW`) |
| `telemetry/run-log.ts` | complete, redacted run log |

### P9. Deterministic first, model second
Anything a program can decide reliably (forbidden characters, separators, slug shape, length limits, entity equality, safe auto-fixes) is decided by a program: cheaper, repeatable, explainable. Models handle what needs language judgement. The repair stage applies deterministic auto-fixes before asking a model, and then sends the model **only the flagged spans plus their findings**.

| Enforced in | |
|---|---|
| `lint/*` | rule engine, `autofix` |
| `pipeline/repair.ts` | autofix → span-scoped LLM repair → re-validate (≤ `max_repair_loops`) |

### Supporting principle — reproducible and testable offline
Low temperatures, frozen config, versioned prompts, and a `MockProvider` that replays fixture JSON so the whole suite (including the golden-standard `nl-NL → de-CH` exemplar) runs with no network and no keys.

---

## 2. Module map (Phase 0 plan; refined below as modules land)

```
src/
  schemas/      Zod models — single source of truth for every JSON shape           (P7)
  config/       YAML/CSV loaders, path resolution, env loading                       (P5)
  util/         inline-tag codec, text helpers, hashing, concurrency, retry          (P3)
  telemetry/    run log, token/cost/latency records, cost ceiling, secret redaction  (P6, P8)
  providers/    LLMProvider contract, adapters, structured-output helper, registry   (P6)
  ingest/       url fetch (robots.txt), html/md/txt/docx parsing, segmenter          (P3)
  detect/       per-segment language detection, LLM fallback < 0.8                   (P1)
  lint/         deterministic rule engine, entities, formats, autofix                (P2, P5, P9)
  pipeline/     translate, localize, validate, repair, orchestrator, scoring         (P1, P4, P7)
  export/       json, markdown, html, xlsx report, executive summary                 (P8)
  compare/      multi-provider harness + scoring workbook
  interfaces/   cli.ts · api.ts (REST) · mcp_server.ts — thin adapters over one service layer
```

All three interfaces call the same service functions in `pipeline/operations.ts` and use the same schemas, which is what makes interface parity (R6) structural rather than aspirational.

---

## 3. Design decisions

Filled in progressively; each entry is `DDR-nnn` with the reason and the consequence.

### DDR-001 — Pivot rule: every German variant is produced directly from source
`de-DE`, `de-AT` and `de-CH` each have independent vocabulary (Angebot / Angebot / **Offerte**, Werktage / Werktage / **Arbeitstage**, Januar / **Jänner** / Januar, ß / ß / **ss**). Converting one variant into another would carry the first variant's choices into the second and hide under-localisation. The orchestrator therefore runs translate → localise once per German target, from the original source segment. `config/stages.yaml → locale_matrix.pivot: direct` records it; the schema accepts only the literal `direct`, so the config cannot express anything else. Cost: three German translations instead of one plus two conversions. Benefit: each locale's rules are applied to a text that was written for that locale.

### DDR-002 — Inline markup travels as numbered placeholders
Links, emphasis and line breaks inside a block become `<a1>…</a1>`, `<strong2>…</strong2>`, `<br3/>` with their attributes held in a side table. A URL never reaches a model, so it cannot be mistranslated; a link can move inside a German sentence; structure is verifiable (`INTEGRITY-TAGS`: same multiset, properly nested, any order). Literal `<`/`>` are stored as `&lt;`/`&gt;`. `src/util/inline.ts` is the only module that encodes/decodes the format. Span-scoped repair maps plain-text offsets back through the placeholders and expands spans so a placeholder pair is never split (`balanceSpan`).

### DDR-003 — The model keeps numbers verbatim; code reformats them
Prompts forbid touching numbers, units, codes and URLs. Afterwards `lint/formats.ts` converts separators / currency position / numeric-date shape to the target locale and logs a `FORMAT_CHANGE` with the locale's rule id. Entity preservation compares numeric *values*; separator conformity is a separate rule (`*-NUM-01`). One component is responsible for reformatting, so it is auditable and testable without a model.

### DDR-004 — Two kinds of schemas: wire schemas for models, domain schemas for storage
`schemas/llm.ts` holds what a model is asked to return: flat, every field required, no unions/records/defaults, so native structured-output modes accept them. `schemas/findings.ts`, `report.ts` and `api.ts` hold the richer persisted and interface shapes. The pipeline converts between them and adds the deterministic facts (ids, spans, scores).

### DDR-005 — Scores come from MQM penalties, never from the judge's own numbers
The judge's five dimension scores are reported but decide nothing. `quality_score` is computed from the weighted severities of deterministic findings plus judge MQM errors (ASSUMPTIONS A-009), which makes it repeatable across judges and runs; the judge's `confidence` only feeds the HUMAN_REVIEW rule.

### DDR-006 — Verdict precedence and the repair trigger
FAIL > HUMAN_REVIEW > PASS_WITH_NOTES > PASS (ASSUMPTIONS A-013). A **model** repair starts when any finding has `repair_trigger` (default: severity ≠ minor; SEO length rules opt in) or the score is below the pass threshold. Deterministic autofixes are free and meaning-preserving, so they run for every segment that has one, trigger or not (A-044). Business-claim neutralisations, legal pages and low judge confidence are never "repaired away": they are the HUMAN_REVIEW reasons.

### DDR-007 — Regex dialect for rule files
Patterns are JavaScript regex sources compiled with `u`+`g`(+`i`); `\b` is rewritten to a Unicode-aware boundary because the native `\b` treats "ä" as a non-word character (`src/util/regex.ts`, used by the linter and by the config-integrity test so the two can never disagree). Lexical rules that depend on grammatical agreement match a window (article + adjective + noun) so the repair model can re-inflect, e.g. *eine unverbindliche Offerte*.

### DDR-008 — Rules are self-verifying
Every rule carries `tests` (target, optional source/locale/market facts, `expect: pass|fail`, `fixed` for autofix). `tests/config-integrity.test.ts` checks the structure (Phase 1); `tests/lint.rules.test.ts` executes every test string through the engine (Phase 5). A rule without a test cannot exist: the schema requires one.

### DDR-009 — The output contract follows the provider's capability, the template does not change
Every runtime template ends with `{{output_contract}}`. For models whose `structured_output` is `native` or `json_mode` the contract is "reply with bare JSON"; for `prompted` models it is "`<thinking>` notes, then the JSON inside `<final_answer>`" (spec §6.3). The stage code asks the provider for its mode at call time (`StageRunner`), renders the fragment (`prompts/_fragments/output-*.md`) with the JSON Schema of the stage's wire schema, and the provider parses either form with the same tolerant extractor. One template set, every vendor.

### DDR-010 — Translation is neutral; localization is where the market appears
The translation stage receives the language-neutral glossary forms (de → the de-DE column, en → en-GB, it → it-IT) and no locale rules; the localization stage receives the target locale's glossary forms, its rules with ids, the market facts and the brand voice. This is exactly the golden exemplar (translation says "Angebot … Werktagen", localization changes them to "Offerte … Arbeitstagen" with rule ids) and gives every market adaptation an audit trail in `changes` (R4). Prompts for the two stages therefore differ in content, not just in instruction.

### DDR-011 — Market-claim decisions are made by code, executed by the model, verified by the linter
`findMarketClaims` finds geographic scope claims in the source; `claimAction` decides KEEP (claim is about the target market itself), REPLACE_WITH_FACT (market_facts supplies the phrase) or NEUTRALIZE (default). The decision travels in the localization payload; the model only performs the edit and logs it under `INTEGRITY-MARKET-CLAIM`; the judge is told to report exactly one major omission; the linter flags a restated claim. A claim is always a HUMAN_REVIEW reason and is counted once (judge and pipeline findings are de-duplicated), which reproduces the golden score of 95.

### DDR-012 — Repair loop: autofix → span-scoped model repair → re-validate
Each loop first applies deterministic autofixes (safe lexicon/slug/first-mention rules) to every segment that has one, then sends ONLY flagged spans (of segments that earned a model repair) with their findings to the model for segments the autofix did not touch, then re-validates every changed segment. A replacement that changes inline markup is rejected. Findings resolved by a repair stay in the segment's history with status `fixed`. Segments that nothing can change stop looping. Findings that need a business decision (`requires_human_review`) are never repaired.

### DDR-013 — One set of exemplars serves prompts and tests
`prompts/exemplars/golden.<stage>.json` holds the spec's golden standard per stage (input payload, thinking, output). The prompts embed them; the mock provider's golden fixtures and the golden end-to-end test are built from the same files, so the exemplar cannot drift from what the pipeline is tested to produce.

### DDR-014 — Batches, partial failure and halting
Segments are batched per (language, operation) within the limits of `stages.yaml → batching`. A failed or incomplete batch is retried once segment by segment (`BATCH_SPLIT`); a segment that still fails becomes `PROVIDER_ERROR` (verdict FAIL) and the run continues. The cost ceiling is checked before every call; when it trips, no further calls are made, unfinished segments are `NOT_PROCESSED`, the run status is `HALTED_COST_CEILING` and the partial report is still exported. A locale that crashes unexpectedly becomes a FAIL locale with the reason in the run log (`PARTIAL`).

### DDR-015 — Stage requests differ only in switches
`run`, `translate`, `localize` and `validate` share one orchestration path (`pipeline/orchestrator.ts`); they differ in which stages are on and where the source comes from (content, a page.json from `translate`, or a source/target pair). A translate-only or localize-only result is honest about it: its segments have no validation, so their verdict is HUMAN_REVIEW with the reason `NOT_VALIDATED`.
---

### DDR-016 — An unconfirmed language guess never routes a segment
Per-segment detection feeds the operation choice (`TRANSLATE_LOCALIZE`, `ADAPT_ONLY`, `SKIP_IDENTICAL`). A library guess below `detection_confidence_min` is sent to the model fallback; when the fallback is absent, fails or cannot settle it, the segment takes the document language. Routing text as "already in the target language" on a weak guess skips the translation silently (a Dutch title with an English company name was read as English, p = 0.74); translating text that already is in the target language is harmless. A.042.

### DDR-017 — Terms with a second sense carry their own disambiguation
A glossary row may declare `skip_after` / `skip_before` regexes (Dutch *lager* = bearing or "lower", *druk* = pressure or "busy"). The matcher that feeds the prompts is the same one the terminology rule uses, so a false hit can neither reach the model as a wrong hint nor surface as a false finding. A-041.

### DDR-018 — A demonstration without a model says so in every report
When no provider credentials exist, text written by a person or an assistant can still go through the real pipeline: the offline `mock` provider replays it as fixtures under an honest provider name (`claude-session`, model label "written in the chat session, no API call"), so segmenting, rules, format normalisation, claims, scoring and exports run for real and every report, workbook tab and summary names the author. The judge is then not independent (`JUDGE_NOT_INDEPENDENT`), and the verdict stays `HUMAN_REVIEW` when a business claim needs a person. A-040.

## 4. Excellence Rubric

Written in Phase 9 (spec §7). Each criterion is scored 1–5 against the spec's definition of 5, **before** the Phase 9 fixes (the state at commit `7656e98`, interfaces just landed) and **after**. The scores judge the stated criterion; the residual risks that no rubric row captures are listed under the table, because a 5 here does not mean "verified against live vendors or native speakers".

| # | Criterion | 5 = world-class | Before | After |
|---|---|---|---:|---:|
| R1 | Model agnosticism | New provider added via YAML + one adapter file; zero pipeline changes. | 5 | 5 |
| R2 | Linguistic correctness | Golden and all edge fixtures pass; de-CH has zero `ß`; false friends caught. | 4 | 5 |
| R3 | Integrity | Entities, structure and business claims handled exactly per §4.4. | 4 | 5 |
| R4 | Auditability | Every finding evidence-tagged; every change has a rule ID; run log complete. | 5 | 5 |
| R5 | Operability | One-command run; offline tests; clear README; cost ceiling enforced. | 3 | 5 |
| R6 | Interface parity | CLI, REST and MCP expose equivalent capabilities with identical schemas. | 4 | 5 |

### Evidence

- **R1.** Vendor SDKs are imported only inside `src/providers/` (`grep` over `src/`). An OpenAI-compatible vendor is a YAML block (five are shipped that way: DeepSeek, Mistral, Groq, OpenRouter, Together); anything else is one module referenced by `kind: custom` (`tests/fixtures/providers/echo-adapter.mjs`, loaded through the registry and `providers test` by `tests/providers.registry.test.ts` and `tests/providers.testcmd.test.ts`; the whole pipeline is exercised by two different offline vendors, one with native and one with prompted structured output, so it demonstrably needs no vendor SDK). Routing per stage and per run (`--provider stage=name:model`), credential fallback with a logged note, and the comparison harness all go through the registry.
- **R2.** `tests/pipeline.golden.test.ts` reproduces the spec's golden nl-NL → de-CH exemplar (score 95, one open finding, HUMAN_REVIEW); `tests/lint.rules.test.ts` executes all 186 rule test strings, and every autofix test checks the exact fixed text; `tests/edge.cases.test.ts` drives each of the six edge exemplars (false friends, en-NL vs en-GB, Jänner vs Januar and the date period, same-language input, mixed-language page, legal page) end to end; `DECH-SZ-01` is a critical rule.
- **R3.** §4.4 bullet by bullet: entities byte-identical (`INTEGRITY-ENTITY`, URL and e-mail rules; protected patterns); reformat only separators and currency position, each logged (`FORMAT_CHANGE`; the edge test asserts `€ 1.250,00` → `€1,250.00` with one logged change and no conversion); business claims neutralized and raised for review unless `market_facts.yaml` has the fact (`tests/lint.claims.test.ts`, `tests/pipeline.core.test.ts`, the golden test); structure (every segment keeps `segment_id`, block type, order, in `page.json`, `page.md`, `page.html`: `tests/export.*`, the 69-segment example); legal pages translate-only with every segment flagged (edge test).
- **R4.** `ensureTagged` adds `[HYPOTHESIS]` to any untagged model reason and logs `EVIDENCE_TAG_ADDED`; localization changes carry `rule` ids (the Swiss changes in the example are logged against the neutral German with `DECH-SZ-01`, `DECH-QUOTE-01`, `DECH-LEX-OFFERTE`, `GLOSS-0039`); the run log has a code for every notable event (`PROVIDER_FALLBACK`, `PARAM_UNSUPPORTED`, `RETRY`, `JUDGE_NOT_INDEPENDENT`, `COST_CEILING`, `HALT`, …), written to `run.json` and the Run_Log tab.
- **R5.** `locale run --input <url> --targets all` after `npm install && npm run build`; `npm run verify` runs the type-check and the whole suite with no network and no key (`tests/cli.e2e.test.ts` runs the real command line on the mock provider for all six locales); the README covers install, configuration, the three interfaces with an MCP client snippet, adding a provider and a locale, the iteration plan of spec §8.2 and Windows notes; the cost ceiling halts a run gracefully and counts failed calls too (`tests/pipeline.runner.test.ts`, `tests/engine.test.ts`; exit code 3 in `tests/interfaces.cli.test.ts`).
- **R6.** Seven capabilities on all three interfaces (`run_pipeline`, `translate_content`, `localize_content`, `validate_content`, `compare_models`, `list_locales`, `get_run_report`), built from one capability table. `tests/interfaces.parity.test.ts` asserts that the REST body schema, the MCP `inputSchema` and `z.toJSONSchema` of the shared Zod model are identical, and that the same request reaches the engine whether it came from the CLI, REST or MCP.

### What was below 5, and what fixed it

| # | Gap found | Fix |
|---|---|---|
| R2 | The six edge exemplars were prompt text plus rule-level tests, never proven end to end. A real page (IPG, Dutch, a client site) exposed a false `TERM-GLOSSARY-01` hit (*lager gelegen* = "lower", not "bearing") in every locale. | `tests/edge.cases.test.ts`; glossary `skip_after` / `skip_before` (A-041). |
| R3 | The same real page: a Dutch title carrying an English company name was read as English and routed "adapt only", which leaves Dutch in the English title unflagged. A known, free autofix (`30 September` → `30. September`) stayed an open finding because a minor finding never started a repair loop. | An unconfirmed language guess takes the document language (A-042, DDR-016); autofixes no longer wait for a trigger (A-044, DDR-006 / DDR-012). |
| R5 | The README was a stub; there was no end-to-end CLI test. | README, `tests/cli.e2e.test.ts`, `--out` help corrected (A-045). |
| R6 | REST had no compare route (spec §6.4 lists six; the CLI and MCP have seven capabilities). | `POST /v1/compare` (A-045, PA-09), parity tests extended to all seven. |

### Residual risks (honest, not part of the score)

1. **No live provider call was ever made** (no API keys during the build). The five adapters are tested against fake SDK clients; request shapes, structured-output modes, prices and `unsupported_params` follow vendor documentation read on 30 Sep 2026 and may need adjusting on first contact. `locale providers test` is the first thing to run with real keys.
2. **Linguistic quality of real model output and the locale rules are unreviewed by native speakers** (A-015). The rules are tested for internal consistency, not for being the last word on German-Swiss, Austrian or Italian B2B usage.
3. **The live site a client site refuses this machine (HTTP 403)**, so URL ingestion was proven on fakes, on local files and on a page rebuilt from pasted text, not on a successful live crawl of that site (A-040).
4. The workbook was verified by re-reading it with exceljs, not by opening desktop Excel (A-037/A-038). The SSRF guard resolves DNS before connecting, so a DNS-rebinding window remains (A-034). The judge's temperature 0 is not honoured by models that reject `temperature` (A-024). Forms on a page are skipped (PA-21). The example's judge is its author (A-040).

