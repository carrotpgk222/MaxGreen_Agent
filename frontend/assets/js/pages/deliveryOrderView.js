import { inboxCategories } from '../data/mockData.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { getDeliveryOrderDraft, saveDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { getQuotationDraft } from '../core/quotationStorage.js'
import { getCompanies } from '../core/customerStorage.js'
import { getQueryParam } from '../core/utils.js'
import { changeWorkflowCategory } from '../core/workflowCategory.js'
import { renderAttachmentLinks } from '../core/attachmentUtils.js'
import {
  createDefaultDeliveryOrder,
  createDeliveryOrderItem,
  deliveryOrderFromQuotation,
  displayDate,
  escapeHtml
} from '../core/deliveryOrderUtils.js'

const emailId = getQueryParam('id')
let emails = getEmails()
let email = emails.find(item => item.id === emailId)

if (!email || email.category !== 'Delivery Order') {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1 class="page-title">Delivery Order not found</h1></main>'
  throw new Error('Delivery Order record not found')
}

const $ = id => document.getElementById(id)
let deliveryOrder = null

function ensureDraft() {
  let draft = getDeliveryOrderDraft(emailId)

  if (!draft && email.sourceQuotationEmailId) {
    const quotation = getQuotationDraft(email.sourceQuotationEmailId)
    if (quotation) {
      draft = deliveryOrderFromQuotation(email, quotation, {
        sourceQuotationEmailId: email.sourceQuotationEmailId,
        refQuoteDocumentId: quotation.quotationNumber || quotation.documentId || email.refQuoteDocumentId || ''
      })
      saveDeliveryOrderDraft(emailId, draft)
    }
  }

  return draft
}

function loadDeliveryOrder() {
  emails = getEmails()
  email = emails.find(item => item.id === emailId)
  const draft = ensureDraft()

  deliveryOrder = {
    ...createDefaultDeliveryOrder(email),
    ...(draft || {}),
    documentId: email?.documentId || draft?.documentId || '',
    deliveryOrderNumber: draft?.deliveryOrderNumber || email?.documentId || '',
    items: (draft?.items?.length ? draft.items : [{}]).map((item, index) => createDeliveryOrderItem(item, index + 1))
  }
}

const categorySelect = $('category-select')
categorySelect.innerHTML = inboxCategories
  .map(category => `<option value="${escapeHtml(category)}" ${category === email.category ? 'selected' : ''}>${escapeHtml(category)}</option>`)
  .join('')

$('source-subject').textContent = email.subject
$('source-from').textContent = email.from
$('source-date').textContent = email.receivedDate
$('source-body').textContent = email.body
$('detected-category').textContent = email.originalCategory
$('edit-delivery-order').href = `./delivery-order-edit.html?id=${encodeURIComponent(emailId)}`
$('delivery-file-name').textContent = email.fileName || `${email.documentId || 'Delivery Order'}.pdf`

$('source-attachments').innerHTML = renderAttachmentLinks(email.attachments || [])

function resolveCustomerDetails() {
  const companies = getCompanies()
  const company = companies.find(item =>
    (deliveryOrder.companyId && item.id === deliveryOrder.companyId) ||
    item.companyName?.trim().toLowerCase() === deliveryOrder.company?.trim().toLowerCase()
  )
  const contact = company?.contacts?.find(item => item.name === deliveryOrder.attn)
    || company?.contacts?.[0]
    || null

  return {
    address: deliveryOrder.customerAddress || contact?.address || '',
    postal: deliveryOrder.customerPostal || contact?.postal || ''
  }
}

function renderDeliveryOrder() {
  const customer = resolveCustomerDetails()

  $('preview-company').textContent = deliveryOrder.company || 'Customer / Company'
  $('preview-address').textContent = customer.address
  $('preview-postal').textContent = customer.postal ? `Singapore ${customer.postal}` : ''
  $('preview-attn').textContent = deliveryOrder.attn ? `Attn: ${deliveryOrder.attn}` : ''
  $('preview-number').textContent = `: ${deliveryOrder.deliveryOrderNumber || deliveryOrder.documentId || ''}`
  $('preview-date').textContent = `: ${displayDate(deliveryOrder.issueDate)}`
  $('preview-reference').textContent = `: ${deliveryOrder.documentId || deliveryOrder.deliveryOrderNumber || email.documentId || ''}`
  $('preview-external-reference').textContent = `: ${deliveryOrder.refQuoteDocumentId || deliveryOrder.externalReference || ''}`
  $('preview-staff').textContent = `: ${deliveryOrder.staff || ''}`
  $('preview-terms').textContent = `: ${deliveryOrder.terms || ''}`
  $('preview-job').textContent = `: ${deliveryOrder.job || ''}`
  $('preview-subject').textContent = deliveryOrder.subjectTitle || 'DELIVERY ORDER SUBJECT'

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

  $('preview-items').innerHTML = `${rows}${refRow}
    <tr class="delivery-spacer-row" aria-hidden="true"><td></td><td></td><td></td></tr>`
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
  }, 650)
})

loadDeliveryOrder()
renderDeliveryOrder()

window.addEventListener('pageshow', () => {
  loadDeliveryOrder()
  renderDeliveryOrder()
})
