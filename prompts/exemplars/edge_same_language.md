---
id: edge_same_language
stages: [localization, validation]
---
**Edge case — the source is already in the target language**

English source, target `en-GB`:
- Operation `ADAPT_ONLY`: there is no translation step. The text you receive as `input_text` is the source. Apply only the locale's spelling, vocabulary, tone, format and market rules; return the text unchanged, with an empty `changes` list, when nothing applies.
- Operation `SKIP_IDENTICAL` (source locale equals target locale, e.g. en-GB → en-GB) never reaches a model: the text is copied and only deterministic checks run. The report notes `[EVIDENCE: detection p=0.98] Source already in target locale.`

How to act: never rewrite for style when no rule asks for it; fidelity to the source wording is the default.
