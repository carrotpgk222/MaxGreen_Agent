import { getEmails, saveEmails } from '../core/storage.js'
import { getQuotationDraft } from '../core/quotationStorage.js'
import { getDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { spawnDeliveryOrderFromCompletedQuotation } from '../core/deliveryOrderWorkflow.js'
import { spawnInvoiceFromCompletedDeliveryOrder } from '../core/invoiceWorkflow.js'
import { getInvoiceDraft } from '../core/invoiceStorage.js'
import { upsertReceivableFromCompletedInvoice } from '../core/receivableStorage.js'
import { splitCompletedInvoiceDo } from '../core/invoiceDoWorkflow.js'
import { getSoaDraft } from '../core/soaStorage.js'
import { money as soaMoney, displayDate as soaDisplayDate } from '../core/soaUtils.js'
import { createDefaultInvoice, createInvoiceItem } from '../core/invoiceUtils.js'
import { getCompanies } from '../core/customerStorage.js'
import { getQueryParam } from '../core/utils.js'
import { attachmentNames } from '../core/attachmentUtils.js'
import {
  createDefaultQuotation,
  createQuotationItem,
  displayDate,
  escapeHtml,
  formatMoney,
  lineAmount,
  quotationTaxLabel,
  quotationTotals,
  totalInWords
} from '../core/quotationUtils.js'
import {
  createDefaultDeliveryOrder,
  createDeliveryOrderItem
} from '../core/deliveryOrderUtils.js'

const id = getQueryParam('id')
const completedViewMode = document.body.dataset.viewMode === 'completed'
let emails = getEmails()
let email = emails.find(item => item.id === id)

if (!email) {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./pending.html">← Back to Pending</a><h1 class="page-title">Document not found</h1></main>'
  throw new Error('Pending document not found')
}

const $ = elementId => document.getElementById(elementId)
const quotationDraft = getQuotationDraft(id)
const deliveryOrderDraft = getDeliveryOrderDraft(id)
const invoiceDraft = getInvoiceDraft(id)
const isQuotation = email.category === 'Quotation' || Boolean(quotationDraft && email.category === 'Quotation')
const isDeliveryOrder = email.category === 'Delivery Order' || Boolean(deliveryOrderDraft && email.category === 'Delivery Order')
const isInvoice = email.category === 'Invoice'
const isInvoiceDo = email.category === 'Invoice & DO'
const isSoa = email.category === 'Statement of Account'
const isCompleted = email.status === 'Completed'

$('pending-file-name').textContent = email.fileName || `${email.category}.pdf`
$('pending-reference').textContent = isInvoiceDo ? [email.documentIds?.invoice, email.documentIds?.deliveryOrder].filter(Boolean).join(' + ') : (email.documentId || 'No reference')
$('pending-category').textContent = email.category

if (isCompleted) {
  $('view-context').textContent = 'COMPLETED'
  $('back-link').href = './completed.html'
  $('back-link').textContent = '← Back to Completed'
  $('pending-actions').hidden = !completedViewMode
  $('sent-summary').hidden = false
  const sentDate = email.sentAt ? new Date(email.sentAt).toLocaleString('en-SG') : 'previously'
  $('sent-summary-text').textContent = `Sent to ${email.sentTo || 'recipient'} on ${sentDate}.`
}

if (completedViewMode && !isCompleted) {
  $('view-context').textContent = 'DOCUMENT'
  $('pending-actions').hidden = true
}

function quotationState() {
  return {
    ...createDefaultQuotation(email),
    ...(quotationDraft || {}),
    documentId: email.documentId || quotationDraft?.documentId || '',
    items: (quotationDraft?.items?.length ? quotationDraft.items : [{}])
      .map((item, index) => createQuotationItem(item, index + 1))
  }
}

function deliveryOrderState() {
  return {
    ...createDefaultDeliveryOrder(email),
    ...(deliveryOrderDraft || {}),
    documentId: (isInvoiceDo ? email.documentIds?.deliveryOrder : email.documentId) || deliveryOrderDraft?.documentId || '',
    deliveryOrderNumber: deliveryOrderDraft?.deliveryOrderNumber || (isInvoiceDo ? email.documentIds?.deliveryOrder : email.documentId) || '',
    items: (deliveryOrderDraft?.items?.length ? deliveryOrderDraft.items : [{}])
      .map((item, index) => createDeliveryOrderItem(item, index + 1))
  }
}

function customerDetails(document) {
  const companies = getCompanies()
  const company = companies.find(item =>
    (document.companyId && item.id === document.companyId) ||
    item.companyName?.trim().toLowerCase() === document.company?.trim().toLowerCase()
  )
  const contact = company?.contacts?.find(item => item.name === document.attn)
    || company?.contacts?.[0]
    || null

  return {
    address: document.customerAddress || contact?.address || '',
    postal: document.customerPostal || contact?.postal || ''
  }
}

function renderQuotation() {
  const quotation = quotationState()
  const customer = customerDetails(quotation)
  const { subtotal, gst, total } = quotationTotals(quotation.items)

  $('quotation-document').hidden = false
  $('preview-company').textContent = quotation.company || 'Customer / Company'
  $('preview-address').textContent = customer.address
  $('preview-postal').textContent = customer.postal ? `Singapore ${customer.postal}` : ''
  $('preview-attn').textContent = quotation.attn ? `Attn: ${quotation.attn}` : ''
  $('preview-number').textContent = `: ${quotation.quotationNumber || quotation.documentId || ''}`
  $('preview-date').textContent = `: ${displayDate(quotation.issueDate)}`
  $('preview-ref').textContent = `: ${quotation.documentId || quotation.quotationNumber || email.documentId || ''}`
  $('preview-external-ref').textContent = `: ${quotation.externalReference || email.externalReference || ''}`
  $('preview-subject').textContent = (quotation.subjectTitle || 'QUOTATION SUBJECT').toUpperCase()
  $('preview-amount-words').textContent = totalInWords(total)
  $('preview-subtotal').textContent = formatMoney(subtotal)
  $('preview-tax-label').textContent = quotationTaxLabel(quotation.items, 'pdf')
  $('preview-gst').textContent = formatMoney(gst)
  $('preview-total').textContent = formatMoney(total)

  const rows = quotation.items.map((item, index) => `
    <tr class="paper-data-row">
      <td>${escapeHtml(item.item || String(index + 1))}</td>
      <td>${escapeHtml(item.description).replace(/\n/g, '<br>')}</td>
      <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
      <td>${formatMoney(item.unitPrice)}</td>
      <td>${formatMoney(lineAmount(item))}</td>
    </tr>
  `).join('')

  $('preview-items').innerHTML = `${rows}
    <tr class="paper-spacer-row" aria-hidden="true">
      <td></td><td></td><td></td><td></td><td></td>
    </tr>`
}

function renderDeliveryOrder() {
  const deliveryOrder = deliveryOrderState()
  const customer = customerDetails(deliveryOrder)

  $('delivery-order-document').hidden = false
  $('do-preview-company').textContent = deliveryOrder.company || 'Customer / Company'
  $('do-preview-address').textContent = customer.address
  $('do-preview-postal').textContent = customer.postal ? `Singapore ${customer.postal}` : ''
  $('do-preview-attn').textContent = deliveryOrder.attn ? `Attn: ${deliveryOrder.attn}` : ''
  $('do-preview-number').textContent = `: ${deliveryOrder.deliveryOrderNumber || deliveryOrder.documentId || ''}`
  $('do-preview-date').textContent = `: ${displayDate(deliveryOrder.issueDate)}`
  $('do-preview-reference').textContent = `: ${deliveryOrder.documentId || deliveryOrder.deliveryOrderNumber || email.documentId || ''}`
  $('do-preview-external-reference').textContent = `: ${deliveryOrder.refQuoteDocumentId || deliveryOrder.externalReference || ''}`
  $('do-preview-staff').textContent = `: ${deliveryOrder.staff || ''}`
  $('do-preview-terms').textContent = `: ${deliveryOrder.terms || ''}`
  $('do-preview-job').textContent = `: ${deliveryOrder.job || ''}`
  $('do-preview-subject').textContent = deliveryOrder.subjectTitle || 'DELIVERY ORDER SUBJECT'

  const rows = deliveryOrder.items.map((item, index) => `
      <tr class="delivery-data-row">
        <td>${escapeHtml(item.item || String(index + 1))}</td>
        <td>${escapeHtml(item.description).replace(/\n/g, '<br>')}</td>
        <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
      </tr>
    `).join('')

  const refRow = deliveryOrder.refQuoteDocumentId
    ? `<tr class="delivery-ref-row"><td></td><td><strong>${escapeHtml(deliveryOrder.refQuoteDocumentId)}</strong></td><td></td></tr>`
    : ''

  $('do-preview-items').innerHTML = `${rows}${refRow}<tr class="delivery-spacer-row" aria-hidden="true"><td></td><td></td><td></td></tr>`
}

function invoiceState() {
  const base = createDefaultInvoice(email)
  return {
    ...base,
    ...(invoiceDraft || {}),
    documentId: (isInvoiceDo ? email.documentIds?.invoice : email.documentId) || invoiceDraft?.documentId || '',
    invoiceNumber: (isInvoiceDo ? email.documentIds?.invoice : email.documentId) || invoiceDraft?.invoiceNumber || '',
    items: (invoiceDraft?.items?.length ? invoiceDraft.items : [{}]).map((item, index) => createInvoiceItem(item, index + 1)),
    terms: ''
  }
}

function renderInvoice() {
  const invoice = invoiceState()
  $('invoice-document').hidden = false
  $('inv-preview-company').textContent = invoice.company || 'Customer / Company'
  $('inv-preview-address').textContent = invoice.customerAddress || ''
  $('inv-preview-postal').textContent = invoice.customerPostal ? `Singapore ${invoice.customerPostal}` : ''
  $('inv-preview-attn').textContent = invoice.attn ? `Attn: ${invoice.attn}` : ''
  $('inv-preview-number').textContent = `: ${invoice.invoiceNumber || invoice.documentId || ''}`
  $('inv-preview-date').textContent = `: ${displayDate(invoice.issueDate)}`
  $('inv-preview-reference').textContent = `: ${invoice.refQuoteDocumentId || invoice.reference || ''}`
  $('inv-preview-external-reference').textContent = `: ${invoice.externalDeliveryOrderId || invoice.externalReference || ''}`
  $('inv-preview-staff').textContent = `: ${invoice.staff || ''}`
  $('inv-preview-terms').textContent = `: ${invoice.terms || ''}`
  $('inv-preview-job').textContent = `: ${invoice.job || ''}`
  $('inv-preview-subject').textContent = invoice.subjectTitle || 'INVOICE SUBJECT'

  const rows = invoice.items.map((item, index) => `
    <tr class="invoice-data-row">
      <td>${escapeHtml(item.item || String(index + 1))}</td>
      <td>${escapeHtml(item.description || '').replace(/\n/g, '<br>')}</td>
      <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
      <td>${formatMoney(item.unitPrice)}</td>
      <td>${formatMoney(lineAmount(item))}</td>
    </tr>
  `).join('')

  $('inv-preview-items').innerHTML = `${rows}<tr class="invoice-spacer-row" aria-hidden="true"><td></td><td></td><td></td><td></td><td></td></tr>`
  $('pending-invoice-paynow').src = invoice.paynowQrDataUrl || './assets/images/paynow-qr.png'
  const totals = quotationTotals(invoice.items)
  $('inv-preview-subtotal').textContent = formatMoney(totals.subtotal)
  $('inv-preview-gst').textContent = formatMoney(totals.gst)
  $('inv-preview-total').textContent = formatMoney(totals.total)
  $('inv-preview-tax-label').textContent = quotationTaxLabel(invoice.items, 'paper')
  $('inv-preview-amount-words').textContent = totalInWords(totals.total)
}

function renderGeneric() {
  $('generic-document').hidden = false
  $('generic-title').textContent = email.fileName || `${email.category}.pdf`
  $('generic-from').textContent = email.from
  $('generic-subject').textContent = email.subject
  $('generic-reference').textContent = email.documentId || '—'
  $('generic-category').textContent = email.category
}

function renderSoa() {
  const draft = getSoaDraft(id)
  if (!draft) { renderGeneric(); return }
  $('soa-document').hidden = false
  $('soa-preview-to').textContent = draft.company || 'Customer'
  $('soa-preview-date').textContent = soaDisplayDate(draft.toDate)
  $('soa-preview-currency').textContent = draft.currency || 'SGD'
  $('soa-preview-rows').innerHTML = draft.transactions.map(row => `<tr><td></td><td>${escapeHtml(soaDisplayDate(row.date))}</td><td>${escapeHtml(row.document)}</td><td>${soaMoney(row.debit)}</td><td>${soaMoney(row.credit)}</td><td>${soaMoney(row.balance)}</td></tr>`).join('')
  $('soa-preview-balance').textContent = soaMoney(draft.balance)
  const a=draft.ageing||{}
  $('soa-age-current').textContent=soaMoney(a.current); $('soa-age-1-30').textContent=soaMoney(a.d1_30); $('soa-age-31-60').textContent=soaMoney(a.d31_60); $('soa-age-61-90').textContent=soaMoney(a.d61_90); $('soa-age-91-120').textContent=soaMoney(a.d91_120); $('soa-age-over-120').textContent=soaMoney(a.over120); $('soa-age-total').textContent=soaMoney(draft.balance)
}

if (isQuotation) renderQuotation()
else if (isDeliveryOrder) renderDeliveryOrder()
else if (isInvoice) renderInvoice()
else if (isInvoiceDo) { renderInvoice(); renderDeliveryOrder() }
else if (isSoa) renderSoa()
else renderGeneric()

function extractEmailAddress(value = '') {
  const bracketMatch = String(value).match(/<([^>]+)>/)
  if (bracketMatch) return bracketMatch[1].trim()
  const plainMatch = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return plainMatch ? plainMatch[0] : ''
}

function emailAttachments() {
  const generatedFiles = isInvoiceDo
    ? [email.documentIds?.invoice, email.documentIds?.deliveryOrder].filter(Boolean).map(reference => `${reference}.pdf`)
    : [email.fileName || `${email.category}.pdf`]
  const savedFiles = isQuotation
    ? attachmentNames(quotationDraft?.attachments || [])
    : isDeliveryOrder
      ? attachmentNames(deliveryOrderDraft?.attachments || [])
      : isInvoice
        ? attachmentNames(invoiceDraft?.attachments || [])
        : isInvoiceDo
          ? [...attachmentNames(invoiceDraft?.attachments || []), ...attachmentNames(deliveryOrderDraft?.attachments || [])]
          : []
  return [...generatedFiles, ...savedFiles.filter(file => file && !generatedFiles.includes(file))]
}

function defaultEmailSubject() {
  if (isQuotation) {
    const quotation = quotationState()
    return `Quotation - ${quotation.subjectTitle || email.subject}`
  }
  if (isDeliveryOrder) {
    const deliveryOrder = deliveryOrderState()
    return `Delivery Order - ${deliveryOrder.subjectTitle || email.subject}`
  }
  if (isInvoice) {
    const invoice = invoiceState()
    return `Tax Invoice - ${invoice.subjectTitle || email.subject}`
  }
  if (isInvoiceDo) {
    const invoice = invoiceState()
    return `Invoice & Delivery Order - ${invoice.subjectTitle || email.subject}`
  }
  return `${email.category} - ${email.subject}`
}

function openEmailModal() {
  $('email-to').value = extractEmailAddress(email.from)
  $('email-subject').value = defaultEmailSubject()
  $('email-message').value = `Dear Sir/Madam,\n\nPlease find attached the ${email.category.toLowerCase()} for your reference.\n\nThank you.\n\nBest regards,\nMaxGreen Contractor Pte Ltd`
  $('email-attachment-list').innerHTML = emailAttachments()
    .map(file => `<span class="email-attachment-chip">📎 ${escapeHtml(file)}</span>`)
    .join('')
  $('email-modal').hidden = false
  document.body.classList.add('modal-open')
}

function closeEmailModal() {
  $('email-modal').hidden = true
  document.body.classList.remove('modal-open')
}

if (!isCompleted && !completedViewMode) {
  $('revert-inbox').addEventListener('click', () => {
    emails = getEmails()
    email = emails.find(item => item.id === id)
    if (!email) return

    email.status = 'To Be Reviewed'
    email.section = 'inbox'
    email.revertedAt = new Date().toISOString()
    delete email.pendingAt
    saveEmails(emails)
    window.location.href = './inbox.html'
  })

  $('open-email').addEventListener('click', openEmailModal)
  document.querySelectorAll('[data-close-email]').forEach(button => {
    button.addEventListener('click', closeEmailModal)
  })

  $('email-form').addEventListener('submit', event => {
    event.preventDefault()
    const to = $('email-to').value.trim()
    const subject = $('email-subject').value.trim()
    if (!to || !subject) return

    emails = getEmails()
    email = emails.find(item => item.id === id)
    if (!email) return

    const sentAt = new Date().toISOString()
    const body = $('email-message').value

    if (email.category === 'Invoice & DO') {
      splitCompletedInvoiceDo(email.id, { to, subject, body, sentAt })
      closeEmailModal()
      window.location.href = './completed.html'
      return
    }

    email.status = 'Completed'
    email.sentAt = sentAt
    email.completedAt = sentAt
    email.sentTo = to
    email.sentSubject = subject
    email.sentBody = body
    email.sentAttachments = emailAttachments()
    saveEmails(emails)
    if (email.category === 'Invoice') upsertReceivableFromCompletedInvoice(email)

    // Completed workflow documents can create the next document task.
    if (email.category === 'Quotation') spawnDeliveryOrderFromCompletedQuotation(email.id)
    if (email.category === 'Delivery Order') spawnInvoiceFromCompletedDeliveryOrder(email.id)

    closeEmailModal()
    window.location.href = './completed.html'
  })
}

if (completedViewMode && isCompleted) {
  const deleteButton = $('delete-completed')
  if (deleteButton) {
    deleteButton.addEventListener('click', () => {
      const confirmed = window.confirm('Delete this completed document from the Completed list?')
      if (!confirmed) return

      emails = getEmails()
      const current = emails.find(item => item.id === id)
      if (!current) return

      current.deletedAt = new Date().toISOString()
      current.deletedFromCompleted = true
      saveEmails(emails)
      window.location.href = './completed.html'
    })
  }
}

