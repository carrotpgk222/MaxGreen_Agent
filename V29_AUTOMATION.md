# v29 — Automatic AI preparation on Gmail sync

When **Sync Gmail** runs, newly synced records that are still `Unclassified` are now sent to Claude automatically (up to the configured safety cap).

Routing remains:
- Quotation → Inbox
- Invoice & DO → Inbox
- Supplier Payable → Supplier Payable
- Others → Inbox

For Quotation, Claude extracts supported fields from the source email and the browser prepares an editable quotation draft. Missing values are left for human review rather than invented.

For Invoice & DO, the PO is read for `Note to Supplier: Quote Ref: ...`. The detected Quote Ref is matched against completed quotations; when a match exists, the Invoice and Delivery Order drafts are prepared from that completed quotation.

Both review pages now show an **AI Prepared Draft** status panel. The user still reviews, edits, saves to Pending, approves, and sends.

Optional `.env` settings:

```env
GMAIL_AUTO_CLASSIFY=true
GMAIL_AUTO_CLASSIFY_LIMIT=25
```

The manual **Classify Unclassified** action remains as a recovery/retry option.
