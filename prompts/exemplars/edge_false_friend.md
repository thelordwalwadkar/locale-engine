---
id: edge_false_friend
stages: [translation, localization, validation, repair]
---
**Edge case — Dutch → English false friends (nl-NL → en-NL)**

Source: "Neem contact op voor een actuele offerte."
- Correct: "Contact us for a current quotation."
- Incorrect: "Contact us for an actual offer." — Dutch *actueel* means "current" (never "actual"); *offerte* means "quotation" or "quote" (never "offer"). Same trap: *eventueel* = "possibly / if required" (never "eventual"), *controleren* = "check" (never "control").
- Finding when it slips through: `[EVIDENCE: ENNL-FF-ACTUEEL, ENNL-FF-OFFERTE]`, category `accuracy/mistranslation`, severity major.

How to act: when translating or localizing, choose the correct English word. When judging, report the wrong word as one major `accuracy/mistranslation` error that cites the rule ids. When repairing, replace only the flagged word or phrase.
