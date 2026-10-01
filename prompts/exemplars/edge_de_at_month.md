---
id: edge_de_at_month
stages: [localization, validation, repair]
---
**Edge case — German variants differ even in month names**

Source (nl-NL): "Beschikbaar vanaf januari 2027."
- `de-AT`: "Verfügbar ab Jänner 2027." — `[EVIDENCE: DEAT-MONTH-01]`.
- `de-DE` and `de-CH`: "Verfügbar ab Januar 2027."
- Written German dates carry a period after the day: "ab dem 30. September 2026" (not "30 September").

How to act: each German variant is produced directly from the source, never by converting another variant. In de-AT use "Jänner"; in de-DE never use it.
