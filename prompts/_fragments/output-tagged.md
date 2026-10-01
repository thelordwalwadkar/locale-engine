Work in two parts.

1. `<thinking>` … `</thinking>` — short working notes (at most about eight lines): the glossary hits you will apply, the entities you must keep exactly, the rules that apply, your decisions about claims. No JSON in this part.
2. `<final_answer>` … `</final_answer>` — ONE JSON object and nothing else between the tags (no markdown fences, no comments). Write nothing after `</final_answer>`.

The JSON must match this JSON Schema exactly (every field is required, no extra fields):

```json
{{output_schema}}
```
