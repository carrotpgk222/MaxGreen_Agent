# MaxGreen Agent — Live Server Prototype (v21)

Run `index.html` with **Live Server by Ritwick Dey**. No npm/Vite is required.

## v21 highlights

- Invoice & DO is now a real combined workflow page (`invoice-do.html`).
- A Purchase Order classified as **Invoice & DO** can carry one or more completed quotation references.
- The combined page shows a Tax Invoice and Delivery Order separately on the same page.
- Each generated PDF has its own Edit action and reuses the existing Construction Invoice / Construction Delivery Order editors.
- Saving to Pending keeps the item as **Invoice & DO**.
- Sending the Pending bundle splits it into two Completed records: **Invoice** and **Delivery Order**. Completed never shows an Invoice & DO category.
- The completed Invoice is automatically added to Customer Receivable.
- Purchase Order mock attachments open in a new tab and show the detected `Note to Supplier: Quote Ref: ...` reference(s).
- Demo data contains exactly:
  - 4 completed Quotations
  - 3 Invoice & DO inbox items
  - 2 Client companies
  - 2 Supplier companies
  - 2 Supplier Payable threads
  - Customer Receivable for 2 companies: 3 invoices for Alpha Engineering and 5 invoices for Harbour Client, with paid / part-paid / unpaid examples.

## Data

Clean seed data is stored in:

`assets/data/demo-data.json`

Browser changes are stored in `localStorage`. A new data version resets old prototype state once.

## v22 demo data correction
- Added 4 visible Quotation records to Inbox (`MGQ.2026.09.18.1` through `.4`).
- Kept the 4 completed quotations used as valid references for Invoice & DO / Delivery Order flows.
- Demo data version updated so Live Server resets stale browser data once.
