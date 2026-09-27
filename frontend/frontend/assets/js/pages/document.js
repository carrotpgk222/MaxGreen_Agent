import { inboxCategories } from '../data/mockData.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { escapeHtml, getQueryParam, money } from '../core/utils.js'
import { changeWorkflowCategory } from '../core/workflowCategory.js'

const emails = getEmails()
const id = getQueryParam('id')
const email = emails.find(item => item.id === id)

if (!email) {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1 class="page-title">Document not found</h1></main>'
} else {
  const fileName = document.getElementById('document-file-name')
  const subject = document.getElementById('email-subject')
  const from = document.getElementById('email-from')
  const receivedDate = document.getElementById('email-date')
  const body = document.getElementById('email-body')
  const attachmentList = document.getElementById('attachment-list')
  const originalCategory = document.getElementById('original-category')
  const confidence = document.getElementById('confidence')
  const categorySelect = document.getElementById('category-select')
  const editButton = document.getElementById('edit-document')
  const saveButton = document.getElementById('save-pending')
  const pdfTitle = document.getElementById('pdf-title')
  const pdfDate = document.getElementById('pdf-date')
  const pdfReference = document.getElementById('pdf-reference')
  const descriptionText = document.getElementById('description-text')
  const descriptionInput = document.getElementById('description-input')
  const amountText = document.getElementById('amount-text')
  const amountInput = document.getElementById('amount-input')
  const totalAmount = document.getElementById('total-amount')
  const auditParty = document.getElementById('audit-party')
  const auditOriginal = document.getElementById('audit-original')
  const auditCurrent = document.getElementById('audit-current')
  const auditDate = document.getElementById('audit-date')

  let editing = false
  let description = 'Replacement of Quartz TableTop'
  let amount = Number(email.amount || 0)

  const categories = email.section === 'inbox' ? inboxCategories : [email.category]
  categorySelect.innerHTML = categories
    .map(category => `<option value="${escapeHtml(category)}" ${category === email.category ? 'selected' : ''}>${escapeHtml(category)}</option>`)
    .join('')

  function refreshDocumentFields() {
    const category = categorySelect.value
    pdfTitle.textContent = category
    auditCurrent.textContent = category
    descriptionText.textContent = description
    descriptionInput.value = description
    amountText.textContent = `$${money(amount)}`
    amountInput.value = amount
    totalAmount.textContent = `$${money(amount)}`
  }

  fileName.textContent = email.fileName
  subject.textContent = email.subject
  from.textContent = email.from
  receivedDate.textContent = email.receivedDate
  body.textContent = email.body
  originalCategory.textContent = email.originalCategory
  confidence.textContent = `${Math.round(email.confidence * 100)}% confidence`
  pdfDate.textContent = email.receivedDate
  pdfReference.textContent = email.subject
  auditParty.textContent = email.partyType
  auditOriginal.textContent = email.originalCategory
  auditDate.textContent = email.receivedDate

  attachmentList.innerHTML = email.attachments.length
    ? email.attachments.map(item => `<span class="attachment">📎 ${escapeHtml(item)}</span>`).join('')
    : '<span class="attachment">No attachments</span>'

  categorySelect.addEventListener('change', () => {
    if (['Quotation', 'Delivery Order'].includes(categorySelect.value)) {
      const changed = changeWorkflowCategory(id, categorySelect.value)
      if (changed?.route) {
        window.location.href = changed.route
        return
      }
    }
    refreshDocumentFields()
  })

  editButton.addEventListener('click', () => {
    if (editing) {
      description = descriptionInput.value.trim() || description
      amount = Number(amountInput.value || 0)
    }

    editing = !editing
    descriptionText.hidden = editing
    amountText.hidden = editing
    descriptionInput.hidden = !editing
    amountInput.hidden = !editing
    editButton.textContent = editing ? 'Done Editing' : 'Edit'
    refreshDocumentFields()
  })

  saveButton.addEventListener('click', () => {
    if (editing) {
      description = descriptionInput.value.trim() || description
      amount = Number(amountInput.value || 0)
    }

    email.category = categorySelect.value
    email.amount = amount
    email.status = 'Pending'
    email.correctedByUser = email.category !== email.originalCategory
    email.reviewedAt = new Date().toISOString()
    email.pendingAt = new Date().toISOString()

    saveEmails(emails)
    window.location.href = './pending.html'
  })

  refreshDocumentFields()
}
