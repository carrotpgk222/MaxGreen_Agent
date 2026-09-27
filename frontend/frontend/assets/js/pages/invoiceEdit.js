import { getEmails } from '../core/storage.js'
import { getInvoiceDraft, saveInvoiceDraft } from '../core/invoiceStorage.js'
import { getDeliveryOrderDraft } from '../core/deliveryOrderStorage.js'
import { getQuotationDraft } from '../core/quotationStorage.js'
import { getQueryParam } from '../core/utils.js'
import { getCompanies, saveCompanies } from '../core/customerStorage.js'
import {
  createDefaultInvoice,
  createInvoiceItem,
  escapeHtml,
  invoiceFromDeliveryOrder
} from '../core/invoiceUtils.js'
import {
  formatMoney,
  lineAmount,
  quotationTaxLabel,
  quotationTotals,
  taxAmount,
  totalInWords
} from '../core/quotationUtils.js'

const ADD_CONTACT_VALUE = '__add_contact__'
const emailId = getQueryParam('id')
const email = getEmails().find(item => item.id === emailId)

if (!email || !['Invoice', 'Invoice & DO'].includes(email.category)) {
  document.body.innerHTML = '<main class="page"><a class="back-link" href="./inbox.html">← Back to Inbox</a><h1>Invoice not found</h1></main>'
  throw new Error('Invoice not found')
}

const $ = id => document.getElementById(id)
const isBundle = email.category === 'Invoice & DO'
const invoiceDocumentId = isBundle ? (email.documentIds?.invoice || '') : (email.documentId || '')
$('back-to-invoice').href = isBundle ? `./invoice-do.html?id=${encodeURIComponent(emailId)}` : `./invoice.html?id=${encodeURIComponent(emailId)}`

let savedDraft = getInvoiceDraft(emailId)
if (!savedDraft && email.sourceDeliveryOrderEmailId) {
  const deliveryOrder = getDeliveryOrderDraft(email.sourceDeliveryOrderEmailId)
  const quotationEmailId = deliveryOrder?.sourceQuotationEmailId || email.sourceQuotationEmailId || ''
  const quotation = quotationEmailId ? getQuotationDraft(quotationEmailId) : null

  if (deliveryOrder) {
    savedDraft = invoiceFromDeliveryOrder(email, deliveryOrder, quotation, {
      sourceDeliveryOrderEmailId: email.sourceDeliveryOrderEmailId,
      sourceQuotationEmailId: quotationEmailId,
      refQuoteDocumentId: email.refQuoteDocumentId || deliveryOrder.refQuoteDocumentId || quotation?.quotationNumber || '',
      externalDeliveryOrderId: email.externalReference || deliveryOrder.deliveryOrderNumber || deliveryOrder.documentId || '',
      documentId: invoiceDocumentId || '',
      invoiceNumber: invoiceDocumentId || '',
      terms: ''
    })
    saveInvoiceDraft(emailId, savedDraft)
  }
}

let state = {
  ...createDefaultInvoice(email),
  ...(savedDraft || {}),
  terms: ''
}
state.items = (state.items?.length ? state.items : [{}]).map((item, index) => createInvoiceItem(item, index + 1))

let companies = getCompanies()
let selectedCompanyId = state.companyId || null
let modalCompanyId = null
let attnBeforeAdd = state.attn || ''

const elements = {
  company: $('inv-company'),
  companySuggestions: $('inv-company-suggestions'),
  attn: $('inv-attn'),
  date: $('inv-date'),
  dueDate: $('inv-due-date'),
  number: $('inv-number'),
  currency: $('inv-currency'),
  quote: $('inv-ref-quote'),
  external: $('inv-external-do'),
  subject: $('inv-subject'),
  items: $('invoice-items'),
  subtotal: $('inv-subtotal'),
  gst: $('inv-gst'),
  total: $('inv-total'),
  taxLabel: $('inv-tax-label'),
  words: $('inv-amount-words'),
  attachmentNote: $('inv-attachment-note'),
  qrNote: $('qr-note'),
  modal: $('inv-new-company-modal'),
  newName: $('inv-new-company-name'),
  newAttn: $('inv-new-company-attn'),
  newEmail: $('inv-new-company-email'),
  newAddress: $('inv-new-company-address'),
  newPostal: $('inv-new-company-postal'),
  newContact: $('inv-new-company-contact')
}

function digitsOnly(value = '') {
  return String(value).replace(/\D/g, '')
}

function clientCompanies() {
  return companies.filter(company => company.type === 'Client')
}

function exactCompany(name) {
  const normalized = String(name || '').trim().toLowerCase()
  return clientCompanies().find(company => company.companyName.trim().toLowerCase() === normalized) || null
}

function selectedCompany() {
  return companies.find(company => company.id === selectedCompanyId) || exactCompany(elements.company.value)
}

function selectedContact(company = selectedCompany()) {
  return company?.contacts?.find(contact => contact.name === elements.attn.value)
    || company?.contacts?.find(contact => contact.name === state.attn)
    || company?.contacts?.[0]
    || null
}

function snapshotCustomer(company = selectedCompany()) {
  const contact = selectedContact(company)
  state.companyId = company?.id || ''
  state.customerAddress = contact?.address || ''
  state.customerPostal = contact?.postal || ''
}

function renderAttnOptions(company, preferred = '') {
  const contacts = company?.contacts || []
  const options = contacts.map(contact => `
    <option value="${escapeHtml(contact.name)}">${escapeHtml(contact.name || 'Unnamed contact')}</option>
  `).join('')

  elements.attn.innerHTML = `${options}<option value="${ADD_CONTACT_VALUE}">＋ Add new Attn / contact</option>`

  if (!contacts.length) {
    elements.attn.value = ADD_CONTACT_VALUE
    state.attn = ''
    state.customerAddress = ''
    state.customerPostal = ''
    return
  }

  const preferredExists = contacts.some(contact => contact.name === preferred)
  elements.attn.value = preferredExists ? preferred : contacts[0].name
  state.attn = elements.attn.value
  snapshotCustomer(company)
}

function selectCompany(company, preferred = '') {
  if (!company) return
  selectedCompanyId = company.id
  state.companyId = company.id
  state.company = company.companyName
  elements.company.value = company.companyName
  renderAttnOptions(company, preferred)
  hideSuggestions()
}

function hideSuggestions() {
  elements.companySuggestions.hidden = true
  elements.companySuggestions.innerHTML = ''
  elements.company.setAttribute('aria-expanded', 'false')
}

function renderSuggestions() {
  const query = elements.company.value.trim().toLowerCase()
  const matches = clientCompanies()
    .filter(company => !query || company.companyName.toLowerCase().includes(query))
    .slice(0, 8)

  const rows = matches.map(company => `
    <button type="button" class="company-suggestion" data-company-id="${escapeHtml(company.id)}">
      <span>${escapeHtml(company.companyName)}</span>
      <small>${escapeHtml(company.contacts?.[0]?.name || 'No Attn')}</small>
    </button>
  `).join('')

  const addLabel = elements.company.value.trim()
    ? `+ Add &quot;${escapeHtml(elements.company.value.trim())}&quot; as new customer`
    : '+ Add new customer'

  elements.companySuggestions.innerHTML = `${rows}<button type="button" class="company-suggestion add-company-suggestion" data-add-new-company>${addLabel}</button>`
  elements.companySuggestions.hidden = false
  elements.company.setAttribute('aria-expanded', 'true')
}

function openContactModal({ company = null, prefillName = '' } = {}) {
  modalCompanyId = company?.id || null
  attnBeforeAdd = state.attn || ''

  elements.newName.value = company?.companyName || prefillName.trim()
  elements.newName.readOnly = Boolean(company)
  elements.newAttn.value = ''
  elements.newEmail.value = ''
  elements.newAddress.value = company?.contacts?.[0]?.address || ''
  elements.newPostal.value = company?.contacts?.[0]?.postal || ''
  elements.newContact.value = ''
  elements.modal.hidden = false
  document.body.classList.add('modal-open')
  window.setTimeout(() => elements.newAttn.focus(), 0)
}

function closeModal({ restoreAttn = true } = {}) {
  elements.modal.hidden = true
  elements.newName.readOnly = false
  document.body.classList.remove('modal-open')

  if (restoreAttn && selectedCompanyId) {
    const company = companies.find(item => item.id === selectedCompanyId)
    renderAttnOptions(company, attnBeforeAdd)
  }
  modalCompanyId = null
}

function contactFromModal() {
  return {
    id: `contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: elements.newAttn.value.trim(),
    email: elements.newEmail.value.trim(),
    address: elements.newAddress.value.trim(),
    postal: digitsOnly(elements.newPostal.value),
    contactNumber: digitsOnly(elements.newContact.value)
  }
}

function saveNewCustomerOrContact() {
  const companyName = elements.newName.value.trim()
  const contact = contactFromModal()

  if (!companyName) {
    elements.newName.setCustomValidity('Enter a company name before saving.')
    elements.newName.reportValidity()
    elements.newName.setCustomValidity('')
    return
  }

  if (!contact.name) {
    elements.newAttn.setCustomValidity('Enter the Attn name before saving.')
    elements.newAttn.reportValidity()
    elements.newAttn.setCustomValidity('')
    return
  }

  const existing = companies.find(company => company.id === modalCompanyId) || exactCompany(companyName)

  if (existing) {
    const sameContact = existing.contacts?.find(item => item.name.trim().toLowerCase() === contact.name.toLowerCase())
    if (sameContact) Object.assign(sameContact, { ...contact, id: sameContact.id })
    else existing.contacts = [...(existing.contacts || []), contact]

    saveCompanies(companies)
    closeModal({ restoreAttn: false })
    selectCompany(existing, contact.name)
    return
  }

  const company = {
    id: `company-${Date.now()}`,
    companyName,
    type: 'Client',
    contacts: [contact]
  }

  companies.push(company)
  saveCompanies(companies)
  closeModal({ restoreAttn: false })
  selectCompany(company, contact.name)
}

function renderItems() {
  elements.items.innerHTML = state.items.map((item, index) => `
    <tr data-row-id="${escapeHtml(item.rowId)}">
      <td><input data-field="item" value="${escapeHtml(item.item || String(index + 1))}"></td>
      <td><textarea data-field="description">${escapeHtml(item.description || '')}</textarea></td>
      <td><input data-field="qty" type="number" min="0" step="1" value="${Math.trunc(Number(item.qty || 0))}"></td>
      <td><input data-field="uom" value="${escapeHtml(item.uom || '')}"></td>
      <td><input data-field="unitPrice" type="number" min="0" step="0.01" value="${Number(item.unitPrice || 0)}"></td>
      <td><div class="percent-input"><input data-field="taxRate" type="number" min="0" step="0.01" value="${Number(item.taxRate || 0)}"><span>%</span></div></td>
      <td><input class="readonly" data-calculated="tax" value="${formatMoney(taxAmount(item))}" readonly></td>
      <td><input class="readonly" data-calculated="total" value="${formatMoney(lineAmount(item) + taxAmount(item))}" readonly></td>
      <td><button class="invoice-row-delete" type="button" data-delete-row="${escapeHtml(item.rowId)}">🗑</button></td>
    </tr>
  `).join('')
}

function renderTotals() {
  const totals = quotationTotals(state.items)
  elements.subtotal.textContent = formatMoney(totals.subtotal)
  elements.gst.textContent = formatMoney(totals.gst)
  elements.total.textContent = formatMoney(totals.total)
  elements.taxLabel.textContent = quotationTaxLabel(state.items, 'editor')
  elements.words.textContent = totalInWords(totals.total)
}

function render() {
  state.terms = ''
  elements.company.value = state.company || ''
  const company = companies.find(item => item.id === state.companyId) || exactCompany(state.company)
  if (company) {
    selectedCompanyId = company.id
    renderAttnOptions(company, state.attn)
  } else {
    elements.attn.innerHTML = `<option value="">${escapeHtml(state.attn || 'Select company first')}</option>`
  }

  elements.date.value = state.issueDate || ''
  elements.dueDate.value = state.dueDate || ''
  elements.number.value = invoiceDocumentId || state.invoiceNumber || ''
  elements.currency.value = state.currency || 'SGD'
  elements.quote.value = state.refQuoteDocumentId || state.reference || ''
  elements.external.value = state.externalDeliveryOrderId || state.externalReference || ''
  elements.subject.value = state.subjectTitle || ''
  elements.attachmentNote.textContent = state.attachments?.length ? `${state.attachments.length} file(s) attached` : ''
  elements.qrNote.textContent = state.paynowQrDataUrl ? 'Custom PayNow QR selected' : 'Default PayNow QR'

  renderItems()
  renderTotals()
}

function sync() {
  state.issueDate = elements.date.value
  state.dueDate = elements.dueDate.value
  state.currency = elements.currency.value
  state.subjectTitle = elements.subject.value.trim()
  state.invoiceNumber = invoiceDocumentId
  state.documentId = invoiceDocumentId
  state.company = elements.company.value.trim()
  state.attn = elements.attn.value === ADD_CONTACT_VALUE ? attnBeforeAdd : elements.attn.value
  state.terms = ''
  snapshotCustomer()
}

;[elements.date, elements.dueDate, elements.currency, elements.subject].forEach(input => {
  input.addEventListener('input', sync)
  input.addEventListener('change', sync)
})

elements.company.addEventListener('focus', renderSuggestions)
elements.company.addEventListener('input', () => {
  selectedCompanyId = null
  state.company = elements.company.value
  renderSuggestions()
})

elements.companySuggestions.addEventListener('mousedown', event => event.preventDefault())
elements.companySuggestions.addEventListener('click', event => {
  const companyButton = event.target.closest('[data-company-id]')
  if (companyButton) {
    selectCompany(companies.find(company => company.id === companyButton.dataset.companyId), state.attn)
    return
  }

  if (event.target.closest('[data-add-new-company]')) {
    const typed = elements.company.value
    hideSuggestions()
    openContactModal({ prefillName: typed })
  }
})

elements.attn.addEventListener('change', () => {
  if (elements.attn.value === ADD_CONTACT_VALUE) {
    const company = selectedCompany()
    openContactModal({ company })
    return
  }

  state.attn = elements.attn.value
  attnBeforeAdd = state.attn
  snapshotCustomer()
})

document.addEventListener('click', event => {
  if (!event.target.closest('.company-combobox')) hideSuggestions()
})

elements.newPostal.addEventListener('input', () => { elements.newPostal.value = digitsOnly(elements.newPostal.value) })
elements.newContact.addEventListener('input', () => { elements.newContact.value = digitsOnly(elements.newContact.value) })
$('inv-cancel-new-company').addEventListener('click', () => closeModal())
$('inv-save-new-company').addEventListener('click', saveNewCustomerOrContact)
elements.modal.addEventListener('click', event => {
  if (event.target.matches('[data-close-inv-company-modal]')) closeModal()
})

elements.items.addEventListener('keydown', event => {
  if (event.target.dataset.field === 'qty' && ['.', ',', 'e', 'E', '+', '-'].includes(event.key)) event.preventDefault()
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

  const taxField = row.querySelector('[data-calculated="tax"]')
  const totalField = row.querySelector('[data-calculated="total"]')
  if (taxField) taxField.value = formatMoney(taxAmount(item))
  if (totalField) totalField.value = formatMoney(lineAmount(item) + taxAmount(item))
  renderTotals()
})

elements.items.addEventListener('click', event => {
  const button = event.target.closest('[data-delete-row]')
  if (!button) return
  state.items = state.items.filter(item => item.rowId !== button.dataset.deleteRow)
  if (!state.items.length) state.items = [createInvoiceItem({}, 1)]
  renderItems()
  renderTotals()
})

$('add-inv-row').addEventListener('click', () => {
  state.items.push(createInvoiceItem({}, state.items.length + 1))
  renderItems()
  renderTotals()
})

$('attach-inv-files').addEventListener('click', () => {
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

$('replace-paynow-qr').addEventListener('click', () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      state.paynowQrDataUrl = String(reader.result || '')
      elements.qrNote.textContent = 'Custom PayNow QR selected'
    })
    reader.readAsDataURL(file)
  })
  input.click()
})

$('save-invoice').addEventListener('click', () => {
  sync()
  saveInvoiceDraft(emailId, state)
  window.location.href = isBundle ? `./invoice-do.html?id=${encodeURIComponent(emailId)}` : `./invoice.html?id=${encodeURIComponent(emailId)}`
})

render()
