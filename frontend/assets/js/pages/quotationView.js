import { inboxCategories } from '../data/mockData.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { getQuotationDraft, saveQuotationDraft } from '../core/quotationStorage.js'
import { getCompanies } from '../core/customerStorage.js'
import { getQueryParam } from '../core/utils.js'
import { changeWorkflowCategory } from '../core/workflowCategory.js'
import { renderAttachmentLinks } from '../core/attachmentUtils.js'
import { setupEmailBodyToggle } from '../core/emailBodyToggle.js'
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

  // Self-heal older Gmail quotations that already have a blank/default local
  // draft. The Inbox bridge normally prepares these, but this also works when
  // the user refreshes or opens quotation.html directly.
  if (email?.sourceType === 'gmail' && !draft?.humanEdited) {
    const hasDescription = Array.isArray(draft?.items) && draft.items.some(item => String(item?.description || '').trim())
    // Never copy the full email into the quotation Description. If structured AI
    // extraction is unavailable, use a short subject-based placeholder that the
    // user can edit while keeping the source email visible above the PDF.
    const sourceDescription = String(email.subject || '')
      .replace(/^\s*\[[^\]]+\]\s*/, '')
      .trim()
    let changed = false

    if (!String(draft.subjectTitle || '').trim() && String(email.subject || '').trim()) {
      draft.subjectTitle = email.subject.trim()
      changed = true
    }

    if (!hasDescription && sourceDescription) {
      draft.items = [createQuotationItem({
        item: '1',
        description: sourceDescription,
        qty: '',
        preserveBlankQty: true,
        uom: '',
        unitPrice: 0,
        taxRate: 9
      }, 1)]
      draft.automationFallback = true
      draft.aiSourceGmailMessageId = email.gmailMessageId || email.id
      changed = true
    }

    if (changed) saveQuotationDraft(emailId, draft)
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

const gmailTarget = email.threadId || email.gmailMessageId || email.id
const openGmail = $('open-gmail')
if (email.sourceType === 'gmail' && gmailTarget) {
  openGmail.href = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gmailTarget)}`
} else {
  openGmail.hidden = true
}
setupEmailBodyToggle()

function renderAiPreparationStatus() {
  const card = $('ai-prep-card')
  if (!card || email?.sourceType !== 'gmail') return

  // Report what is actually present in the PDF draft, not only what Claude
  // returned. This includes the safe source-email fallback used when AI could
  // classify the message but did not return structured quotation fields.
  const items = Array.isArray(quotation?.items) ? quotation.items : []
  const meaningfulItems = items.filter(item => String(item?.description || '').trim())
  const filled = []
  const review = []

  if (quotation?.company) filled.push('Company')
  else review.push('Company was not confidently found')

  if (quotation?.attn) filled.push('Attention / contact')
  else review.push('Attention / contact needs checking')

  if (quotation?.customerAddress || quotation?.customerPostal) filled.push('Customer address')
  else review.push('Customer address was not found')

  if (quotation?.subjectTitle) filled.push('Quotation subject')
  else review.push('Quotation subject needs checking')

  if (meaningfulItems.length) {
    filled.push(`${meaningfulItems.length} requested description${meaningfulItems.length === 1 ? '' : 's'}`)
    if (meaningfulItems.some(item => item.qty === '' || item.qty == null)) review.push('One or more quantities were not found')
    if (meaningfulItems.some(item => Number(item.unitPrice || 0) === 0)) review.push('One or more unit prices were not found')
  } else {
    review.push('No quotation description was prepared')
  }

  if (!review.length) review.push('Check the prepared fields against the source email before approval')

  const confidence = Number(email.confidence)
  const confidenceText = Number.isFinite(confidence)
    ? ` Classification confidence: ${Math.round(confidence * 100)}%.`
    : ''

  const usedFallback = Boolean(quotation?.automationFallback && !quotation?.aiPrefilled)
  $('ai-prep-summary').textContent = usedFallback
    ? `Automation prepared a safe first draft from the real email subject/body because structured AI extraction was unavailable.${confidenceText} Review and edit it before Pending.`
    : `Claude prepared this quotation draft from the source email.${confidenceText} AI output can be wrong, so the document remains editable before Pending.`

  $('ai-prep-filled').innerHTML = filled.length
    ? filled.map(item => `<li>${escapeHtml(item)}</li>`).join('')
    : '<li>No fields were automatically prepared.</li>'
  $('ai-prep-review').innerHTML = review.map(item => `<li>${escapeHtml(item)}</li>`).join('')
  card.hidden = false
}

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
renderAiPreparationStatus()

window.addEventListener('pageshow', () => {
  loadQuotation()
  renderQuotation()
  renderAiPreparationStatus()
})
