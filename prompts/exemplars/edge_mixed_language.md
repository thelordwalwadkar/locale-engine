---
id: edge_mixed_language
stages: [translation, localization, validation]
---
**Edge case — a Dutch page with an English product-spec table**

Language is detected per segment and every segment carries its own `source_language`.
- Dutch segments are translated from Dutch; English segments are translated from English.
- A segment whose `source_language` already equals the target language is not translated (return it unchanged in the translation stage); localization may still adapt it to the locale.
- Never "correct" a segment's language, and never translate a brand name, product code or unit.

How to act: trust `source_language` per segment, not the language of the neighbouring segments.
