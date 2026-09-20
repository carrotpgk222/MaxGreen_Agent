import {
  createCompanyDraft,
  createContactDraft,
  getCompanies,
  saveCompanies
} from '../core/customerStorage.js'
import { escapeHtml } from '../core/utils.js'

const list = document.getElementById('company-list')
const editorHost = document.getElementById('company-editor-host')
const addCompanyButton = document.getElementById('add-company')
const searchInput = document.getElementById('company-search')

let companies = getCompanies()
let editorState = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function digitsOnly(value = '') {
  return String(value).replace(/\D/g, '')
}

function renderCompanies() {
  const query = searchInput.value.trim().toLowerCase()
  const filtered = companies.filter(company => {
    if (!query) return true

    return [
      company.companyName,
      company.type,
      ...company.contacts.flatMap(contact => [
        contact.name,
        contact.email,
        contact.address,
        contact.postal,
        contact.contactNumber
      ])
    ].some(value => String(value || '').toLowerCase().includes(query))
  })

  if (!filtered.length) {
    list.innerHTML = '<div class="company-empty">No companies found.</div>'
    return
  }

  list.innerHTML = filtered.map(company => `
    <article class="company-block" data-company-id="${escapeHtml(company.id)}">
      <header class="company-block-header">
        <h2>${escapeHtml(company.companyName)}</h2>
        <span class="company-type-badge">${escapeHtml(company.type)}</span>
        <button class="company-edit-button" type="button" data-edit-company="${escapeHtml(company.id)}">Edit</button>
      </header>

      <div class="company-table-wrap">
        <table class="company-table">
          <thead>
            <tr>
              <th>Name (Attn)</th>
              <th>Email</th>
              <th>Address</th>
              <th>Postal</th>
              <th>Contact Number</th>
              <th aria-label="Delete"></th>
            </tr>
          </thead>
          <tbody>
            ${company.contacts.map(contact => `
              <tr>
                <td>${escapeHtml(contact.name)}</td>
                <td>${escapeHtml(contact.email)}</td>
                <td>${escapeHtml(contact.address)}</td>
                <td>${escapeHtml(contact.postal)}</td>
                <td>${escapeHtml(contact.contactNumber)}</td>
                <td><button class="company-delete-button" type="button" data-delete-contact="${escapeHtml(contact.id)}" data-company-id="${escapeHtml(company.id)}" title="Delete contact">🗑</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </article>
  `).join('')
}

function renderEditor() {
  if (!editorState) {
    editorHost.hidden = true
    editorHost.innerHTML = ''
    return
  }

  editorHost.hidden = false
  const draft = editorState.draft

  editorHost.innerHTML = `
    <article class="company-editor-card">
      <div class="company-editor-topbar">
        <input
          class="company-name-input"
          id="editor-company-name"
          type="text"
          value="${escapeHtml(draft.companyName)}"
          placeholder="Add your Company"
          aria-label="Company name"
        />

        <div class="company-type-toggle-group" aria-label="Company type">
          <button class="type-toggle ${draft.type === 'Supplier' ? 'is-active' : ''}" type="button" data-company-type="Supplier">Supplier</button>
          <button class="type-toggle ${draft.type === 'Client' ? 'is-active' : ''}" type="button" data-company-type="Client">Client</button>
        </div>

        <div class="company-editor-actions">
          <button class="company-editor-button" id="save-company" type="button">Save</button>
          <button class="company-editor-button" id="cancel-company" type="button">Cancel</button>
        </div>
      </div>

      <div class="company-table-wrap">
        <table class="company-table company-editor-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Address</th>
              <th>Postal</th>
              <th>Contact Number</th>
              <th aria-label="Delete"></th>
            </tr>
          </thead>
          <tbody id="editor-contact-rows">
            ${draft.contacts.map(contact => editorRow(contact)).join('')}
          </tbody>
        </table>
        <div class="company-editor-footer">
          <button class="company-editor-button" id="add-contact-row" type="button">Add Row</button>
        </div>
      </div>
    </article>
  `
}

function editorRow(contact) {
  return `
    <tr data-editor-contact="${escapeHtml(contact.id)}">
      <td><input data-contact-field="name" value="${escapeHtml(contact.name)}" /></td>
      <td><input data-contact-field="email" type="email" value="${escapeHtml(contact.email)}" /></td>
      <td><input data-contact-field="address" value="${escapeHtml(contact.address)}" /></td>
      <td><input data-contact-field="postal" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(contact.postal)}" /></td>
      <td><input data-contact-field="contactNumber" inputmode="numeric" pattern="[0-9]*" value="${escapeHtml(contact.contactNumber)}" /></td>
      <td><button class="company-delete-button" type="button" data-editor-delete-contact="${escapeHtml(contact.id)}" title="Delete row">🗑</button></td>
    </tr>
  `
}

function openNewCompanyEditor() {
  editorState = {
    mode: 'add',
    originalId: null,
    draft: createCompanyDraft()
  }
  renderEditor()
  document.getElementById('editor-company-name')?.focus()
}

function openEditCompanyEditor(companyId) {
  const company = companies.find(item => item.id === companyId)
  if (!company) return

  editorState = {
    mode: 'edit',
    originalId: companyId,
    draft: clone(company)
  }
  renderEditor()
  editorHost.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function syncEditorFromDom() {
  if (!editorState) return

  const nameInput = document.getElementById('editor-company-name')
  editorState.draft.companyName = nameInput?.value.trim() || ''

  editorHost.querySelectorAll('[data-editor-contact]').forEach(row => {
    const contact = editorState.draft.contacts.find(item => item.id === row.dataset.editorContact)
    if (!contact) return

    row.querySelectorAll('[data-contact-field]').forEach(input => {
      const field = input.dataset.contactField
      const rawValue = input.value.trim()

      if (field === 'postal' || field === 'contactNumber') {
        const numericValue = digitsOnly(rawValue)
        contact[field] = numericValue
        if (input.value !== numericValue) input.value = numericValue
        return
      }

      contact[field] = rawValue
    })
  })
}

function closeEditor() {
  editorState = null
  renderEditor()
}

addCompanyButton.addEventListener('click', openNewCompanyEditor)
searchInput.addEventListener('input', renderCompanies)

list.addEventListener('click', event => {
  const edit = event.target.closest('[data-edit-company]')
  if (edit) {
    openEditCompanyEditor(edit.dataset.editCompany)
    return
  }

  const deleteContact = event.target.closest('[data-delete-contact]')
  if (!deleteContact) return

  const company = companies.find(item => item.id === deleteContact.dataset.companyId)
  if (!company) return

  company.contacts = company.contacts.filter(contact => contact.id !== deleteContact.dataset.deleteContact)
  saveCompanies(companies)
  renderCompanies()
})

editorHost.addEventListener('input', event => {
  if (!editorState) return

  const field = event.target.dataset?.contactField
  if (field === 'postal' || field === 'contactNumber') {
    event.target.value = digitsOnly(event.target.value)
  }

  syncEditorFromDom()
})

editorHost.addEventListener('click', event => {
  if (!editorState) return

  const typeButton = event.target.closest('[data-company-type]')
  if (typeButton) {
    syncEditorFromDom()
    editorState.draft.type = typeButton.dataset.companyType
    renderEditor()
    return
  }

  if (event.target.closest('#add-contact-row')) {
    syncEditorFromDom()
    editorState.draft.contacts.push(createContactDraft())
    renderEditor()
    return
  }

  const deleteRow = event.target.closest('[data-editor-delete-contact]')
  if (deleteRow) {
    syncEditorFromDom()
    if (editorState.draft.contacts.length === 1) {
      editorState.draft.contacts = [createContactDraft()]
    } else {
      editorState.draft.contacts = editorState.draft.contacts.filter(contact => contact.id !== deleteRow.dataset.editorDeleteContact)
    }
    renderEditor()
    return
  }

  if (event.target.closest('#cancel-company')) {
    closeEditor()
    return
  }

  if (event.target.closest('#save-company')) {
    syncEditorFromDom()

    if (!editorState.draft.companyName) {
      const nameInput = document.getElementById('editor-company-name')
      nameInput?.focus()
      nameInput?.setCustomValidity('Enter a company name before saving.')
      nameInput?.reportValidity()
      nameInput?.setCustomValidity('')
      return
    }

    const cleanedContacts = editorState.draft.contacts.filter(contact =>
      [contact.name, contact.email, contact.address, contact.postal, contact.contactNumber]
        .some(value => String(value || '').trim())
    )

    editorState.draft.contacts = cleanedContacts.length ? cleanedContacts : [createContactDraft()]

    if (editorState.mode === 'add') {
      companies.push(clone(editorState.draft))
    } else {
      companies = companies.map(company =>
        company.id === editorState.originalId ? clone(editorState.draft) : company
      )
    }

    saveCompanies(companies)
    closeEditor()
    renderCompanies()
  }
})

renderCompanies()
renderEditor()
