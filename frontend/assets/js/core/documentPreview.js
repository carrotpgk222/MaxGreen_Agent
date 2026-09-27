import { getQuotationDraft } from './quotationStorage.js'
import { getDeliveryOrderDraft } from './deliveryOrderStorage.js'
import { getInvoiceDraft } from './invoiceStorage.js'
import { getSoaDraft } from './soaStorage.js'
import { getCompanies } from './customerStorage.js'
import {
  createQuotationItem,
  createDefaultQuotation,
  displayDate,
  escapeHtml,
  formatMoney,
  lineAmount,
  quotationTaxLabel,
  quotationTotals,
  totalInWords
} from './quotationUtils.js'
import { createDeliveryOrderItem, createDefaultDeliveryOrder } from './deliveryOrderUtils.js'
import { createInvoiceItem, createDefaultInvoice } from './invoiceUtils.js'
import { buildSoa, money as soaMoney } from './soaUtils.js'

const COMPANY_BLOCK = `
  <div>
    <h2>MAXGREEN CONTRACTOR PTE LTD</h2>
    <p>
      71 Woodlands Ave 10 #06-18
      Woodlands Industrial Xchange
      Singapore 737743
    </p>
    <p>
      Tel/Fax: 69097551/7552
      &nbsp; HP: 91998892
      &nbsp; Email: green_01kat@yahoo.com
    </p>
    <p>
      Co Reg No./ GST Reg. No:
      200915795C
    </p>
  </div>
`

const GENERATED_NOTE =
  '<span class="computer-generated-note">This is a computer generated document, no signature is required.</span>'

const META_ROWS = [
  ['No.', 'number'],
  ['Date', 'date'],
  ['Ref.', 'ref'],
  ['External Ref.', 'externalRef'],
  ['Staff', 'staff'],
  ['Terms', 'terms'],
  ['Job', 'job']
]

function value(text) {
  const safe = escapeHtml(text == null ? '' : text)
  return safe || ':'
}

function companyDetails(document = {}) {
  const companies = getCompanies()
  const id = document.companyId
  const name = document.company || ''
  const match = companies.find(item => item.id === id)
    || companies.find(item => item.name === name)
  const address = document.customerAddress || (match && match.billingAddress) || ''
  const postal = document.customerPostal || (match && match.billingPostal) || ''
  return {
    name: name || (match && match.name) || '',
    address,
    postal,
    attn: document.attn || (match && match.billingAttn) || ''
  }
}

function addressBlock(details) {
  return `
    <strong>${escapeHtml(details.name || 'Customer / Company')}</strong>
    ${details.address ? `<span>${escapeHtml(details.address)}</span>` : ''}
    ${details.postal ? `<span>${escapeHtml(details.postal)}</span>` : ''}
    ${details.attn ? `<span>Attn: ${escapeHtml(details.attn)}</span>` : ''}
  `
}

function metaList(prefix, fields) {
  return `
    <dl class="${prefix}-meta">
      ${META_ROWS.map(([label, key]) => `
        <div>
          <dt>${label}</dt>
          <dd>${value(fields[key])}</dd>
        </div>
      `).join('')}
    </dl>
  `
}

function quotationFields(state) {
  return {
    number: state.quotationNumber,
    date: displayDate(state.issueDate),
    ref: state.externalReference,
    externalRef: '',
    staff: '',
    terms: '',
    job: ''
  }
}

function deliveryFields(state) {
  return {
    number: state.deliveryOrderNumber,
    date: displayDate(state.issueDate),
    ref: state.reference,
    externalRef: state.externalReference,
    staff: state.staff,
    terms: state.terms,
    job: state.job
  }
}

function invoiceFields(state) {
  return {
    number: state.invoiceNumber,
    date: displayDate(state.issueDate),
    ref: state.reference,
    externalRef: state.externalReference,
    staff: state.staff,
    terms: state.terms,
    job: state.job
  }
}

function quotationState(email) {
  const draft = getQuotationDraft(email.id)
  return {
    ...createDefaultQuotation(email),
    ...(draft || {}),
    documentId: email.documentId || (draft && draft.documentId) || '',
    items: ((draft && draft.items) || []).length
      ? draft.items.map((item, index) => createQuotationItem(item, index + 1))
      : [createQuotationItem({}, 1)]
  }
}

function deliveryOrderState(email) {
  const draft = getDeliveryOrderDraft(email.id)
  return {
    ...createDefaultDeliveryOrder(email),
    ...(draft || {}),
    documentId: email.documentId || (draft && draft.documentId) || '',
    items: ((draft && draft.items) || []).length
      ? draft.items.map((item, index) => createDeliveryOrderItem(item, index + 1))
      : [createDeliveryOrderItem({}, 1)]
  }
}

function invoiceState(email) {
  const draft = getInvoiceDraft(email.id)
  return {
    ...createDefaultInvoice(email),
    ...(draft || {}),
    documentId: email.documentId || (draft && draft.documentId) || '',
    items: ((draft && draft.items) || []).length
      ? draft.items.map((item, index) => createInvoiceItem(item, index + 1))
      : [createInvoiceItem({}, 1)]
  }
}

function soaState(email) {
  const draft = getSoaDraft(email.id) || {}
  return {
    ...buildSoa(draft.companyId || '', draft.company || '', draft.fromDate || '', draft.toDate || ''),
    ...draft
  }
}

function quotationHtml(email) {
  const state = quotationState(email)
  const details = companyDetails(state)
  const totals = quotationTotals(state.items)

  return `
    <section class="quotation-pdf-shell">
      <article class="quotation-paper">
        <header class="paper-header">
          ${COMPANY_BLOCK}
          <div class="paper-register">
            <img src="./assets/images/bizsafe-logo.png" alt="Registered with bizSAFE" />
          </div>
        </header>

        <div class="paper-title-row">
          <h3>Quotation</h3>
        </div>

        <section class="paper-info-row">
          <div class="paper-customer">${addressBlock(details)}</div>
          ${metaList('paper', quotationFields(state))}
        </section>

        <h4>${escapeHtml(state.subjectTitle || 'QUOTATION SUBJECT')}</h4>

        <table class="paper-table">
          <thead>
            <tr>
              <th>SNo</th>
              <th>Description</th>
              <th>Quantity</th>
              <th>Unit Price</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${state.items.map(item => `
              <tr>
                <td>${escapeHtml(item.item)}</td>
                <td>${escapeHtml(item.description)}</td>
                <td>${escapeHtml(item.qty)}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
                <td>${formatMoney(item.unitPrice)}</td>
                <td>${formatMoney(lineAmount(item))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <section class="paper-total-row">
          <div>${escapeHtml(totalInWords(totals.total))}</div>
          <div class="paper-totals">
            <div><span>Amt S$</span><strong>${formatMoney(totals.subtotal)}</strong></div>
            <div>
              <span>${escapeHtml(quotationTaxLabel(state.items, 'pdf'))}</span>
              <strong>${formatMoney(totals.gst)}</strong>
            </div>
            <div><span>Total S$</span><strong>${formatMoney(totals.total)}</strong></div>
          </div>
        </section>

        <footer class="paper-footer paper-footer-generated">
          <span>Page 1 of 1 - E. &amp; O.E.</span>
          ${GENERATED_NOTE}
        </footer>
      </article>
    </section>
  `
}

function deliveryOrderHtml(email) {
  const state = deliveryOrderState(email)
  const details = companyDetails(state)

  return `
    <section class="delivery-pdf-shell">
      <article class="delivery-paper">
        <header class="delivery-paper-header">
          ${COMPANY_BLOCK}
          <div class="delivery-register">
            <img src="./assets/images/bizsafe-logo.png" alt="Registered with bizSAFE" />
          </div>
        </header>

        <div class="delivery-title-row">
          <h3>Delivery Order</h3>
        </div>

        <section class="delivery-info-row">
          <div class="delivery-customer">${addressBlock(details)}</div>
          ${metaList('delivery', deliveryFields(state))}
        </section>

        <h4>${escapeHtml(state.subjectTitle || 'DELIVERY ORDER SUBJECT')}</h4>

        <table class="delivery-table">
          <thead>
            <tr>
              <th>SNo</th>
              <th>Description</th>
              <th>Quantity</th>
            </tr>
          </thead>
          <tbody>
            ${state.items.map(item => `
              <tr>
                <td>${escapeHtml(item.item)}</td>
                <td>${escapeHtml(item.description)}</td>
                <td>${escapeHtml(item.qty)}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <footer class="delivery-footer delivery-footer-generated">
          <div class="delivery-page-mark">Page 1 of 1 - E. &amp; O.E.</div>
          <div class="computer-generated-note">This is a computer generated document, no signature is required.</div>
        </footer>
      </article>
    </section>
  `
}

function invoiceHtml(email) {
  const state = invoiceState(email)
  const details = companyDetails(state)
  const totals = quotationTotals(state.items)

  return `
    <section class="invoice-pdf-shell">
      <article class="invoice-paper">
        <header class="invoice-paper-header">
          ${COMPANY_BLOCK}
          <div class="invoice-register">
            <img src="./assets/images/bizsafe-logo.png" alt="Registered with bizSAFE" />
          </div>
        </header>

        <div class="invoice-title-row">
          <h3>Tax Invoice</h3>
        </div>

        <section class="invoice-info-row">
          <div class="invoice-customer">${addressBlock(details)}</div>
          ${metaList('invoice', invoiceFields(state))}
        </section>

        <h4>${escapeHtml(state.subjectTitle || 'INVOICE SUBJECT')}</h4>

        <table class="invoice-table">
          <thead>
            <tr>
              <th>SNo</th>
              <th>Description</th>
              <th>Quantity</th>
              <th>Unit Price</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${state.items.map(item => `
              <tr>
                <td>${escapeHtml(item.item)}</td>
                <td>${escapeHtml(item.description)}</td>
                <td>${escapeHtml(item.qty)}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
                <td>${formatMoney(item.unitPrice)}</td>
                <td>${formatMoney(lineAmount(item))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <section class="invoice-total-row">
          <div>${escapeHtml(totalInWords(totals.total))}</div>
          <div class="invoice-totals">
            <div><span>Amt S$</span><strong>${formatMoney(totals.subtotal)}</strong></div>
            <div>
              <span>${escapeHtml(quotationTaxLabel(state.items, 'pdf'))}</span>
              <strong>${formatMoney(totals.gst)}</strong>
            </div>
            <div><span>Total S$</span><strong>${formatMoney(totals.total)}</strong></div>
          </div>
        </section>

        <section class="invoice-payment">
          <div>
            <strong>MODE OF PAYMENT :</strong>
            <p>Bank Transfer to DBS Current : 066-9036370</p>
            <p>PAYNOW UEN : 200915795C &nbsp; PAYNOW QR</p>
            <p>Cheque payable to: <br />MAXGREEN CONTRACTOR PTE LTD</p>
          </div>
          <img src="./assets/images/paynow-qr.png" alt="PayNow QR" />
        </section>

        <footer class="invoice-footer">
          <span>Page 1 of 1 - E. &amp; O.E.</span>
          <span>This is a computer generated document, no signature is required.</span>
        </footer>
      </article>
    </section>
  `
}

function soaHtml(email) {
  const state = soaState(email)
  const ageing = state.ageing || {}
  const buckets = [
    ['current', 'Current'],
    ['d1_30', '1 - 30 Days'],
    ['d31_60', '31 - 60 Days'],
    ['d61_90', '61 - 90 Days'],
    ['d91_120', '91 - 120 Days'],
    ['over120', '> 120 Days']
  ]

  return `
    <section class="soa-pdf-shell">
      <article class="soa-paper">
        <header class="soa-paper-header">
          ${COMPANY_BLOCK}
          <img src="./assets/images/bizsafe-logo.png" alt="Registered with bizSAFE" />
        </header>

        <div class="soa-title">Statement of Account</div>

        <section class="soa-head">
          <div class="soa-to-line">To :<strong>${escapeHtml(state.company || '')}</strong></div>
          <div class="soa-head-meta">
            <div>Date :<span>${escapeHtml(state.fromDate ? displayDate(state.fromDate) : '')}</span></div>
            <div>Currency :<span>${escapeHtml(state.currency || 'SGD')}</span></div>
          </div>
        </section>

        <table class="soa-table">
          <thead>
            <tr>
              <th class="soa-marker-col"></th>
              <th>Date</th>
              <th>Document</th>
              <th>Debit</th>
              <th>Credit</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
            ${(state.transactions || []).map(row => `
              <tr>
                <td></td>
                <td>${escapeHtml(row.date || '')}</td>
                <td>${escapeHtml(row.document || '')}</td>
                <td>${row.debit ? soaMoney(row.debit) : ''}</td>
                <td>${row.credit ? soaMoney(row.credit) : ''}</td>
                <td>${soaMoney(row.balance || 0)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">Balance C/F :</td>
              <td>${soaMoney(state.balance || 0)}</td>
            </tr>
          </tfoot>
        </table>

        <div class="soa-ageing-title">Ageing Analysis :</div>

        <table class="soa-ageing">
          <thead>
            <tr>
              ${buckets.map(([, label]) => `<th>${label.replace('>', '&gt;')}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr>${buckets.map(([key]) => `<td>${soaMoney(ageing[key] || 0)}</td>`).join('')}</tr>
            <tr class="soa-ageing-total">
              <td colspan="6">${soaMoney(state.balance || 0)}</td>
            </tr>
          </tbody>
        </table>

        <footer class="soa-footer">
          <span>E. &amp; O.E.</span>
          <span>This is a computer generated document, no signature is required.</span>
        </footer>
      </article>
    </section>
  `
}

function genericHtml(email) {
  const rows = [
    ['From', email.from],
    ['Category', email.category],
    ['Reference', email.documentId || email.externalReference],
    ['Received', email.receivedDate]
  ].filter(([, text]) => text)

  return `
    <section class="generic-pending-preview">
      <div class="pending-preview-generic">
        <h3>${escapeHtml(email.subject || email.category || 'Document')}</h3>

        <dl>
          ${rows.map(([label, text]) => `
            <dt>${label}</dt>
            <dd>${escapeHtml(text)}</dd>
          `).join('')}
        </dl>

        <p class="pending-preview-note">
          This file has no saved document layout. Open it to review the details and send it.
        </p>
      </div>
    </section>
  `
}

function categoryKey(email) {
  const value = `${email?.originalCategory || ''} ${email?.category || ''}`.toLowerCase()
  if (value.includes('invoice & do') || value.includes('invoice and do')) return 'invoice-do'
  if (value.includes('invoice')) return 'invoice'
  if (value.includes('delivery')) return 'delivery'
  if (value.includes('statement') || value.includes('soa')) return 'soa'
  if (value.includes('quotation')) return 'quotation'
  return 'generic'
}

export function documentPreviewHtml(email) {
  if (!email || !email.id) return ''

  switch (categoryKey(email)) {
    case 'quotation':
      return quotationHtml(email)
    case 'delivery':
      return deliveryOrderHtml(email)
    case 'invoice':
    case 'invoice-do':
      return invoiceHtml(email)
    case 'soa':
      return soaHtml(email)
    default:
      return genericHtml(email)
  }
}
