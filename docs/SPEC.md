> **Verbatim copy** of the build prompt ("MEGA PROMPT v3.0") as received on 2026-09-30. Do not edit.
> Deviations (e.g. the TypeScript stack) are recorded in `../ASSUMPTIONS.md`; the additions beyond this spec are in `../PROPOSED_ADDITIONS.md`.
> Where the spec says `pytest`, `Pydantic`, `FastAPI`, `Typer`, read `vitest`, `Zod`, `Fastify`, `commander` (see ASSUMPTIONS A-001).

---

# MEGA PROMPT v3.0 — Multi-Locale Content Population Engine (Builder)

> **Deployment:** Paste verbatim into Claude Code at the root of an empty repository.
> **Mode:** Zero-interruption autonomous execution. Log every assumption to `ASSUMPTIONS.md` and continue.
> **Framework:** Prompt Designer v3.0 (persona · objective · parameters · context · exemplars · output format · advanced reasoning · self-correction rubric).

---

## 0. MODEL & PARAMETER CONFIGURATION

### 0.1 Build-time (this prompt)

| Setting | Value | Justification |
|---|---|---|
| Execution environment | Claude Code | Needs file system, package install, test execution. |
| Recommended model | Strongest available Claude model | Multi-file architecture with strict contracts. |
| Temperature | 0.1–0.2 if configurable (Claude Code manages this internally) | Code generation must be deterministic and reproducible. |

### 0.2 Run-time (the tool you are building) — default stage parameters

These are **defaults stored in `config/stages.yaml`**, overridable per provider and per run. Document the justification inline in that YAML file exactly as below.

| Stage | Temperature | Top-P | Justification |
|---|---|---|---|
| Language detection (LLM fallback only) | 0.0 | 1.0 | Pure classification. |
| Translation | 0.2 | 0.9 | Fidelity first; slight freedom for natural phrasing. |
| Localization | 0.3 | 0.9 | Idiomatic adaptation needs modest variation; facts stay locked. |
| Validation (LLM judge) | 0.0 | 1.0 | Scoring must be repeatable across runs and models. |
| Back-translation | 0.0 | 1.0 | Literal mirror for drift detection. |
| Repair | 0.1 | 0.9 | Targeted fix of flagged spans only. |

When a provider does not support a parameter (e.g., reasoning models that ignore temperature), the adapter logs `PARAM_UNSUPPORTED` to the run log and proceeds.

---

## 1. PERSONA

You are a **Principal Localization Engineer and LLM Systems Architect** with 15 years of experience shipping enterprise translation-management systems for B2B manufacturers across the Benelux, DACH and Italian markets. You are fluent in the linguistic conventions of Dutch, British English, German (Germany, Austria, Switzerland) and Italian, and you design provider-agnostic LLM pipelines that expose the same capabilities through a CLI, a REST API and an MCP server.

**Tone of your code and docs:** precise, auditable, stakeholder-ready. **Style:** small modules, typed interfaces, config over code, every decision traceable to a rule ID or an explicit assumption.

---

## 2. OBJECTIVE

Build **`{{PROJECT_NAME}}`**, a content population engine that accepts URLs or raw content in Dutch or English and, for each requested target locale:

1. **Translates** the content into the target language.
2. **Localizes** it to the conventions, vocabulary, formats and market expectations of the target country.
3. **Validates** the result with deterministic linters plus an LLM judge, and produces a **localization recommendations report** for that market.

The engine is **model-agnostic**: any LLM reachable through an API (Anthropic, OpenAI, Google Gemini, DeepSeek, Mistral, any OpenAI-compatible endpoint, local Ollama) can power any stage, and the whole pipeline is exposed as **MCP tools** so it can be driven from Claude Desktop, Claude Code or any MCP client. A built-in **model comparison harness** runs the same input through multiple providers and produces a side-by-side quality/cost/latency workbook.

### 2.1 Success criteria (definition of done)

1. `pytest` passes with zero failures, including golden-standard and edge-case fixture tests.
2. One command (`{{CLI_NAME}} run --input <url|file> --targets all`) produces the full deliverable set for all six default target locales.
3. Swapping the provider for any stage requires only a change in `config/providers.yaml` — no code change.
4. The MCP server starts and lists all tools defined in §6.4; each tool returns schema-valid JSON.
5. Every validation finding carries `[EVIDENCE: <rule_id|segment_id>]` or `[HYPOTHESIS]`.
6. Numbers, units, product codes, model names and URLs survive translation byte-identical unless a locale rule explicitly reformats them (e.g., decimal separators), and every such reformat is logged.
7. The comparison harness produces `model_comparison.xlsx` for ≥2 providers on the fixture set.

### 2.2 Target audience of the outputs

- **Primary:** SEO/content leads at Funneling Revenue publishing localized B2B pages.
- **Secondary:** Client stakeholders and native-speaker reviewers who need a clear PASS/FAIL verdict with reasons.

---

## 3. PARAMETERS (runtime placeholders — fill before running, or accept defaults)

| Placeholder | Default | Description |
|---|---|---|
| `{{PROJECT_NAME}}` | `locale-engine` | Repository/package name. |
| `{{CLI_NAME}}` | `locale` | CLI entry point. |
| `{{STACK}}` | Python 3.11+, Typer, FastAPI, Pydantic v2, official MCP Python SDK, httpx, trafilatura, lingua-language-detector, openpyxl | Change only if you have a reason; log it. |
| `{{SOURCE_LANGUAGES}}` | `nl`, `en` | Accepted input languages. |
| `{{LOCALE_MATRIX}}` | see §4.1 | Source → target routing. |
| `{{DOMAIN_VERTICAL}}` | Industrial pumps & B2B manufacturing | Drives glossary seeding and exemplar tone. |
| `{{GLOSSARY_PATH}}` | `config/glossary.csv` | Termbase: term, per-locale equivalent, do-not-translate flag. |
| `{{BRAND_VOICE_PATH}}` | `config/brand_voice.md` | Optional brand guidelines injected into localization. |
| `{{MARKET_FACTS_PATH}}` | `config/market_facts.yaml` | Per-market business facts (delivery areas, lead times, phone numbers, currencies used in pricing). |
| `{{DEFAULT_PROVIDER}}` | `anthropic` | Fallback provider for all stages. |
| `{{JUDGE_PROVIDER}}` | a provider different from the translator | Reduces self-preference bias. |
| `{{PASS_THRESHOLD}}` | 90 (0–100 quality score) | Minimum score for PASS. |
| `{{MAX_REPAIR_LOOPS}}` | 2 | Automatic repair iterations before HUMAN_REVIEW. |
| `{{OUTPUT_DIR}}` | `./output/<run_id>/` | Deliverables location. |
| `{{COST_CEILING_USD}}` | 5.00 per run | Pipeline halts gracefully and reports when exceeded. |

---

## 4. CONTEXT

### 4.1 Default locale matrix

| Source | Target locale | Operation | Notes |
|---|---|---|---|
| `nl-NL` | `en-NL` | translate + localize | English for a Netherlands-based/international audience. |
| `nl-NL` | `en-GB` | translate + localize | British English for UK buyers. |
| `nl-NL` | `de-DE` | translate + localize | |
| `nl-NL` | `de-AT` | translate + localize | |
| `nl-NL` | `de-CH` | translate + localize | |
| `nl-NL` | `it-IT` | translate + localize | |
| `en-*` | `en-NL`, `en-GB` | **adapt only** (no translation) | Same language → localization pass only. |
| `en-*` | `de-DE`, `de-AT`, `de-CH`, `it-IT` | translate + localize | |
| `en-*` | `nl-NL` | translate + localize | Enabled by config; off by default. |

**Pivot rule:** German variants are always produced **directly from source** (never de-DE → de-CH conversion), because each variant has independent vocabulary. Log the decision in `ARCHITECTURE.md`.

### 4.2 Locale profiles (seed these into `config/locales/<locale>.yaml`)

Encode each profile as data with rule IDs. The linter and the prompts both read from these files; the rules are never hardcoded in prompt text.

**`en-NL` — English for a Netherlands audience**
- Spelling baseline: British (`-ise`, `colour`, `metre`). Rule `ENNL-SPELL-01`.
- Currency EUR, format `€1,234.56`; keep Dutch business references (KvK, BTW → "VAT (BTW)" on first mention).
- Eliminate Dutch-English false friends: *actueel* → "current" (never "actual"), *eventueel* → "possibly/if required" (never "eventual"), *offerte* → "quotation/quote" (never "offer"), *controleren* → "check" (never "control"). Rule `ENNL-FF-*`.
- Phone format `+31 …`; dates `30 September 2026` or `30/09/2026`.

**`en-GB` — British English**
- British spelling, `-ise` preferred (rule `ENGB-SPELL-01`), `aluminium`, `litre`, `programme` (non-software).
- Dates `DD/MM/YYYY`; currency per `market_facts` (GBP if priced for UK, else EUR retained and flagged).
- Metric units stay metric (UK industry standard); no imperial conversion unless configured.
- Tone: understated; avoid US superlatives ("awesome", "best-in-class" → rephrase). Rule `ENGB-TONE-01`.

**`de-DE` — German (Germany)**
- `ß` used per current orthography; quotation marks „…“; formal *Sie* in B2B.
- Numbers `1.234,56`; currency `1.234,56 €`; dates `30.09.2026`.
- *offerte* → *Angebot*; *werkdagen* → *Werktage*.
- Market checks: Impressum requirement (Digitale-Dienste-Gesetz), trust signals such as TÜV/DIN/VDMA references where genuine.

**`de-AT` — German (Austria)**
- Same orthography as de-DE (`ß` used); *Jänner* instead of *Januar* (rule `DEAT-MONTH-01`), *heuer* acceptable in informal copy.
- Numbers/dates as de-DE; currency EUR.
- Market checks: Impressum/Offenlegung (ECG, MedienG), ÖVGW for water/gas equipment where genuine.

**`de-CH` — German (Switzerland)**
- **No `ß` — always `ss`** (rule `DECH-SZ-01`, severity critical).
- Quotation marks «…» (rule `DECH-QUOTE-01`).
- Numbers `1'234.50` or `1 234.50` (rule `DECH-NUM-01`); currency CHF when priced for CH, else EUR retained and flagged.
- Helvetisms preferred in B2B: *Offerte* (not *Angebot*), *innert* (not *innerhalb*), *Rechnung* stays, *parkieren*, *Velo*.
- Market checks: SVGW for water/gas equipment where genuine; multilingual market note (FR/IT regions).

**`it-IT` — Italian**
- Formal *Lei*; numbers `1.234,56`; currency `1.234,56 €`; dates `30/09/2026`.
- Avoid unnecessary anglicisms where an established Italian term exists (*preventivo* for quote, *portata* for flow rate, *prevalenza* for head).
- Market checks: P.IVA display in footer, *marcatura CE* references.

All legal/regulatory market checks are emitted as **recommendations tagged `[HYPOTHESIS] — verify with counsel`**, never as legal advice.

### 4.3 SEO localization rules

1. Localize `<title>` (target ≤60 characters), meta description (≤155 characters), H1–H3, image alt text, anchor text and URL slug.
2. Slugs: lowercase, hyphenated, transliterate umlauts (`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`).
3. **Keywords are not translations.** A translated head term may not be the term the market searches. Every translated primary keyword is emitted in `seo_meta` with `keyword_status: "TRANSLATED_UNVERIFIED"` and `[HYPOTHESIS]`, ready for a downstream keyword-research step.
4. Emit the `hreflang` code for each output (`nl-NL`, `en-NL`, `en-GB`, `de-DE`, `de-AT`, `de-CH`, `it-IT`).

### 4.4 Content integrity rules (instructions, framed positively)

- Preserve every entity byte-identical: product codes (e.g., `N-3085`), brand names (Flygt, Godwin, Xylem), URLs, email addresses, numeric values, units.
- Reformat only separators and currency position, and log each reformat as `FORMAT_CHANGE` with the rule ID.
- Keep business claims exactly as stated in source unless `market_facts.yaml` supplies the market-specific fact. When a claim names a market (e.g., "delivery across the Netherlands") and no fact is supplied, neutralize the geographic scope and raise a `HUMAN_REVIEW` finding.
- Preserve document structure: every source block keeps its `segment_id`, block type (heading/paragraph/list item/table cell/alt/meta) and order.
- Route legal pages (Impressum, privacy, terms) to translation only, never localization of legal substance, and mark them `HUMAN_REVIEW`.

### 4.5 Provider landscape (build adapters for)

- `anthropic` (Messages API), `openai` (Chat Completions/Responses), `google` (Gemini API), `openai_compatible` (generic `base_url` + key — covers DeepSeek, Mistral, Groq, OpenRouter, Together, vLLM), `ollama` (local).
- Model IDs live **only** in `config/providers.yaml`. Keys live only in `.env`. Before writing each adapter, check the provider SDK's current interface (install it and inspect, or read its docs) and log the version you targeted.

---

## 5. EXEMPLARS

### 5.1 GOLDEN STANDARD — `nl-NL` → `de-CH` (this is the quality bar for every stage)

<example type="golden_standard">

**Input segment**
```json
{
  "segment_id": "p-003",
  "block_type": "paragraph",
  "source_locale": "nl-NL",
  "text": "Onze centrifugaalpompen leveren een debiet tot 450 m³/h bij een opvoerhoogte van 80 meter. Vraag vandaag nog een vrijblijvende offerte aan — levering binnen 5 werkdagen in heel Nederland."
}
```
`market_facts.yaml` contains no `de-CH.delivery` entry.

**Translation stage output (de, neutral)**
```json
{
  "segment_id": "p-003",
  "target_locale": "de-CH",
  "translation": "Unsere Kreiselpumpen fördern bis zu 450 m³/h bei einer Förderhöhe von 80 Metern. Fordern Sie noch heute ein unverbindliches Angebot an – Lieferung innerhalb von 5 Werktagen in den gesamten Niederlanden.",
  "entities_preserved": ["450 m³/h", "80"],
  "terminology_applied": [
    {"source": "centrifugaalpomp", "target": "Kreiselpumpe", "rule": "GLOSS-0012"},
    {"source": "opvoerhoogte", "target": "Förderhöhe", "rule": "GLOSS-0019"}
  ]
}
```

**Localization stage output**
```json
{
  "segment_id": "p-003",
  "target_locale": "de-CH",
  "localized_text": "Unsere Kreiselpumpen fördern bis zu 450 m³/h bei einer Förderhöhe von 80 Metern. Fordern Sie noch heute eine unverbindliche Offerte an – Lieferung innert 5 Arbeitstagen.",
  "changes": [
    {"from": "ein unverbindliches Angebot", "to": "eine unverbindliche Offerte", "rule": "DECH-LEX-OFFERTE", "reason": "[EVIDENCE: DECH-LEX-OFFERTE] Offerte is the standard Swiss B2B term for a quotation."},
    {"from": "innerhalb von 5 Werktagen", "to": "innert 5 Arbeitstagen", "rule": "DECH-LEX-INNERT", "reason": "[EVIDENCE: DECH-LEX-INNERT] Swiss preposition; Arbeitstage is the common Swiss usage."},
    {"from": "in den gesamten Niederlanden", "to": "", "rule": "INTEGRITY-MARKET-CLAIM", "reason": "[EVIDENCE: market_facts.yaml has no de-CH.delivery] Geographic claim neutralized; delivery scope for Switzerland unconfirmed."}
  ],
  "requires_human_review": true
}
```

**Validation stage output**
```json
{
  "segment_id": "p-003",
  "target_locale": "de-CH",
  "deterministic_checks": [
    {"rule": "DECH-SZ-01", "result": "PASS", "note": "[EVIDENCE: DECH-SZ-01] No ß present."},
    {"rule": "INTEGRITY-ENTITY", "result": "PASS", "note": "[EVIDENCE: p-003] 450 m³/h and 80 preserved."}
  ],
  "llm_judge": {
    "scores": {"accuracy": 95, "fluency": 98, "terminology": 100, "locale_conventions": 100, "style_brand": 95},
    "mqm_errors": [
      {
        "category": "accuracy/omission",
        "severity": "major",
        "source_span": "in heel Nederland",
        "target_span": "",
        "explanation": "[EVIDENCE: INTEGRITY-MARKET-CLAIM] Deliberate neutralization; business must confirm Swiss delivery scope and lead time.",
        "suggested_fix": "Add de-CH.delivery to market_facts.yaml, e.g. 'in die ganze Schweiz' with confirmed lead time."
      }
    ]
  },
  "back_translation": "Our centrifugal pumps deliver up to 450 m³/h at a head of 80 metres. Request a non-binding quotation today – delivery within 5 working days.",
  "quality_score": 95,
  "verdict": "HUMAN_REVIEW",
  "localization_recommendations": [
    "[HYPOTHESIS] Show prices in CHF and add a Swiss contact number if the client serves CH directly.",
    "[HYPOTHESIS] Reference SVGW certification if the pumps are used in potable-water applications and certification exists — verify."
  ]
}
```

**Why this is golden:** entities preserved, glossary applied with rule IDs, Helvetisms applied from the profile, the market claim handled safely instead of invented, every rationale evidence-tagged, verdict escalated for the one business decision a model cannot make.

</example>

### 5.2 Edge-case exemplars

<example type="edge_false_friend">
`nl-NL` → `en-NL`. Source: *"Neem contact op voor een actuele offerte."*
Correct: "Contact us for a current quotation." Incorrect: "…an actual offer." Finding: `[EVIDENCE: ENNL-FF-ACTUEEL, ENNL-FF-OFFERTE]`.
</example>

<example type="edge_variant_divergence">
`nl-NL` → `en-GB` vs `en-NL`. Source mentions *"BTW"* and a price *"€ 1.250,00 excl. BTW"*.
`en-NL`: "€1,250.00 excl. VAT (BTW)". `en-GB` with no GBP pricing in `market_facts`: "€1,250.00 excl. VAT" + finding `[HYPOTHESIS] UK buyers expect GBP pricing — confirm currency policy.`
</example>

<example type="edge_de_at_month">
`nl-NL` → `de-AT`. Source: *"Beschikbaar vanaf januari 2027."* → "Verfügbar ab Jänner 2027." `[EVIDENCE: DEAT-MONTH-01]`. The de-DE output of the same segment keeps "Januar".
</example>

<example type="edge_same_language">
Source detected `en-GB`, target `en-GB`. Operation = `SKIP_IDENTICAL`: output copied, validation runs deterministic checks only, report notes `[EVIDENCE: detection p=0.98] Source already in target locale.`
</example>

<example type="edge_mixed_language">
Source page is Dutch with an English product-spec table. Detection runs per segment; English segments are translated from English, Dutch segments from Dutch. Report lists per-segment detected language.
</example>

<example type="edge_legal_page">
URL path contains `/privacyverklaring`. Page classified `LEGAL`; translation only; every output segment carries `requires_human_review: true`; localization recommendations list the market's imprint/privacy requirements tagged `[HYPOTHESIS] — verify with counsel`.
</example>

<example type="edge_broken_json">
Provider returns prose around the JSON. Adapter strips fences, re-parses, validates against the Pydantic schema, retries once with a schema-repair instruction, then marks the segment `PROVIDER_ERROR` and continues the run.
</example>

---

## 6. OUTPUT — WHAT YOU BUILD

### 6.1 Repository structure

```
{{PROJECT_NAME}}/
├── ARCHITECTURE.md          # step-back principles + design decisions
├── ASSUMPTIONS.md           # every assumption, timestamped
├── README.md                # install, configure, run CLI/API/MCP, add a provider, add a locale
├── .env.example
├── config/
│   ├── providers.yaml       # provider → model → params; stage → provider routing
│   ├── stages.yaml          # default temps/top-p with inline justification
│   ├── glossary.csv         # seeded with ≥40 industrial pump terms × 7 locales
│   ├── market_facts.yaml    # empty template with commented examples
│   ├── brand_voice.md       # template
│   └── locales/             # nl-NL, en-NL, en-GB, de-DE, de-AT, de-CH, it-IT
├── prompts/                 # versioned runtime prompt templates (v3.0 structure each)
│   ├── translate.v1.md
│   ├── localize.v1.md
│   ├── validate.v1.md
│   ├── backtranslate.v1.md
│   └── repair.v1.md
├── src/{{PROJECT_NAME}}/
│   ├── ingest/              # url_fetcher.py, html_parser.py, text_loader.py, segmenter.py
│   ├── detect/              # language detection (lingua, LLM fallback)
│   ├── providers/           # base.py (interface), anthropic.py, openai.py, google.py, openai_compatible.py, ollama.py, registry.py
│   ├── pipeline/            # translate.py, localize.py, validate.py, repair.py, orchestrator.py
│   ├── lint/                # deterministic rule engine reading locale YAML
│   ├── schemas/             # Pydantic models = single source of truth for all JSON
│   ├── export/              # json, markdown, html (structure-preserving), xlsx report
│   ├── compare/             # multi-provider harness + scoring
│   ├── interfaces/          # cli.py, api.py (FastAPI), mcp_server.py
│   └── telemetry/           # token, cost, latency, run log
└── tests/
    ├── fixtures/            # golden + every edge case in §5
    └── test_*.py
```

### 6.2 Provider interface (contract)

```python
class LLMProvider(Protocol):
    name: str
    def complete(
        self,
        system: str,
        messages: list[Message],
        params: StageParams,          # temperature, top_p, max_tokens, seed
        response_schema: type[BaseModel] | None,
    ) -> ProviderResult: ...          # parsed object, raw text, usage, latency_ms, cost_usd
```
Use native structured output / JSON mode when a provider offers it; otherwise instruct + parse + validate + single retry.

### 6.3 Runtime prompt templates

Each file in `prompts/` follows the v3.0 structure: persona, objective, injected locale profile (from YAML), injected glossary hits for the segment, golden exemplar (from §5.1 adapted to the stage), edge exemplars relevant to the locale, JSON output schema, `<thinking>` for reasoning and `<final_answer>` wrapping the JSON. Templates are rendered with named variables only — no string concatenation in code.

### 6.4 Interfaces

- **CLI:** `run`, `translate`, `localize`, `validate`, `compare`, `locales`, `providers test`.
- **REST (FastAPI):** `POST /v1/pipeline`, `POST /v1/translate`, `POST /v1/localize`, `POST /v1/validate`, `GET /v1/locales`, `GET /v1/runs/{run_id}`.
- **MCP server** (official MCP Python SDK, stdio + streamable HTTP): tools `run_pipeline`, `translate_content`, `localize_content`, `validate_content`, `compare_models`, `list_locales`, `get_run_report`. Each tool's input/output schema is generated from the Pydantic models. Include a ready-to-paste MCP client config snippet in the README.

### 6.5 Deliverables per run (`{{OUTPUT_DIR}}`)

1. `<locale>/page.json` — structured segments.
2. `<locale>/page.md` and `<locale>/page.html` — structure-preserving render.
3. `localization_report.xlsx` with tabs:
   - `Summary` — verdict per locale, quality score, cost, provider per stage.
   - `Segments` — segment_id, block type, source, one column per target locale.
   - `Validation_Findings` — locale, segment, rule/category, severity, evidence tag, suggested fix.
   - `Localization_Changes` — every from→to change with rule ID.
   - `Market_Recommendations` — per-locale recommendations, all tagged.
   - `SEO_Meta` — title, meta description, slug, hreflang, primary keyword + `keyword_status`.
   - `Format_Changes` — every numeric/currency/date reformat.
   - `Run_Log` — timestamps, retries, PARAM_UNSUPPORTED, PROVIDER_ERROR.
4. `executive_summary.md` — one page for stakeholders.
5. `compare` runs additionally write `model_comparison.xlsx` (tabs: `Scores_by_Provider`, `Findings_by_Provider`, `Cost_Latency`, `Segment_Diff`).

### 6.6 Scoring model

- Per-segment MQM-style penalties: minor = 1, major = 5, critical = 25, normalized per 100 words; `quality_score = max(0, 100 − penalty)`.
- Any critical deterministic rule failure (e.g., `DECH-SZ-01`, entity mismatch) forces `FAIL` before repair.
- Verdicts: `PASS` (≥ `{{PASS_THRESHOLD}}`, no majors), `PASS_WITH_NOTES` (≥ threshold, minors only or recommendations), `FAIL` (below threshold after `{{MAX_REPAIR_LOOPS}}`), `HUMAN_REVIEW` (business claim, legal page, or judge confidence < 0.7).

---

## 7. ADVANCED REASONING & WORKFLOW (execute phases in order)

### Phase 0 — Step-Back Abstraction
Before writing code, write `ARCHITECTURE.md` section 1 "Principles": derive the general principles of reliable multilingual content pipelines (translation ≠ localization ≠ SEO keyword targeting; fidelity of entities; structure preservation; judge independence; config-driven locale rules; graceful degradation across providers). Then state how each principle maps to a module.

### Phase 1 — Frozen Locale & Glossary Phase
Create all locale YAML profiles, the seeded glossary and the schema models. Write `tests/test_config_integrity.py` (every rule has an ID, severity and at least one test string). **These files are frozen**: later phases read them and never redefine rules inline.

### Phase 2 — Provider layer
Implement the interface, all adapters, registry and a `providers test` command that sends a trivial schema-bound request. Tests use a `MockProvider` returning fixture JSON so the suite runs offline.

### Phase 3 — Ingestion & segmentation
URL fetch (respect robots.txt, set a descriptive User-Agent, timeout, retry with backoff), main-content extraction, capture meta tags and alt text, segment into typed blocks with stable IDs. Also accept `.html`, `.md`, `.txt`, `.docx`.

### Phase 4 — Detection
Per-segment language detection; LLM fallback only when confidence < 0.8.

### Phase 5 — Translate → Localize → Validate → Repair
Implement stages as independent functions orchestrated per locale, parallelized across locales with a concurrency limit. Repair receives only flagged spans plus findings.

### Phase 6 — Export
All formats in §6.5, driven by the schemas.

### Phase 7 — Interfaces
CLI, REST, MCP. Verify MCP tool listing in a test.

### Phase 8 — Comparison harness
Run fixtures across configured providers, compute scores, write the comparison workbook.

### Phase 9 — Rubric-Based Self-Correction (mandatory, final)
First, write this rubric to `ARCHITECTURE.md` section "Excellence Rubric", then score the build 1–5 on each criterion, fix anything below 5, and re-score:

| # | Criterion | 5 = world-class |
|---|---|---|
| R1 | Model agnosticism | New provider added via YAML + one adapter file; zero pipeline changes. |
| R2 | Linguistic correctness | Golden and all edge fixtures pass; de-CH has zero `ß`; false friends caught. |
| R3 | Integrity | Entities, structure and business claims handled exactly per §4.4. |
| R4 | Auditability | Every finding evidence-tagged; every change has a rule ID; run log complete. |
| R5 | Operability | One-command run; offline tests; clear README; cost ceiling enforced. |
| R6 | Interface parity | CLI, REST and MCP expose equivalent capabilities with identical schemas. |

### Prompt chaining note
The runtime pipeline is itself a prompt chain (translate → localize → validate → repair). Each link receives only the structured output of the previous link plus frozen config, never free-form prose.

---

## 8. TESTING & ITERATION

### 8.1 Clarity check (apply to every runtime prompt you write)
Read each template as if you were a human translator receiving it cold. If a colleague would need to ask "which spelling?", "can I change this number?" or "what if the source mentions a country?", the template is incomplete — add the rule or exemplar and log the change.

### 8.2 Iteration plan (document in README)
- Judge too lenient → lower temperature is already 0; add more critical-severity rules to the deterministic linter and switch `{{JUDGE_PROVIDER}}`.
- Over-localization (meaning drift) → back-translation similarity check threshold raised; localization temperature to 0.2.
- Under-localization (reads like de-DE in de-CH) → add lexical rules to the profile, add an exemplar.
- JSON failures on a provider → enable native JSON mode or lower max output per call by batching fewer segments.

---

## 9. OPERATING RULES FOR THIS BUILD

1. Run end-to-end without pausing. When information is missing, choose the most conservative reasonable default, record it in `ASSUMPTIONS.md` with the phase number, and continue.
2. Surface anything you add beyond this specification in a section `PROPOSED_ADDITIONS.md`, kept out of the default code path (behind a disabled config flag) until approved.
3. Keep secrets in `.env`; redact keys from all logs.
4. Commit after each phase with message `phase-N: <summary>`.

---

## 10. FINAL ANSWER FORMAT

After Phase 9, print:

```
<thinking>
Brief reflection: rubric scores before/after, what was fixed, residual risks.
</thinking>
<final_answer>
{
  "status": "COMPLETE",
  "rubric_scores": {"R1": 5, "R2": 5, "R3": 5, "R4": 5, "R5": 5, "R6": 5},
  "tests": {"passed": <n>, "failed": 0},
  "providers_implemented": ["anthropic","openai","google","openai_compatible","ollama"],
  "locales": ["nl-NL","en-NL","en-GB","de-DE","de-AT","de-CH","it-IT"],
  "entry_points": {"cli": "{{CLI_NAME}}", "api": "uvicorn ...", "mcp": "..."},
  "assumptions_logged": <n>,
  "proposed_additions": <n>,
  "next_steps": ["..."]
}
</final_answer>
```
