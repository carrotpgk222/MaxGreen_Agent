# v27 — Restore document review + collapsible Gmail body

Fixes the regression introduced when the real Gmail Inbox was connected.

- Quotation Inbox rows now open the existing Quotation review page again.
- Invoice & DO Inbox rows now open the combined Invoice & DO review page again.
- Existing Edit / Edit Invoice / Edit Delivery Order and Save to Pending controls are preserved.
- Real Gmail records are mirrored into the existing workflow store before navigation so the older document editor/PDF flow can use them.
- Gmail attachments remain real backend attachment links.
- Email body is collapsed by default and can be shown/hidden.
- Others continue to use the generic Gmail message viewer, also with a collapsible body.
