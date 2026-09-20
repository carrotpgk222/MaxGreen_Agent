import { inboxCategories } from '../data/mockData.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { getQuotationDraft, saveQuotationDraft } from '../core/quotationStorage.js'
import { getCompanies } from '../core/customerStorage.js'
import { getQueryParam } from '../core/utils.js'
import { changeWorkflowCategory } from '../core/workflowCategory.js'
import { renderAttachmentLinks } from '../core/attachmentUtils.js'
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

const emailId = getQueryParam('id')
let emails = getEmails()
let email = emails.find(item => item.id === emailId)

if (!email || email.category !== 'Quotation') {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1 class="page-title">Quotation not found</h1></main>'
  throw new Error('Quotation record not found')
}

const $ = id => document.getElementById(id)
let quotation = null

function loadQuotation() {
  // Re-read both the email record and quotation draft every time the review page
  // is shown. This guarantees the PDF preview reflects the latest editor save,
  // including when the browser restores this page from its back/forward cache.
  emails = getEmails()
  email = emails.find(item => item.id === emailId)
  let draft = getQuotationDraft(emailId)

  // A record can be manually changed to Quotation from another Inbox category.
  // If no quotation draft exists yet, create one immediately instead of showing
  // "Quotation not found".
  if (!draft) {
    draft = createDefaultQuotation(email)
    draft.documentId = email?.documentId || draft.documentId || ''
    draft.quotationNumber = email?.documentId || draft.quotationNumber || 'MGQ.'
    saveQuotationDraft(emailId, draft)
  }

  quotation = {
    ...createDefaultQuotation(email),
    ...draft,
    documentId: email?.documentId || draft?.documentId || '',
    quotationNumber: draft?.quotationNumber || email?.documentId || 'MGQ.',
    items: (draft?.items?.length ? draft.items : [{}]).map((item, index) => createQuotationItem(item, index + 1))
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
$('edit-quotation').href = `./quotation-edit.html?id=${encodeURIComponent(emailId)}`
$('quotation-file-name').textContent = email.fileName || `${email.documentId || 'Quotation'}.pdf`

$('source-attachments').innerHTML = renderAttachmentLinks(email.attachments || [])

function resolveCustomerDetails() {
  const companies = getCompanies()
  const company = companies.find(item =>
    (quotation.companyId && item.id === quotation.companyId) ||
    item.companyName?.trim().toLowerCase() === quotation.company?.trim().toLowerCase()
  )

  const contact = company?.contacts?.find(item => item.name === quotation.attn)
    || company?.contacts?.[0]
    || null

  return {
    address: quotation.customerAddress || contact?.address || '',
    postal: quotation.customerPostal || contact?.postal || ''
  }
}

function renderQuotation() {
  const { subtotal, gst, total } = quotationTotals(quotation.items)
  const customer = resolveCustomerDetails()

  $('preview-company').textContent = quotation.company || 'Customer / Company'
  $('preview-address').textContent = customer.address
  $('preview-postal').textContent = customer.postal ? `Singapore ${customer.postal}` : ''
  $('preview-attn').textContent = quotation.attn ? `Attn: ${quotation.attn}` : ''
  $('preview-number').textContent = `: ${quotation.quotationNumber || quotation.documentId || ''}`
  $('preview-date').textContent = `: ${displayDate(quotation.issueDate)}`
  // Subject Title belongs above the item table. It must not populate the Ref. field.
  $('preview-ref').textContent = `: ${quotation.documentId || quotation.quotationNumber || email.documentId || ''}`
  $('preview-external-ref').textContent = `: ${quotation.externalReference || email.externalReference || ''}`
  $('preview-subject').textContent = (quotation.subjectTitle || 'QUOTATION SUBJECT').toUpperCase()
  $('preview-amount-words').textContent = totalInWords(total)
  $('preview-subtotal').textContent = formatMoney(subtotal)
  $('preview-tax-label').textContent = quotationTaxLabel(quotation.items, 'pdf')
  $('preview-gst').textContent = formatMoney(gst)
  $('preview-total').textContent = formatMoney(total)

  const itemRows = quotation.items.map((item, index) => `
    <tr class="paper-data-row">
      <td>${escapeHtml(item.item || String(index + 1))}</td>
      <td>${escapeHtml(item.description).replace(/\n/g, '<br>')}</td>
      <td>${escapeHtml(String(item.qty || ''))}${item.uom ? ` ${escapeHtml(item.uom)}` : ''}</td>
      <td>${formatMoney(item.unitPrice)}</td>
      <td>${formatMoney(lineAmount(item))}</td>
    </tr>
  `).join('')

  // Keep entered quotation rows packed at the top. A final spacer row fills
  // the unused body height so the fixed PDF template retains its long table.
  $('preview-items').innerHTML = `${itemRows}
    <tr class="paper-spacer-row" aria-hidden="true">
      <td></td><td></td><td></td><td></td><td></td>
    </tr>`
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
  email.reviewedAt = new Date().toISOString()
  email.pendingAt = new Date().toISOString()

  saveEmails(emails)

  const toast = $('review-toast')
  toast.hidden = false
  window.setTimeout(() => {
    window.location.href = './pending.html'
  }, 650)
})

loadQuotation()
renderQuotation()

window.addEventListener('pageshow', () => {
  loadQuotation()
  renderQuotation()
})
