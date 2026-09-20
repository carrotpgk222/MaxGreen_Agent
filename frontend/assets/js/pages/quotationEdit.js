import { getEmails } from '../core/storage.js'
import { getQuotationDraft, saveQuotationDraft } from '../core/quotationStorage.js'
import { getCompanies, saveCompanies } from '../core/customerStorage.js'
import { getQueryParam } from '../core/utils.js'
import {
  createDefaultQuotation,
  createQuotationItem,
  escapeHtml,
  formatMoney,
  lineAmount,
  normalizeQuotationNumber,
  quotationTaxLabel,
  quotationTotals,
  taxAmount,
  totalInWords
} from '../core/quotationUtils.js'

const emailId = getQueryParam('id')
const email = getEmails().find(item => item.id === emailId)

if (!email || email.category !== 'Quotation') {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1 class="page-title">Quotation not found</h1></main>'
  throw new Error('Quotation record not found')
}

const $ = id => document.getElementById(id)
const elements = {
  back: $('back-to-quotation'),
  sourceSummary: $('source-summary'),
  company: $('company'),
  companySuggestions: $('company-suggestions'),
  attn: $('attn'),
  issueDate: $('issue-date'),
  dueDate: $('due-date'),
  quotationNumber: $('quotation-number'),
  currency: $('currency'),
  subjectTitle: $('subject-title'),
  items: $('quotation-items'),
  addRow: $('add-row'),
  subtotal: $('subtotal'),
  gstTotal: $('gst-total'),
  grandTotal: $('grand-total'),
  taxSummaryLabel: $('tax-summary-label'),
  amountWords: $('amount-words'),
  save: $('save-quotation'),
  attachFiles: $('attach-files'),
  attachmentNote: $('attachment-note'),
  companyModal: $('new-company-modal'),
  cancelNewCompany: $('cancel-new-company'),
  saveNewCompany: $('save-new-company'),
  newCompanyName: $('new-company-name'),
  newCompanyAttn: $('new-company-attn'),
  newCompanyEmail: $('new-company-email'),
  newCompanyAddress: $('new-company-address'),
  newCompanyPostal: $('new-company-postal'),
  newCompanyContact: $('new-company-contact')
}

const returnUrl = `./quotation.html?id=${encodeURIComponent(emailId)}`
elements.back.href = returnUrl
elements.sourceSummary.textContent = `Source: ${email.subject}`

let companies = getCompanies()
let selectedCompanyId = null
let modalCompanyId = null
const ADD_CONTACT_VALUE = '__add_contact__'
let state = createDefaultQuotation(email)
const savedDraft = getQuotationDraft(emailId)

if (savedDraft) {
  state = {
    ...state,
    ...savedDraft,
    documentId: email.documentId || savedDraft.documentId || '',
    quotationNumber: email.documentId || savedDraft.quotationNumber || '',
    items: (savedDraft.items?.length ? savedDraft.items : [{}]).map((item, index) => createQuotationItem(item, index + 1))
  }
}

let attnBeforeAdd = state.attn || ''

function digitsOnly(value = '') {
  return String(value).replace(/\D/g, '')
}

function customerCompanies() {
  return companies.filter(company => company.type === 'Client')
}

function matchingCompanyByName(name) {
  const normalized = String(name || '').trim().toLowerCase()
  return customerCompanies().find(company => company.companyName.trim().toLowerCase() === normalized) || null
}

function snapshotSelectedCustomer(company) {
  const contact = company?.contacts?.find(item => item.name === elements.attn.value)
    || company?.contacts?.[0]
    || null

  state.companyId = company?.id || ''
  state.customerAddress = contact?.address || ''
  state.customerPostal = contact?.postal || ''
}

function renderAttnOptions(company, preferredAttn = '') {
  const contacts = company?.contacts || []
  const contactOptions = contacts.map(contact => `
    <option value="${escapeHtml(contact.name)}">${escapeHtml(contact.name || 'Unnamed contact')}</option>
  `).join('')

  elements.attn.innerHTML = `${contactOptions}<option value="${ADD_CONTACT_VALUE}">＋ Add new Attn / contact</option>`

  if (!contacts.length) {
    elements.attn.value = ADD_CONTACT_VALUE
    state.attn = ''
    state.customerAddress = ''
    state.customerPostal = ''
    return
  }

  const preferredExists = contacts.some(contact => contact.name === preferredAttn)
  elements.attn.value = preferredExists ? preferredAttn : contacts[0].name
  state.attn = elements.attn.value
  attnBeforeAdd = state.attn
  snapshotSelectedCustomer(company)
}

function selectCompany(company, preferredAttn = '') {
  if (!company) return

  selectedCompanyId = company.id
  state.companyId = company.id
  state.company = company.companyName
  elements.company.value = company.companyName
  renderAttnOptions(company, preferredAttn)
  hideCompanySuggestions()
}

function hideCompanySuggestions() {
  elements.companySuggestions.hidden = true
  elements.companySuggestions.innerHTML = ''
  elements.company.setAttribute('aria-expanded', 'false')
}

function renderCompanySuggestions() {
  const query = elements.company.value.trim().toLowerCase()
  const matches = customerCompanies()
    .filter(company => !query || company.companyName.toLowerCase().includes(query))
    .slice(0, 8)

  const suggestionRows = matches.map(company => `
    <button class="company-suggestion" type="button" role="option" data-company-id="${escapeHtml(company.id)}">
      <span>${escapeHtml(company.companyName)}</span>
      <small>${escapeHtml(company.contacts?.[0]?.name || 'No Attn')}</small>
    </button>
  `).join('')

  const addLabel = elements.company.value.trim()
    ? `+ Add "${escapeHtml(elements.company.value.trim())}" as new customer`
    : '+ Add new customer'

  elements.companySuggestions.innerHTML = `
    ${suggestionRows || '<div class="company-suggestion-empty">No existing customer found</div>'}
    <button class="company-suggestion add-company-suggestion" type="button" data-add-new-company>${addLabel}</button>
  `
  elements.companySuggestions.hidden = false
  elements.company.setAttribute('aria-expanded', 'true')
}

function openNewCompanyModal(prefillName = '', existingCompany = null) {
  modalCompanyId = existingCompany?.id || null
  attnBeforeAdd = state.attn || ''
  elements.newCompanyName.value = existingCompany?.companyName || prefillName.trim()
  elements.newCompanyName.readOnly = Boolean(existingCompany)
  elements.newCompanyAttn.value = ''
  elements.newCompanyEmail.value = ''
  elements.newCompanyAddress.value = existingCompany?.contacts?.[0]?.address || ''
  elements.newCompanyPostal.value = existingCompany?.contacts?.[0]?.postal || ''
  elements.newCompanyContact.value = ''
  elements.companyModal.hidden = false
  document.body.classList.add('modal-open')
  window.setTimeout(() => elements.newCompanyAttn.focus(), 0)
}

function closeNewCompanyModal(restoreAttn = true) {
  elements.companyModal.hidden = true
  elements.newCompanyName.readOnly = false
  document.body.classList.remove('modal-open')
  if (restoreAttn && selectedCompanyId) {
    const company = companies.find(item => item.id === selectedCompanyId)
    if (company) renderAttnOptions(company, attnBeforeAdd)
  }
  modalCompanyId = null
}

function saveNewCompanyFromModal() {
  const companyName = elements.newCompanyName.value.trim()
  const attnName = elements.newCompanyAttn.value.trim()
  if (!companyName) {
    elements.newCompanyName.setCustomValidity('Enter a company name before saving.')
    elements.newCompanyName.reportValidity()
    elements.newCompanyName.setCustomValidity('')
    return
  }
  if (!attnName) {
    elements.newCompanyAttn.setCustomValidity('Enter the Attn name before saving.')
    elements.newCompanyAttn.reportValidity()
    elements.newCompanyAttn.setCustomValidity('')
    return
  }

  const contact = {
    id: `contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: attnName,
    email: elements.newCompanyEmail.value.trim(),
    address: elements.newCompanyAddress.value.trim(),
    postal: digitsOnly(elements.newCompanyPostal.value),
    contactNumber: digitsOnly(elements.newCompanyContact.value)
  }

  const existing = companies.find(company => company.id === modalCompanyId) || matchingCompanyByName(companyName)
  if (existing) {
    const sameContact = existing.contacts?.find(item => item.name.trim().toLowerCase() === attnName.toLowerCase())
    if (sameContact) Object.assign(sameContact, { ...contact, id: sameContact.id })
    else existing.contacts = [...(existing.contacts || []), contact]
    saveCompanies(companies)
    closeNewCompanyModal(false)
    selectCompany(existing, attnName)
    return
  }

  const company = { id: `company-${Date.now()}`, companyName, type: 'Client', contacts: [contact] }
  companies.push(company)
  saveCompanies(companies)
  closeNewCompanyModal(false)
  selectCompany(company, attnName)
}

function renderItems() {
  elements.items.innerHTML = state.items.map((item, index) => {
    const amount = lineAmount(item)
    const tax = taxAmount(item)

    return `
      <tr data-row-id="${item.rowId}">
        <td><input data-field="item" value="${escapeHtml(item.item)}" aria-label="Item ${index + 1}" /></td>
        <td><textarea data-field="description" aria-label="Description ${index + 1}">${escapeHtml(item.description)}</textarea></td>
        <td><input data-field="qty" type="number" min="0" step="1" inputmode="numeric" value="${Math.trunc(Number(item.qty || 0))}" /></td>
        <td><input data-field="uom" value="${escapeHtml(item.uom)}" /></td>
        <td><input data-field="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}" /></td>
        <td>
          <div class="percent-input">
            <input data-field="taxRate" type="number" min="0" step="0.01" inputmode="decimal" value="${item.taxRate}" aria-label="Tax rate ${index + 1}" />
            <span>%</span>
          </div>
        </td>
        <td><input class="readonly" data-calculated="tax" value="${formatMoney(tax)}" readonly tabindex="-1" /></td>
        <td><input class="readonly" data-calculated="total" value="${formatMoney(amount + tax)}" readonly tabindex="-1" /></td>
        <td><button class="row-delete" type="button" data-delete-row="${item.rowId}" title="Delete row">🗑</button></td>
      </tr>
    `
  }).join('')
}

function renderTotals() {
  const { subtotal, gst, total } = quotationTotals(state.items)
  elements.subtotal.textContent = formatMoney(subtotal)
  elements.gstTotal.textContent = formatMoney(gst)
  elements.grandTotal.textContent = formatMoney(total)
  elements.taxSummaryLabel.textContent = quotationTaxLabel(state.items, 'editor')
  elements.amountWords.textContent = totalInWords(total)
}

function applyStateToFields() {
  elements.company.value = state.company || ''
  elements.issueDate.value = state.issueDate || ''
  elements.dueDate.value = state.dueDate || ''
  elements.quotationNumber.value = email.documentId || state.documentId || state.quotationNumber || ''
  state.quotationNumber = elements.quotationNumber.value
  state.documentId = elements.quotationNumber.value
  elements.currency.value = state.currency || 'SGD'
  elements.subjectTitle.value = state.subjectTitle || ''
  elements.attachmentNote.textContent = state.attachments?.length ? `${state.attachments.length} file(s) attached` : ''

  const existingCompany = matchingCompanyByName(state.company)
  if (existingCompany) {
    selectCompany(existingCompany, state.attn)
  } else {
    selectedCompanyId = null
    elements.attn.innerHTML = state.attn
      ? `<option value="${escapeHtml(state.attn)}">${escapeHtml(state.attn)}</option>`
      : '<option value="">Select company first</option>'
    elements.attn.value = state.attn || ''
  }

  renderItems()
  renderTotals()
}

function syncStateFromFields() {
  const selectedCompany = companies.find(company => company.id === selectedCompanyId)
  state.companyId = selectedCompany?.id || state.companyId || ''
  state.company = selectedCompany?.companyName || elements.company.value.trim()
  state.attn = elements.attn.value
  if (selectedCompany) snapshotSelectedCustomer(selectedCompany)
  state.issueDate = elements.issueDate.value
  state.dueDate = elements.dueDate.value
  state.quotationNumber = email.documentId || state.documentId || elements.quotationNumber.value
  state.currency = elements.currency.value
  state.subjectTitle = elements.subjectTitle.value.trim()
  state.documentId = state.documentId || email.documentId || ''
}

;[
  elements.issueDate,
  elements.dueDate,
  elements.currency,
  elements.subjectTitle
].forEach(input => {
  input.addEventListener('input', syncStateFromFields)
  input.addEventListener('change', syncStateFromFields)
})


elements.company.addEventListener('focus', renderCompanySuggestions)
elements.company.addEventListener('input', () => {
  const exact = matchingCompanyByName(elements.company.value)
  selectedCompanyId = exact?.id || null

  if (exact) {
    state.company = exact.companyName
    renderAttnOptions(exact, state.attn)
  } else {
    state.companyId = ''
    state.company = elements.company.value.trim()
    state.customerAddress = ''
    state.customerPostal = ''
    state.attn = ''
    elements.attn.innerHTML = '<option value="">Select an existing customer</option>'
  }

  renderCompanySuggestions()
})

elements.company.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return
  event.preventDefault()

  const exact = matchingCompanyByName(elements.company.value)
  if (exact) {
    selectCompany(exact, state.attn)
  } else {
    openNewCompanyModal(elements.company.value)
    hideCompanySuggestions()
  }
})

elements.companySuggestions.addEventListener('mousedown', event => {
  // Prevent the Company input from blurring before the selection click is handled.
  event.preventDefault()
})

elements.companySuggestions.addEventListener('click', event => {
  const companyButton = event.target.closest('[data-company-id]')
  if (companyButton) {
    const company = companies.find(item => item.id === companyButton.dataset.companyId)
    selectCompany(company, state.attn)
    return
  }

  if (event.target.closest('[data-add-new-company]')) {
    const typedName = elements.company.value
    hideCompanySuggestions()
    openNewCompanyModal(typedName)
  }
})

elements.attn.addEventListener('change', () => {
  const selectedCompany = companies.find(company => company.id === selectedCompanyId)
  if (elements.attn.value === ADD_CONTACT_VALUE) {
    if (selectedCompany) openNewCompanyModal(selectedCompany.companyName, selectedCompany)
    return
  }
  state.attn = elements.attn.value
  attnBeforeAdd = state.attn
  if (selectedCompany) snapshotSelectedCustomer(selectedCompany)
})

document.addEventListener('click', event => {
  if (!event.target.closest('.company-combobox')) hideCompanySuggestions()
})

elements.newCompanyPostal.addEventListener('input', () => {
  elements.newCompanyPostal.value = digitsOnly(elements.newCompanyPostal.value)
})

elements.newCompanyContact.addEventListener('input', () => {
  elements.newCompanyContact.value = digitsOnly(elements.newCompanyContact.value)
})

elements.cancelNewCompany.addEventListener('click', () => closeNewCompanyModal(true))
elements.saveNewCompany.addEventListener('click', saveNewCompanyFromModal)
elements.companyModal.addEventListener('click', event => {
  if (event.target.matches('[data-close-company-modal]')) closeNewCompanyModal(true)
})

elements.items.addEventListener('keydown', event => {
  if (event.target.dataset.field !== 'qty') return
  if (['.', ',', 'e', 'E', '+', '-'].includes(event.key)) event.preventDefault()
})

elements.items.addEventListener('input', event => {
  const row = event.target.closest('[data-row-id]')
  const field = event.target.dataset.field
  if (!row || !field) return

  const item = state.items.find(entry => entry.rowId === row.dataset.rowId)
  if (!item) return

  if (field === 'qty') {
    item.qty = Math.max(0, Math.trunc(Number(event.target.value || 0)))
  } else if (field === 'unitPrice' || field === 'taxRate') {
    item[field] = Number(event.target.value || 0)
  } else {
    item[field] = event.target.value
  }

  if (['qty', 'unitPrice', 'taxRate'].includes(field)) {
    const taxField = row.querySelector('[data-calculated="tax"]')
    const totalField = row.querySelector('[data-calculated="total"]')
    if (taxField) taxField.value = formatMoney(taxAmount(item))
    if (totalField) totalField.value = formatMoney(lineAmount(item) + taxAmount(item))
  }

  renderTotals()
})

elements.items.addEventListener('change', event => {
  const row = event.target.closest('[data-row-id]')
  const field = event.target.dataset.field
  if (!row || !field) return

  const item = state.items.find(entry => entry.rowId === row.dataset.rowId)
  if (!item) return

  if (field === 'qty') {
    item.qty = Math.max(0, Math.trunc(Number(event.target.value || 0)))
  } else if (field === 'unitPrice' || field === 'taxRate') {
    item[field] = Number(event.target.value || 0)
  } else {
    item[field] = event.target.value
  }

  renderItems()
  renderTotals()
})

elements.items.addEventListener('click', event => {
  const deleteButton = event.target.closest('[data-delete-row]')
  if (!deleteButton) return

  if (state.items.length === 1) {
    state.items = [createQuotationItem({}, 1)]
  } else {
    state.items = state.items.filter(item => item.rowId !== deleteButton.dataset.deleteRow)
  }

  renderItems()
  renderTotals()
})

elements.addRow.addEventListener('click', () => {
  state.items.push(createQuotationItem({}, state.items.length + 1))
  renderItems()
  renderTotals()
})

elements.attachFiles.addEventListener('click', () => {
  state.attachments = ['quotation-supporting-file.pdf']
  elements.attachmentNote.textContent = '1 demo file attached (real upload will be connected later)'
})

elements.save.addEventListener('click', () => {
  syncStateFromFields()

  const selectedCompany = companies.find(company => company.id === selectedCompanyId)
  if (!selectedCompany) {
    const exact = matchingCompanyByName(elements.company.value)
    if (exact) {
      selectCompany(exact, state.attn)
    } else if (elements.company.value.trim()) {
      openNewCompanyModal(elements.company.value)
      return
    } else {
      elements.company.setCustomValidity('Select an existing customer or add a new customer before saving.')
      elements.company.reportValidity()
      elements.company.setCustomValidity('')
      elements.company.focus()
      return
    }
  }

  elements.quotationNumber.value = email.documentId || state.documentId || elements.quotationNumber.value
  state.quotationNumber = elements.quotationNumber.value
  syncStateFromFields()

  saveQuotationDraft(emailId, {
    ...state,
    documentId: email.documentId || state.documentId || '',
    savedAt: new Date().toISOString()
  })

  // Return to the review page. That page re-reads localStorage and redraws
  // the fixed quotation PDF using the values just saved here.
  window.location.assign(returnUrl)
})

applyStateToFields()
