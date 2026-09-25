# v33 — Quotation Scope Extraction

Quotation automation now treats the PDF Description column as the customer's requested/billable scope of work, not as a place to copy the full email.

- Claude extracts concise requested deliverables into separate quotation rows.
- Greetings, background narrative, deadlines, quote-validity/GST/cost-breakdown instructions and signatures are excluded from Description.
- If AI extraction is unavailable, a conservative local scope parser looks for Scope of Work/Services and task-like bullet lines instead of dumping the whole email.
- Existing v31/v32 AI drafts are automatically re-extracted once because v33 stores `extraction_version: 3`.
- Human-edited quotation drafts are never overwritten by later automation.
