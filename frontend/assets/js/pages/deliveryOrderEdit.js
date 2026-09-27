import { getEmails } from '../core/storage.js'
import { getQueryParam } from '../core/utils.js'
import { getQuotationDraft } from '../core/quotationStorage.js'
import { getDeliveryOrderDraft, saveDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { completedQuotationRows, filterQuotationRows, isSelectableQuotation } from '../core/quotationPicker.js'
import { getCompanies, saveCompanies } from '../core/customerStorage.js'
import {
  createDefaultDeliveryOrder,
  createDeliveryOrderItem,
  deliveryOrderFromQuotation,
  escapeHtml,
  normalizeDeliveryOrderNumber
} from '../core/deliveryOrderUtils.js'
import {
  displayDate,
  formatMoney,
  lineAmount,
  quotationTaxLabel,
  quotationTotals,
  taxAmount,
  totalInWords
} from '../core/quotationUtils.js'

const emailId = getQueryParam('id')
const email = getEmails().find(item => item.id === emailId)

if (!email || !['Delivery Order', 'Invoice & DO'].includes(email.category)) {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1 class="page-title">Delivery Order not found</h1></main>'
  throw new Error('Delivery Order record not found')
}

const $ = id => document.getElementById(id)
const isBundle = email.category === 'Invoice & DO'
const deliveryDocumentId = isBundle ? (email.documentIds?.deliveryOrder || '') : (email.documentId || '')
$('back-to-delivery').href = isBundle ? `./invoice-do.html?id=${encodeURIComponent(emailId)}` : `./delivery-order.html?id=${encodeURIComponent(emailId)}`

function loadInitialState() {
  const saved = getDeliveryOrderDraft(emailId)
  if (saved) {
    return {
      ...createDefaultDeliveryOrder(email),
      ...saved,
      documentId: deliveryDocumentId || saved.documentId || '',
      deliveryOrderNumber: deliveryDocumentId || saved.deliveryOrderNumber || '',
      items: (saved.items?.length ? saved.items : [{}]).map((item, index) => createDeliveryOrderItem(item, index + 1))
    }
  }

  if (email.sourceQuotationEmailId) {
    const quotation = getQuotationDraft(email.sourceQuotationEmailId)
    if (quotation) {
      return deliveryOrderFromQuotation(email, quotation, {
        sourceQuotationEmailId: email.sourceQuotationEmailId,
        refQuoteDocumentId: quotation.quotationNumber || quotation.documentId || email.refQuoteDocumentId || ''
      })
    }
  }

  return createDefaultDeliveryOrder(email)
}

let state = loadInitialState()
let selectedQuoteEmailId = state.sourceQuotationEmailId || ''

const elements = {
  company: $('do-company'),
  companySuggestions: $('do-company-suggestions'),
  attn: $('do-attn'),
  date: $('do-date'),
  dueDate: $('do-due-date'),
  number: $('do-number'),
  currency: $('do-currency'),
  refQuoteSearch: $('ref-quote-search'),
  refQuoteSuggestions: $('ref-quote-suggestions'),
  subject: $('do-subject'),
  items: $('delivery-items'),
  attachmentNote: $('do-attachment-note'),
  subtotal: $('do-subtotal'),
  gst: $('do-gst'),
  total: $('do-total'),
  taxLabel: $('do-tax-label'),
  amountWords: $('do-amount-words'),
  companyModal: $('do-new-company-modal'),
  cancelNewCompany: $('do-cancel-new-company'),
  saveNewCompany: $('do-save-new-company'),
  newCompanyName: $('do-new-company-name'),
  newCompanyAttn: $('do-new-company-attn'),
  newCompanyEmail: $('do-new-company-email'),
  newCompanyAddress: $('do-new-company-address'),
  newCompanyPostal: $('do-new-company-postal'),
  newCompanyContact: $('do-new-company-contact')
}

let companies = getCompanies()
let selectedCompanyId = state.companyId || null
let modalCompanyId = null
let attnBeforeAdd = state.attn || ''
const ADD_CONTACT_VALUE = '__add_contact__'

function digitsOnly(value = '') { return String(value).replace(/\D/g, '') }
function customerCompanies() { return companies.filter(company => company.type === 'Client') }
function matchingCompanyByName(name) {
  const normalized = String(name || '').trim().toLowerCase()
  return customerCompanies().find(company => company.companyName.trim().toLowerCase() === normalized) || null
}
function snapshotCustomer(company) {
  const contact = company?.contacts?.find(item => item.name === elements.attn.value) || company?.contacts?.[0] || null
  state.companyId = company?.id || ''
  state.customerAddress = contact?.address || ''
  state.customerPostal = contact?.postal || ''
}
function renderAttnOptions(company, preferred = '') {
  const contacts = company?.contacts || []
  const contactOptions = contacts.map(contact => `<option value="${escapeHtml(contact.name)}">${escapeHtml(contact.name || 'Unnamed contact')}</option>`).join('')
  elements.attn.innerHTML = `${contactOptions}<option value="${ADD_CONTACT_VALUE}">＋ Add new Attn / contact</option>`
  if (!contacts.length) {
    elements.attn.value = ADD_CONTACT_VALUE
    state.attn = ''
    state.customerAddress = ''
    state.customerPostal = ''
    return
  }
  elements.attn.value = contacts.some(c => c.name === preferred) ? preferred : contacts[0].name
  state.attn = elements.attn.value
  attnBeforeAdd = state.attn
  snapshotCustomer(company)
}
function selectCompany(company, preferred = '') {
  if (!company) return
  selectedCompanyId = company.id
  state.companyId = company.id
  state.company = company.companyName
  elements.company.value = company.companyName
  renderAttnOptions(company, preferred)
  hideCompanySuggestions()
}
function hideCompanySuggestions() {
  elements.companySuggestions.hidden = true
  elements.companySuggestions.innerHTML = ''
  elements.company.setAttribute('aria-expanded', 'false')
}
function renderCompanySuggestions() {
  const query = elements.company.value.trim().toLowerCase()
  const matches = customerCompanies().filter(company => !query || company.companyName.toLowerCase().includes(query)).slice(0, 8)
  const rows = matches.map(company => `<button class="company-suggestion" type="button" role="option" data-company-id="${escapeHtml(company.id)}"><span>${escapeHtml(company.companyName)}</span><small>${escapeHtml(company.contacts?.[0]?.name || 'No Attn')}</small></button>`).join('')
  const label = elements.company.value.trim() ? `+ Add "${escapeHtml(elements.company.value.trim())}" as new customer` : '+ Add new customer'
  elements.companySuggestions.innerHTML = `${rows || '<div class="company-suggestion-empty">No existing customer found</div>'}<button class="company-suggestion add-company-suggestion" type="button" data-add-new-company>${label}</button>`
  elements.companySuggestions.hidden = false
  elements.company.setAttribute('aria-expanded', 'true')
}
function openNewCompanyModal(prefill = '', existingCompany = null) {
  modalCompanyId = existingCompany?.id || null
  attnBeforeAdd = state.attn || ''
  elements.newCompanyName.value = existingCompany?.companyName || prefill.trim()
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
  if (!companyName || !attnName) return
  const contact = {
    id: `contact-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
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

function hideRefQuoteSuggestions() {
  elements.refQuoteSuggestions.hidden = true
  elements.refQuoteSuggestions.innerHTML = ''
  elements.refQuoteSearch.setAttribute('aria-expanded', 'false')
}

function renderRefQuoteSuggestions(query = '') {
  const rows = filterQuotationRows(completedQuotationRows(), query).slice(0, 10)

  elements.refQuoteSuggestions.innerHTML = rows.length ? rows.map(({ email: quoteEmail, quotation }) => `
    <button class="ref-quote-suggestion" type="button" role="option" data-quote-email-id="${escapeHtml(quoteEmail.id)}">
      <span>
        <strong>${escapeHtml(quotation.quotationNumber || quoteEmail.documentId || '—')}</strong>
        <small>${escapeHtml(quotation.subjectTitle || quoteEmail.subject || '—')}</small>
      </span>
      <small>${escapeHtml(displayDate(quotation.issueDate || quoteEmail.receivedDate))}</small>
    </button>
  `).join('') : '<div class="ref-quote-empty">No completed quotation matches this search.</div>'

  elements.refQuoteSuggestions.hidden = false
  elements.refQuoteSearch.setAttribute('aria-expanded', 'true')
}

function applyQuotationReference(quoteEmailId) {
  const quoteEmail = getEmails().find(item => item.id === quoteEmailId)
  const quotation = getQuotationDraft(quoteEmailId)
  if (!isSelectableQuotation(quoteEmail) || !quotation) return

  const keep = {
    deliveryOrderNumber: state.deliveryOrderNumber || deliveryDocumentId || '',
    documentId: deliveryDocumentId || state.documentId || '',
    issueDate: state.issueDate,
    attachments: state.attachments || [],
    terms: state.terms,
    staff: state.staff,
    job: state.job,
    reference: deliveryDocumentId || state.documentId || '',
    externalReference: state.refQuoteDocumentId || state.externalReference || ''
  }

  state = deliveryOrderFromQuotation(email, quotation, {
    sourceQuotationEmailId: quoteEmailId,
    refQuoteDocumentId: quotation.quotationNumber || quoteEmail.documentId || '',
    ...keep
  })

  selectedQuoteEmailId = quoteEmailId
  renderAll()
  hideRefQuoteSuggestions()
}

function renderItems() {
  elements.items.innerHTML = state.items.map((item, index) => {
    const amount = lineAmount(item)
    const tax = taxAmount(item)
    return `
      <tr data-row-id="${escapeHtml(item.rowId)}">
        <td><input data-field="item" value="${escapeHtml(item.item || String(index + 1))}" /></td>
        <td><textarea data-field="description">${escapeHtml(item.description)}</textarea></td>
        <td><input data-field="qty" type="number" min="0" step="1" inputmode="numeric" value="${Math.trunc(Number(item.qty || 0))}" /></td>
        <td><input data-field="uom" value="${escapeHtml(item.uom)}" /></td>
        <td><input data-field="unitPrice" type="number" min="0" step="0.01" value="${Number(item.unitPrice || 0)}" /></td>
        <td><div class="percent-input"><input data-field="taxRate" type="number" min="0" step="0.01" value="${Number(item.taxRate || 0)}" /><span>%</span></div></td>
        <td><input class="readonly" data-calculated="tax" value="${formatMoney(tax)}" readonly tabindex="-1" /></td>
        <td><input class="readonly" data-calculated="total" value="${formatMoney(amount + tax)}" readonly tabindex="-1" /></td>
        <td><button class="delivery-row-delete" type="button" data-delete-row="${escapeHtml(item.rowId)}" title="Delete row">🗑</button></td>
      </tr>
    `
  }).join('')
}

function renderTotals() {
  const { subtotal, gst, total } = quotationTotals(state.items)
  elements.subtotal.textContent = formatMoney(subtotal)
  elements.gst.textContent = formatMoney(gst)
  elements.total.textContent = formatMoney(total)
  elements.taxLabel.textContent = quotationTaxLabel(state.items, 'editor')
  elements.amountWords.textContent = totalInWords(total)
}

function renderAll() {
  elements.company.value = state.company || ''
  const existingCompany = matchingCompanyByName(state.company)
  if (existingCompany) {
    selectCompany(existingCompany, state.attn)
  } else {
    selectedCompanyId = null
    elements.attn.innerHTML = state.attn ? `<option value="${escapeHtml(state.attn)}">${escapeHtml(state.attn)}</option>` : '<option value="">Select company first</option>'
    elements.attn.value = state.attn || ''
  }
  elements.date.value = state.issueDate || ''
  elements.dueDate.value = state.dueDate || ''
  elements.number.value = deliveryDocumentId || state.documentId || state.deliveryOrderNumber || ''
  state.deliveryOrderNumber = elements.number.value
  state.documentId = elements.number.value
  state.reference = elements.number.value
  elements.currency.value = state.currency || 'SGD'
  elements.refQuoteSearch.value = state.refQuoteDocumentId || ''
  elements.subject.value = state.subjectTitle || ''
  elements.attachmentNote.textContent = state.attachments?.length ? `${state.attachments.length} file(s) attached` : ''
  renderItems()
  renderTotals()
}

function syncFields() {
  const selectedCompany = companies.find(company => company.id === selectedCompanyId)
  state.companyId = selectedCompany?.id || state.companyId || ''
  state.company = selectedCompany?.companyName || elements.company.value.trim()
  state.attn = elements.attn.value
  if (selectedCompany) snapshotCustomer(selectedCompany)
  state.issueDate = elements.date.value
  state.dueDate = elements.dueDate.value
  state.deliveryOrderNumber = deliveryDocumentId || state.documentId || elements.number.value
  state.documentId = state.deliveryOrderNumber
  state.reference = state.deliveryOrderNumber
  state.externalReference = state.refQuoteDocumentId || state.externalReference || ''
  state.currency = elements.currency.value
  state.subjectTitle = elements.subject.value.trim()
}

;[elements.date, elements.dueDate, elements.currency, elements.subject].forEach(input => {
  input.addEventListener('input', syncFields)
  input.addEventListener('change', syncFields)
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
  if (exact) selectCompany(exact, state.attn)
  else { openNewCompanyModal(elements.company.value); hideCompanySuggestions() }
})
elements.companySuggestions.addEventListener('mousedown', event => event.preventDefault())
elements.companySuggestions.addEventListener('click', event => {
  const button = event.target.closest('[data-company-id]')
  if (button) { selectCompany(companies.find(company => company.id === button.dataset.companyId), state.attn); return }
  if (event.target.closest('[data-add-new-company]')) { const typed = elements.company.value; hideCompanySuggestions(); openNewCompanyModal(typed) }
})
elements.attn.addEventListener('change', () => {
  const company = companies.find(item => item.id === selectedCompanyId)
  if (elements.attn.value === ADD_CONTACT_VALUE) {
    if (company) openNewCompanyModal(company.companyName, company)
    return
  }
  state.attn = elements.attn.value
  attnBeforeAdd = state.attn
  if (company) snapshotCustomer(company)
})
elements.newCompanyPostal.addEventListener('input', () => { elements.newCompanyPostal.value = digitsOnly(elements.newCompanyPostal.value) })
elements.newCompanyContact.addEventListener('input', () => { elements.newCompanyContact.value = digitsOnly(elements.newCompanyContact.value) })
elements.cancelNewCompany.addEventListener('click', () => closeNewCompanyModal(true))
elements.saveNewCompany.addEventListener('click', saveNewCompanyFromModal)
elements.companyModal.addEventListener('click', event => { if (event.target.matches('[data-close-do-company-modal]')) closeNewCompanyModal(true) })

// See invoiceEdit.js: the box is pre-filled with the linked quotation, so focus
// must not filter by that value.
elements.refQuoteSearch.addEventListener('focus', () => {
  renderRefQuoteSuggestions('')
  elements.refQuoteSearch.select()
})
elements.refQuoteSearch.addEventListener('input', () => renderRefQuoteSuggestions(elements.refQuoteSearch.value))
elements.refQuoteSearch.addEventListener('keydown', event => {
  if (event.key === 'Escape') hideRefQuoteSuggestions()
})
elements.refQuoteSearch.addEventListener('blur', () => {
  window.setTimeout(() => {
    elements.refQuoteSearch.value = state.refQuoteDocumentId || ''
    hideRefQuoteSuggestions()
  }, 150)
})

elements.refQuoteSuggestions.addEventListener('mousedown', event => event.preventDefault())
elements.refQuoteSuggestions.addEventListener('click', event => {
  const button = event.target.closest('[data-quote-email-id]')
  if (button) applyQuotationReference(button.dataset.quoteEmailId)
})

document.addEventListener('click', event => {
  if (!event.target.closest('.ref-quote-picker-field')) hideRefQuoteSuggestions()
  if (!event.target.closest('.company-combobox')) hideCompanySuggestions()
})

$('add-do-row').addEventListener('click', () => {
  state.items.push(createDeliveryOrderItem({}, state.items.length + 1))
  renderItems()
  renderTotals()
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

  if (field === 'qty') item.qty = Math.max(0, Math.trunc(Number(event.target.value || 0)))
  else if (field === 'unitPrice' || field === 'taxRate') item[field] = Math.max(0, Number(event.target.value || 0))
  else item[field] = event.target.value

  if (field === 'qty' || field === 'unitPrice' || field === 'taxRate') {
    const taxField = row.querySelector('[data-calculated="tax"]')
    const totalField = row.querySelector('[data-calculated="total"]')
    if (taxField) taxField.value = formatMoney(taxAmount(item))
    if (totalField) totalField.value = formatMoney(lineAmount(item) + taxAmount(item))
  }
  renderTotals()
})

elements.items.addEventListener('click', event => {
  const button = event.target.closest('[data-delete-row]')
  if (!button) return
  if (state.items.length === 1) state.items = [createDeliveryOrderItem({}, 1)]
  else state.items = state.items.filter(item => item.rowId !== button.dataset.deleteRow)
  renderItems()
  renderTotals()
})

$('attach-do-files').addEventListener('click', () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.addEventListener('change', () => {
    const names = [...input.files].map(file => file.name)
    state.attachments = [...new Set([...(state.attachments || []), ...names])]
    elements.attachmentNote.textContent = state.attachments.length ? `${state.attachments.length} file(s) attached` : ''
  })
  input.click()
})

$('save-delivery-order').addEventListener('click', () => {
  syncFields()
  if (!selectedQuoteEmailId || !state.refQuoteDocumentId) {
    elements.refQuoteSearch.setCustomValidity('Select a completed quotation from the Ref Quote list.')
    elements.refQuoteSearch.reportValidity()
    elements.refQuoteSearch.setCustomValidity('')
    return
  }
  state.deliveryOrderNumber = deliveryDocumentId || state.documentId || state.deliveryOrderNumber || ''
  state.documentId = state.deliveryOrderNumber
  state.reference = state.deliveryOrderNumber
  state.externalReference = state.refQuoteDocumentId || ''
  state.sourceQuotationEmailId = selectedQuoteEmailId
  saveDeliveryOrderDraft(emailId, state)
  window.location.href = isBundle ? `./invoice-do.html?id=${encodeURIComponent(emailId)}` : `./delivery-order.html?id=${encodeURIComponent(emailId)}`
})

renderAll()
