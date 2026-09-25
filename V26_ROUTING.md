# v26 — Claude Classification + Routing

Incoming Gmail categories are now restricted to:
- Quotation → Inbox
- Invoice & DO → Inbox
- Supplier Payable → Supplier Payable dashboard/page
- Others → Inbox

Delivery Order and Invoice are not incoming Gmail categories. They remain internal workflow documents generated from the normal quotation chain (Quotation sent → Delivery Order → Invoice).

Existing old AI categories such as Delivery Order, Invoice, and Statement of Account are reset to Unclassified at database startup so they can be reclassified with the v26 rules. Existing `Other` is migrated to `Others`.

Supplier Payable now reads real Claude-classified Gmail records from SQLite. It groups reminder emails, shows reminder count, calculates default priority (1–2 Low, 3–4 Medium, 5+ High), and keeps manual priority/status overrides in browser storage.
