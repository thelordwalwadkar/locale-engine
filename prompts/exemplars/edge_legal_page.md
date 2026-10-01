---
id: edge_legal_page
stages: [translation, validation]
---
**Edge case — a legal page (imprint, privacy statement, terms)**

Page classified `LEGAL` (for example the URL path contains `/privacyverklaring`): operation `TRANSLATE_ONLY`.
- Translate faithfully and completely. Keep every legal term, clause number, reference and defined term; never simplify, summarise, soften or add.
- There is no localization of legal substance. Only mechanical formats (separators, currency position, numeric dates) are adapted by code afterwards.
- Every output segment is flagged `requires_human_review: true`. The recommendations list the market's imprint and privacy requirements, each tagged `[HYPOTHESIS] — verify with counsel`.

How to act: when a legal sentence is ambiguous, translate the ambiguity rather than resolving it, and say so in your `thinking`.
