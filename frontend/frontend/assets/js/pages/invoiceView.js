import { inboxCategories } from '../data/mockData.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { getInvoiceDraft, saveInvoiceDraft } from '../core/invoiceStorage.js'
import { getQueryParam } from '../core/utils.js'
import { changeWorkflowCategory } from '../core/workflowCategory.js'
import { renderAttachmentLinks } from '../core/attachmentUtils.js'
import { createDefaultInvoice, createInvoiceItem, displayDate, escapeHtml, invoiceFromDeliveryOrder } from '../core/invoiceUtils.js'
import { getDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { getQuotationDraft } from '../core/quotationStorage.js'
import { formatMoney, lineAmount, quotationTaxLabel, quotationTotals, totalInWords } from '../core/quotationUtils.js'

const emailId = getQueryParam('id')
let emails = getEmails()
let email = emails.find(item => item.id === emailId)

if (!email || email.category !== 'Invoice') {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1>Invoice not found</h1></main>'
  throw new Error('Invoice not found')
}

const $ = id => document.getElementById(id)
let invoice

function loadInvoice() {
  let saved = getInvoiceDraft(emailId)

  // Recover the invoice from its completed Delivery Order/Quotation chain if a
  // browser reset or older demo state is missing the invoice draft.
  if (!saved && email.sourceDeliveryOrderEmailId) {
    const deliveryOrder = getDeliveryOrderDraft(email.sourceDeliveryOrderEmailId)
    const quotationEmailId = deliveryOrder?.sourceQuotationEmailId || email.sourceQuotationEmailId || ''
    const quotation = quotationEmailId ? getQuotationDraft(quotationEmailId) : null

    if (deliveryOrder) {
      saved = invoiceFromDeliveryOrder(email, deliveryOrder, quotation, {
        sourceDeliveryOrderEmailId: email.sourceDeliveryOrderEmailId,
        sourceQuotationEmailId: quotationEmailId,
        refQuoteDocumentId: email.refQuoteDocumentId || deliveryOrder.refQuoteDocumentId || quotation?.quotationNumber || '',
        externalDeliveryOrderId: email.externalReference || deliveryOrder.deliveryOrderNumber || deliveryOrder.documentId || '',
        documentId: email.documentId || '',
        invoiceNumber: email.documentId || ''
      })
      saveInvoiceDraft(emailId, saved)
    }
  }

  invoice = {
    ...createDefaultInvoice(email),
    ...(saved || {}),
    documentId: email.documentId || saved?.documentId || '',
    invoiceNumber: email.documentId || saved?.invoiceNumber || '',
    items: (saved?.items?.length ? saved.items : [{}]).map((item, index) => createInvoiceItem(item, index + 1)),
    terms: ''
  }
}

function renderInvoice() {
  $('invoice-file-name').textContent = 'Invoice.pdf'
  $('source-subject').textContent = email.subject
  $('source-from').textContent = email.from
  $('source-date').textContent = email.receivedDate
  $('source-body').textContent = email.body || ''
  $('source-attachments').innerHTML = renderAttachmentLinks(email.attachments || [])
  $('detected-category').textContent = email.originalCategory || 'Invoice'

  const select = $('category-select')
  select.innerHTML = inboxCategories
    .map(category => `<option value="${escapeHtml(category)}" ${category === email.category ? 'selected' : ''}>${escapeHtml(category)}</option>`)
    .join('')

  $('edit-invoice').href = `./invoice-edit.html?id=${encodeURIComponent(emailId)}`

  $('preview-company').textContent = invoice.company || 'Customer / Company'
  $('preview-address').textContent = invoice.customerAddress || ''
  $('preview-postal').textContent = invoice.customerPostal ? `Singapore ${invoice.customerPostal}` : ''
  $('preview-attn').textContent = invoice.attn ? `Attn: ${invoice.attn}` : ''
  $('preview-number').textContent = `: ${invoice.invoiceNumber || invoice.documentId || ''}`
  $('preview-date').textContent = `: ${displayDate(invoice.issueDate)}`
  $('preview-reference').textContent = `: ${invoice.refQuoteDocumentId || invoice.reference || ''}`
  $('preview-external-reference').textContent = `: ${invoice.externalDeliveryOrderId || invoice.externalReference || ''}`
  $('preview-staff').textContent = `: ${invoice.staff || ''}`
  $('preview-terms').textContent = `: ${invoice.terms || ''}`
  $('preview-job').textContent = `: ${invoice.job || ''}`
  $('preview-subject').textContent = invoice.subjectTitle || 'INVOICE SUBJECT'

  const rows = invoice.items.map((item, index) => `
    <tr class="invoice-data-row">
      <td>${escapeHtml(item.item || String(index + 1))}</td>
      <td>${escapeHtml(item.description || '').replace(/\n/g, '<br>')}</td>
      <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
      <td>${formatMoney(item.unitPrice)}</td>
      <td>${formatMoney(lineAmount(item))}</td>
    </tr>
  `).join('')

  $('preview-items').innerHTML = `${rows}<tr class="invoice-spacer-row" aria-hidden="true"><td></td><td></td><td></td><td></td><td></td></tr>`
  $('invoice-paynow-qr').src = invoice.paynowQrDataUrl || './assets/images/paynow-qr.png'

  const totals = quotationTotals(invoice.items)
  $('preview-subtotal').textContent = formatMoney(totals.subtotal)
  $('preview-gst').textContent = formatMoney(totals.gst)
  $('preview-total').textContent = formatMoney(totals.total)
  $('preview-tax-label').textContent = quotationTaxLabel(invoice.items, 'paper')
  $('preview-amount-words').textContent = totalInWords(totals.total)
}

$('category-select').addEventListener('change', () => {
  const changed = changeWorkflowCategory(emailId, $('category-select').value)
  if (changed?.route) window.location.href = changed.route
})

$('save-pending').addEventListener('click', () => {
  emails = getEmails()
  email = emails.find(item => item.id === emailId)
  if (!email) return

  email.status = 'Pending'
  email.reviewedAt = new Date().toISOString()
  email.pendingAt = new Date().toISOString()
  saveEmails(emails)

  $('review-toast').hidden = false
  window.setTimeout(() => {
    window.location.href = './pending.html'
  }, 500)
})

loadInvoice()
renderInvoice()
window.addEventListener('pageshow', () => {
  loadInvoice()
  renderInvoice()
})
