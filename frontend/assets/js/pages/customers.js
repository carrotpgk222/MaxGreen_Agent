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
    ].some(value =>
      String(value || '').toLowerCase().includes(query)
    )
  })

  if (!filtered.length) {
    list.innerHTML = `
      <div
        class="company-empty"
        style="
          padding: 50px 32px;
          text-align: center;
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid #e2e8f0;
          border-radius: 20px;
          color: #64748b;
        "
      >
        No companies found.
      </div>
    `
    return
  }

  list.innerHTML = filtered.map(company => {
    const isSupplier = company.type === 'Supplier'

    const companyInitial = String(company.companyName || '?')
      .trim()
      .charAt(0)
      .toUpperCase()

    const contactCount = company.contacts.length

    return `
      <article
        class="company-block ${isSupplier ? 'company-block-supplier' : 'company-block-client'}"
        data-company-id="${escapeHtml(company.id)}"
        style="
          width: 100%;
          margin-bottom: 24px;
          overflow: hidden;

          background:
            linear-gradient(
              235deg,
              #EEF2FF 0%,
              #FFFFFF 50%,
              #F5F3FF 100%
            );

          border: 1px solid #E2E8F0;
          border-radius: 20px;

          box-shadow:
            0 4px 24px rgba(79, 70, 229, 0.07);
        "
      >

        <!-- ================================
             COMPANY HEADER
        ================================= -->

        <header
          class="company-block-header"
          style="
            width: 100%;
            min-height: 88px;

            padding: 20px 28px;

            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 24px;

            background:
              linear-gradient(
                235deg,
                rgba(238, 242, 255, 0.95) 0%,
                rgba(255, 255, 255, 0.92) 52%,
                rgba(245, 243, 255, 0.95) 100%
              );

            border-bottom: 1px solid #E2E8F0;
          "
        >

          <!-- LEFT SIDE -->

          <div
            class="company-heading"
            style="
              min-width: 0;

              display: flex;
              align-items: center;
              gap: 16px;
            "
          >

            <!-- COMPANY AVATAR -->

            <div
              class="company-avatar"
              aria-hidden="true"
              style="
                width: 44px;
                height: 44px;
                flex-shrink: 0;

                display: flex;
                align-items: center;
                justify-content: center;

                color: white;

                background:
                  ${isSupplier
        ? 'linear-gradient(135deg, #EC4899, #8B5CF6)'
        : 'linear-gradient(135deg, #4F46E5, #7C3AED)'};

                border-radius: 50%;

                box-shadow:
                  0 5px 14px rgba(79, 70, 229, 0.18);

                font-size: 15px;
                font-weight: 700;
              "
            >
              ${escapeHtml(companyInitial)}
            </div>


            <!-- COMPANY DETAILS -->

            <div
              class="company-heading-content"
              style="
                min-width: 0;

                display: flex;
                flex-direction: column;
                gap: 7px;
              "
            >

              <div
                class="company-title-row"
                style="
                  display: flex;
                  align-items: center;
                  flex-wrap: wrap;
                  gap: 9px;
                "
              >

                <h2
                  class="company-title"
                  style="
                    margin: 0;

                    color: #0F172A;

                    font-size: 17px;
                    line-height: 1.2;
                    font-weight: 700;
                  "
                >
                  ${escapeHtml(company.companyName)}
                </h2>


                <!-- TYPE BADGE -->

                <span
                  class="company-type-badge"
                  style="
                    display: inline-flex;
                    align-items: center;

                    padding: 4px 10px;

                    color:
                      ${isSupplier ? '#7C3AED' : '#3B82F6'};

                    background:
                      ${isSupplier ? '#F5F3FF' : '#EFF6FF'};

                    border-radius: 999px;

                    font-size: 11px;
                    line-height: 1;
                    font-weight: 600;
                  "
                >
                  ${escapeHtml(company.type)}
                </span>

              </div>


              <!-- CONTACT COUNT -->

              <div
                class="company-meta"
                style="
                  display: flex;
                  align-items: center;
                  gap: 8px;

                  color: #94A3B8;

                  font-size: 12px;
                "
              >

                <span class="company-contact-count">
                  ${contactCount}
                  ${contactCount === 1 ? 'contact' : 'contacts'}
                </span>

              </div>

            </div>

          </div>


          <!-- RIGHT SIDE / EDIT -->

          <div
            class="company-header-actions"
            style="
              margin-left: auto;
              flex-shrink: 0;

              display: flex;
              align-items: center;
              justify-content: flex-end;
            "
          >

            <button
              class="company-edit-button"
              type="button"
              data-edit-company="${escapeHtml(company.id)}"
              style="
                min-width: 82px;
                height: 36px;

                padding: 0 17px;

                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 7px;

                color: white;

                background:
                  ${isSupplier
        ? 'linear-gradient(135deg, #EC4899, #8B5CF6)'
        : 'linear-gradient(135deg, #4F46E5, #7C3AED)'};

                border: 0;
                border-radius: 9px;

                box-shadow:
                  0 3px 10px rgba(79, 70, 229, 0.20);

                font-size: 12px;
                font-weight: 600;

                cursor: pointer;
              "
            >

              <span
                class="company-edit-icon"
                aria-hidden="true"
                style="
                  font-size: 13px;
                  line-height: 1;
                "
              >
                ✎
              </span>

              <span>Edit</span>

            </button>

          </div>

        </header>


        <!-- ================================
             CONTACT TABLE
        ================================= -->

        <div
          class="company-table-wrap"
          style="
            padding: 0 20px 20px;
          "
        >

          <div
            style="
              overflow: hidden;

              background: rgba(255, 255, 255, 0.8);

              border: 1px solid #E2E8F0;
              border-radius: 14px;
            "
          >

            <table
              class="company-table"
              style="
                width: 100%;
                border-collapse: collapse;
              "
            >

              <thead>

                <tr
                  style="
                    height: 46px;
                    background: #F1F5F9;
                  "
                >

                  <th
                    style="
                      padding: 0 18px;
                      text-align: left;
                    "
                  >
                    Name (Attn)
                  </th>

                  <th
                    style="
                      padding: 0 18px;
                      text-align: left;
                    "
                  >
                    Email
                  </th>

                  <th
                    style="
                      padding: 0 18px;
                      text-align: left;
                    "
                  >
                    Address
                  </th>

                  <th
                    style="
                      padding: 0 18px;
                      text-align: left;
                    "
                  >
                    Postal
                  </th>

                  <th
                    style="
                      padding: 0 18px;
                      text-align: left;
                    "
                  >
                    Contact No.
                  </th>

                  <th
                    class="company-action-column"
                    aria-label="Actions"
                    style="
                      width: 64px;
                      padding: 0 16px;
                    "
                  ></th>

                </tr>

              </thead>


              <tbody>

                ${company.contacts.map(contact => {

          const contactInitial = String(contact.name || '?')
            .trim()
            .charAt(0)
            .toUpperCase()

          return `
                    <tr
                      style="
                        min-height: 64px;
                        background: rgba(255, 255, 255, 0.75);
                        border-top: 1px solid #F1F5F9;
                      "
                    >

                      <!-- NAME -->

                      <td
                        style="
                          padding: 15px 18px;
                        "
                      >

                        <div
                          class="contact-name-cell"
                          style="
                            display: flex;
                            align-items: center;
                            gap: 11px;
                          "
                        >

                          <div
                            class="contact-avatar"
                            aria-hidden="true"
                            style="
                              width: 30px;
                              height: 30px;
                              flex-shrink: 0;

                              display: flex;
                              align-items: center;
                              justify-content: center;

                              color: #6366F1;
                              background: #EEF2FF;

                              border-radius: 50%;

                              font-size: 11px;
                              font-weight: 700;
                            "
                          >
                            ${escapeHtml(contactInitial)}
                          </div>

                          <span
                            class="${contact.name ? '' : 'empty-value'}"
                            style="
                              color: ${contact.name ? '#0F172A' : '#CBD5E1'};
                              font-size: 13px;
                              font-weight: 500;
                            "
                          >
                            ${contact.name
              ? escapeHtml(contact.name)
              : 'Not provided'
            }
                          </span>

                        </div>

                      </td>


                      <!-- EMAIL -->

                      <td
                        style="
                          padding: 15px 18px;
                          color: #64748B;
                          font-size: 13px;
                        "
                      >
                        ${contact.email
              ? escapeHtml(contact.email)
              : '<span class="empty-value" style="color:#CBD5E1;">—</span>'
            }
                      </td>


                      <!-- ADDRESS -->

                      <td
                        style="
                          padding: 15px 18px;
                          color: #64748B;
                          font-size: 13px;
                        "
                      >
                        ${contact.address
              ? escapeHtml(contact.address)
              : '<span class="empty-value" style="color:#CBD5E1;">—</span>'
            }
                      </td>


                      <!-- POSTAL -->

                      <td
                        style="
                          padding: 15px 18px;
                          color: #64748B;
                          font-size: 13px;
                        "
                      >
                        ${contact.postal
              ? escapeHtml(contact.postal)
              : '<span class="empty-value" style="color:#CBD5E1;">—</span>'
            }
                      </td>


                      <!-- CONTACT -->

                      <td
                        style="
                          padding: 15px 18px;
                          color: #64748B;
                          font-size: 13px;
                        "
                      >
                        ${contact.contactNumber
              ? escapeHtml(contact.contactNumber)
              : '<span class="empty-value" style="color:#CBD5E1;">—</span>'
            }
                      </td>


                      <!-- DELETE -->

                      <td
                        class="company-action-column"
                        style="
                          padding: 12px 16px;
                          text-align: right;
                        "
                      >

                        <button
                          class="company-delete-button"
                          type="button"
                          data-delete-contact="${escapeHtml(contact.id)}"
                          data-company-id="${escapeHtml(company.id)}"
                          title="Delete contact"
                          aria-label="Delete ${escapeHtml(contact.name || 'contact')}"
                          style="
                            width: 34px;
                            height: 34px;

                            display: inline-flex;
                            align-items: center;
                            justify-content: center;

                            color: #EF4444;
                            background: #FEF2F2;

                            border: 1px solid #FECACA;
                            border-radius: 9px;

                            cursor: pointer;
                          "
                        >
                          🗑
                        </button>

                      </td>

                    </tr>
                  `
        }).join('')}

              </tbody>

            </table>

          </div>

        </div>

      </article>
    `
  }).join('')
}

function renderEditor() {
  if (!editorState) {
    editorHost.hidden = true
    editorHost.innerHTML = ''
    return
  }

  editorHost.hidden = false

  const draft = editorState.draft

  const companyInitial = String(draft.companyName || '+')
    .trim()
    .charAt(0)
    .toUpperCase()

  editorHost.innerHTML = `
    <article class="company-editor-card">

      <!-- TOP -->
      <div class="company-editor-topbar">

        <div class="company-editor-main">

          <!-- Company identity -->
          <div class="company-editor-identity">

            <div class="company-editor-avatar">
              ${escapeHtml(companyInitial)}
            </div>

            <div class="company-editor-name-group">
              <label for="editor-company-name">Company name</label>

              <input
                class="company-name-input"
                id="editor-company-name"
                type="text"
                value="${escapeHtml(draft.companyName)}"
                placeholder="Enter company name"
                aria-label="Company name"
              />
            </div>

          </div>


          <!-- Company type -->
          <div class="company-type-section">

            <span class="company-type-label">Company type</span>

            <div
              class="company-type-toggle-group"
              aria-label="Company type"
            >

              <button
                class="type-toggle ${draft.type === 'Supplier' ? 'is-active' : ''
    }"
                type="button"
                data-company-type="Supplier"
              >
                Supplier
              </button>

              <button
                class="type-toggle ${draft.type === 'Client' ? 'is-active' : ''
    }"
                type="button"
                data-company-type="Client"
              >
                Client
              </button>

            </div>

          </div>

        </div>


        <!-- Actions -->
        <div class="company-editor-actions">

          <button
            class="company-editor-button company-cancel-button"
            id="cancel-company"
            type="button"
          >
            Cancel
          </button>

          <button
            class="company-editor-button company-save-button"
            id="save-company"
            type="button"
          >
            Save
          </button>

        </div>

      </div>


      <!-- CONTACT SECTION -->
      <div class="company-editor-contacts">

        <div class="company-editor-section-header">

          <div>
            <h3>Contacts</h3>

            <p>
              Add the contact details associated with this company.
            </p>
          </div>

          <button
            class="company-add-row-button"
            id="add-contact-row"
            type="button"
          >
            <span aria-hidden="true">+</span>
            Add contact
          </button>

        </div>


        <div class="company-editor-table-wrap">

          <table class="company-table company-editor-table">

            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Address</th>
                <th>Postal</th>
                <th>Contact No.</th>
                <th aria-label="Delete"></th>
              </tr>
            </thead>

            <tbody id="editor-contact-rows">
              ${draft.contacts
      .map(contact => editorRow(contact))
      .join('')}
            </tbody>

          </table>

        </div>

      </div>

    </article>
  `
}

function editorRow(contact) {
  return `
    <tr data-editor-contact="${escapeHtml(contact.id)}">

      <td>
        <input
          data-contact-field="name"
          value="${escapeHtml(contact.name)}"
          placeholder="Name"
        />
      </td>

      <td>
        <input
          data-contact-field="email"
          type="email"
          value="${escapeHtml(contact.email)}"
          placeholder="Email"
        />
      </td>

      <td>
        <input
          data-contact-field="address"
          value="${escapeHtml(contact.address)}"
          placeholder="Address"
        />
      </td>

      <td>
        <input
          data-contact-field="postal"
          inputmode="numeric"
          pattern="[0-9]*"
          value="${escapeHtml(contact.postal)}"
          placeholder="Postal"
        />
      </td>

      <td>
        <input
          data-contact-field="contactNumber"
          inputmode="numeric"
          pattern="[0-9]*"
          value="${escapeHtml(contact.contactNumber)}"
          placeholder="Contact No."
        />
      </td>

      <td>

        <button
          class="company-delete-button"
          type="button"
          data-editor-delete-contact="${escapeHtml(contact.id)}"
          title="Delete row"
          aria-label="Delete row"
        >
          🗑
        </button>

      </td>

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
