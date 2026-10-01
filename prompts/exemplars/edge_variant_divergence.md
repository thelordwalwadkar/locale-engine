---
id: edge_variant_divergence
stages: [localization, validation]
---
**Edge case — en-NL and en-GB are different outputs of the same source**

Source mentions "BTW" and a price "€ 1.250,00 excl. BTW".
- `en-NL`: "€1,250.00 excl. VAT (BTW)" — the Dutch reference stays on first mention; the amount stays in euro.
- `en-GB` with no GBP pricing in market_facts: "€1,250.00 excl. VAT" — the amount is retained in euro and never converted; no "(BTW)". Add the recommendation `[HYPOTHESIS] UK buyers expect GBP pricing — confirm currency policy.`

How to act: the two variants share a language but not a market. Apply each locale's own rules (separator style, "(BTW)" on first mention for en-NL, UK tone for en-GB) and never invent a converted price.
