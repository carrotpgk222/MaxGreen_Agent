# v31 – Quotation Prefill Persistence Fix

This version fixes a stale-draft regression where older Gmail quotation records already had a blank local quotation draft. The Gmail automation previously returned early when any draft existed, so the PDF stayed empty even though the source email was available.

Changes:
- Automation now fills only blank fields in an existing, untouched quotation draft.
- A default/empty item row no longer blocks the source-email description from being inserted.
- If Claude returns no structured quotation fields, the real email subject becomes the quotation subject and the real email body becomes an editable first description instead of leaving the PDF blank.
- Once the user saves from the quotation editor, the draft is marked `humanEdited` and later AI/Gmail syncs do not overwrite the user's corrections.
- The review status now reports what is actually present in the PDF draft, including a safe source-email fallback.
- Direct refresh/open of `quotation.html` also self-heals an old blank Gmail quotation draft.
