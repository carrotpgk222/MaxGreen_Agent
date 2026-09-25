# v28 — AI document pre-fill and PO Quote Ref matching

## Quotation
For a Gmail message classified as `Quotation`, Claude now extracts supported quotation fields from the email/attachments. When the user presses **View**, the existing quotation PDF preview is pre-filled with the extracted company/contact/address, subject and requested line items. Missing values are left blank/zero rather than invented, and the existing **Edit** flow remains available for human review.

## Invoice & DO
For a Gmail message classified as `Invoice & DO`, the system reads attachment text and specifically looks for an explicit PO line such as:

`Note to Supplier: Quote Ref: MGQ.26/05/111`

A deterministic `Quote Ref:` extractor supplements Claude so this reference is not dependent on free-form LLM output alone. The browser then searches **Completed Quotations** for the matching quotation reference. If found, that completed quotation — not the PO line-item content — is used to pre-fill both the generated Delivery Order and Invoice.

If no completed quotation matches, the review page shows the detected Quote Ref and explains that the generated documents cannot be auto-filled until a matching completed quotation exists.

## Existing v27 records
Messages classified before v28 do not yet contain the new structured extraction. The first time the user presses **View** on an old Quotation or Invoice & DO record, the Inbox refreshes that one record through Claude, stores the new extraction in SQLite, then opens the normal review page.
