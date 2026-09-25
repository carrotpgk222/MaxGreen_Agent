# v32 — Reliable AI Quotation Extraction

## Problem fixed
The gateway sometimes returned a successful HTTP response whose Claude `message.content` was prose rather than a JSON object. The old combined classification + large extraction prompt then produced a 502 when a user pressed **View**.

## Changes
- Split AI work into smaller steps:
  1. category classification
  2. quotation field extraction only when category is Quotation
  3. supplier payment extraction only when needed
- Existing classified messages keep their category when View is only preparing a missing draft.
- JSON parsing now handles markdown fences, leading text, embedded JSON, encoded JSON strings, BOM/zero-width characters.
- Invalid JSON is retried once with a strict compact JSON instruction.
- Quotation extraction failure no longer blocks View. It falls back to the actual Gmail subject/body and remains fully editable.
- Invoice & DO Quote Ref extraction remains deterministic from `Quote Ref: MGQ...` text in the PO attachment.
- Human-edited drafts are still never overwritten by AI automation.
