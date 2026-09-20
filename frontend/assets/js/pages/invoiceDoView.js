import { inboxCategories } from '../data/mockData.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { getInvoiceDraft } from '../core/invoiceStorage.js'
import { getDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { getQueryParam } from '../core/utils.js'
import { changeWorkflowCategory } from '../core/workflowCategory.js'
import { renderAttachmentLinks } from '../core/attachmentUtils.js'
import {
  createInvoiceItem,
  displayDate as invoiceDisplayDate,
  escapeHtml
} from '../core/invoiceUtils.js'
import {
  createDeliveryOrderItem,
  displayDate as deliveryDisplayDate
} from '../core/deliveryOrderUtils.js'
import {
  formatMoney,
  lineAmount,
  quotationTaxLabel,
  quotationTotals,
  totalInWords
} from '../core/quotationUtils.js'

const emailId = getQueryParam('id')
let emails = getEmails()
let email = emails.find(item => item.id === emailId)

if (!email || email.category !== 'Invoice & DO') {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1 class="page-title">Invoice & DO not found</h1></main>'
  throw new Error('Invoice & DO record not found')
}

const $ = id => document.getElementById(id)

function invoiceState() {
  const draft = getInvoiceDraft(emailId)
  const documentId = email.documentIds?.invoice || draft?.documentId || ''
  return {
    ...(draft || {}),
    documentId,
    invoiceNumber: documentId,
    items: (draft?.items?.length ? draft.items : [{}]).map((item, index) => createInvoiceItem(item, index + 1)),
    terms: ''
  }
}

function deliveryOrderState() {
  const draft = getDeliveryOrderDraft(emailId)
  const documentId = email.documentIds?.deliveryOrder || draft?.documentId || ''
  return {
    ...(draft || {}),
    documentId,
    deliveryOrderNumber: documentId,
    reference: documentId,
    items: (draft?.items?.length ? draft.items : [{}]).map((item, index) => createDeliveryOrderItem(item, index + 1))
  }
}

function renderInvoice() {
  const invoice = invoiceState()
  $('invoice-section-name').textContent = `${invoice.invoiceNumber || 'Invoice'}.pdf`
  $('inv-preview-company').textContent = invoice.company || 'Customer / Company'
  $('inv-preview-address').textContent = invoice.customerAddress || ''
  $('inv-preview-postal').textContent = invoice.customerPostal ? `Singapore ${invoice.customerPostal}` : ''
  $('inv-preview-attn').textContent = invoice.attn ? `Attn: ${invoice.attn}` : ''
  $('inv-preview-number').textContent = `: ${invoice.invoiceNumber || ''}`
  $('inv-preview-date').textContent = `: ${invoiceDisplayDate(invoice.issueDate)}`
  $('inv-preview-reference').textContent = `: ${invoice.refQuoteDocumentId || invoice.reference || ''}`
  $('inv-preview-external-reference').textContent = `: ${invoice.externalDeliveryOrderId || invoice.externalReference || ''}`
  $('inv-preview-staff').textContent = `: ${invoice.staff || ''}`
  $('inv-preview-terms').textContent = ':'
  $('inv-preview-job').textContent = `: ${invoice.job || ''}`
  $('inv-preview-subject').textContent = invoice.subjectTitle || 'INVOICE SUBJECT'
  $('inv-preview-items').innerHTML = invoice.items.map((item, index) => `
    <tr class="invoice-data-row">
      <td>${escapeHtml(item.item || String(index + 1))}</td>
      <td>${escapeHtml(item.description || '').replace(/\n/g, '<br>')}</td>
      <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
      <td>${formatMoney(item.unitPrice)}</td>
      <td>${formatMoney(lineAmount(item))}</td>
    </tr>
  `).join('') + '<tr class="invoice-spacer-row" aria-hidden="true"><td></td><td></td><td></td><td></td><td></td></tr>'

  const totals = quotationTotals(invoice.items)
  $('inv-preview-subtotal').textContent = formatMoney(totals.subtotal)
  $('inv-preview-gst').textContent = formatMoney(totals.gst)
  $('inv-preview-total').textContent = formatMoney(totals.total)
  $('inv-preview-tax-label').textContent = quotationTaxLabel(invoice.items, 'paper')
  $('inv-preview-amount-words').textContent = totalInWords(totals.total)
  $('invoice-paynow-qr').src = invoice.paynowQrDataUrl || './assets/images/paynow-qr.png'
}

function renderDeliveryOrder() {
  const deliveryOrder = deliveryOrderState()
  $('do-section-name').textContent = `${deliveryOrder.deliveryOrderNumber || 'Delivery Order'}.pdf`
  $('do-preview-company').textContent = deliveryOrder.company || 'Customer / Company'
  $('do-preview-address').textContent = deliveryOrder.customerAddress || ''
  $('do-preview-postal').textContent = deliveryOrder.customerPostal ? `Singapore ${deliveryOrder.customerPostal}` : ''
  $('do-preview-attn').textContent = deliveryOrder.attn ? `Attn: ${deliveryOrder.attn}` : ''
  $('do-preview-number').textContent = `: ${deliveryOrder.deliveryOrderNumber || ''}`
  $('do-preview-date').textContent = `: ${deliveryDisplayDate(deliveryOrder.issueDate)}`
  $('do-preview-reference').textContent = `: ${deliveryOrder.deliveryOrderNumber || deliveryOrder.documentId || ''}`
  $('do-preview-external-reference').textContent = `: ${deliveryOrder.refQuoteDocumentId || deliveryOrder.externalReference || ''}`
  $('do-preview-staff').textContent = `: ${deliveryOrder.staff || ''}`
  $('do-preview-terms').textContent = `: ${deliveryOrder.terms || ''}`
  $('do-preview-job').textContent = `: ${deliveryOrder.job || ''}`
  $('do-preview-subject').textContent = deliveryOrder.subjectTitle || 'DELIVERY ORDER SUBJECT'

  const rows = deliveryOrder.items.map((item, index) => `
    <tr class="delivery-data-row">
      <td>${escapeHtml(item.item || String(index + 1))}</td>
      <td>${escapeHtml(item.description || '').replace(/\n/g, '<br>')}</td>
      <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
    </tr>
  `).join('')

  const refRow = deliveryOrder.refQuoteDocumentId
    ? `<tr class="delivery-ref-row"><td></td><td><strong>${escapeHtml(deliveryOrder.refQuoteDocumentId)}</strong></td><td></td></tr>`
    : ''

  $('do-preview-items').innerHTML = `${rows}${refRow}<tr class="delivery-spacer-row" aria-hidden="true"><td></td><td></td><td></td></tr>`
}

const categorySelect = $('category-select')
categorySelect.innerHTML = inboxCategories
  .map(category => `<option value="${escapeHtml(category)}" ${category === email.category ? 'selected' : ''}>${escapeHtml(category)}</option>`)
  .join('')

$('source-subject').textContent = email.subject
$('source-from').textContent = email.from
$('source-date').textContent = email.receivedDate
$('source-body').textContent = email.body
$('source-attachments').innerHTML = renderAttachmentLinks(email.attachments || [])
$('detected-category').textContent = email.originalCategory
$('edit-invoice').href = `./invoice-edit.html?id=${encodeURIComponent(emailId)}&bundle=1`
$('edit-delivery-order').href = `./delivery-order-edit.html?id=${encodeURIComponent(emailId)}&bundle=1`

if (Array.isArray(email.purchaseOrderQuoteRefs) && email.purchaseOrderQuoteRefs.length) {
  $('po-quote-note').hidden = false
  $('po-quote-note').innerHTML = `<strong>Purchase Order note detected:</strong> Note to Supplier: Quote Ref: ${email.purchaseOrderQuoteRefs.map(escapeHtml).join(' / ')}`
}

categorySelect.addEventListener('change', () => {
  const changed = changeWorkflowCategory(emailId, categorySelect.value)
  if (changed?.route) window.location.href = changed.route
})

$('save-pending').addEventListener('click', () => {
  emails = getEmails()
  email = emails.find(item => item.id === emailId)
  if (!email) return
  email.status = 'Pending'
  email.section = 'inbox'
  email.reviewedAt = new Date().toISOString()
  email.pendingAt = new Date().toISOString()
  saveEmails(emails)

  const toast = $('review-toast')
  toast.hidden = false
  window.setTimeout(() => {
    window.location.href = './pending.html'
  }, 500)
})

function render() {
  renderInvoice()
  renderDeliveryOrder()
}

render()
window.addEventListener('pageshow', render)
