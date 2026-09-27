import { getReceivables, saveReceivables, calculatePayments, upsertReceivableFromCompletedInvoice } from '../core/receivableStorage.js'
import { getCompanies } from '../core/customerStorage.js'
import { getEmails, saveEmails } from '../core/storage.js'
import { saveSoaDraft } from '../core/soaStorage.js'
import { buildSoa } from '../core/soaUtils.js'
import { escapeHtml } from '../core/utils.js'

const $ = id => document.getElementById(id)

// Keep Customer Receivable in sync with every completed customer invoice.
// This also repairs older browser state where an invoice was completed before
// receivable creation was added.
getEmails()
  .filter(item => item.category === 'Invoice' && item.status === 'Completed' && !item.referenceOnly)
  .forEach(item => upsertReceivableFromCompletedInvoice(item))

const search = $('receivable-search'), statusFilter = $('receivable-status-filter'), dateFilter = $('receivable-date-filter'), body = $('receivable-body')
let selectedCompany = null
function money(v) { return Number(v || 0).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function showDate(v) { if (!v) return '—'; const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : v }
function rows() { return getReceivables() }
function refreshDates() { const current = dateFilter.value; const dates = [...new Set(rows().map(r => r.sentEmailOn).filter(Boolean))].sort().reverse(); dateFilter.innerHTML = '<option value="All">All dates</option>' + dates.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(showDate(d))}</option>`).join(''); if (dates.includes(current)) dateFilter.value = current }
function render() { refreshDates(); const q = search.value.trim().toLowerCase(), st = statusFilter.value, dt = dateFilter.value; const data = rows().filter(r => st === 'All' || r.status === st).filter(r => dt === 'All' || r.sentEmailOn === dt).filter(r => !q || [r.invoiceNo, r.company].join(' ').toLowerCase().includes(q)); body.innerHTML = data.length ? data.map(r => { const calc = calculatePayments(r); return `<tr><td><a class="invoice-link" href="./invoice-receivable.html?id=${encodeURIComponent(r.id)}">${escapeHtml(r.invoiceNo)}</a></td><td>${escapeHtml(r.company)}</td><td>${escapeHtml(showDate(r.sentEmailOn))}</td><td class="receivable-balance">$${money(calc.balance)}</td><td><select class="receivable-status" data-status-id="${escapeHtml(r.id)}"><option ${r.status === 'Paid' ? 'selected' : ''}>Paid</option><option ${r.status === 'Not Fully Paid' ? 'selected' : ''}>Not Fully Paid</option><option ${r.status === 'Not Paid' ? 'selected' : ''}>Not Paid</option></select></td></tr>` }).join('') : '<tr><td colspan="5" class="empty-state">No completed invoice receivables yet.</td></tr>' }
body.addEventListener('change', e => { const select = e.target.closest('[data-status-id]'); if (!select) return; const list = rows(), row = list.find(r => r.id === select.dataset.statusId); if (row) { row.status = select.value; row.statusManuallySet = true; saveReceivables(list); render() } })
  ;[search, statusFilter, dateFilter].forEach(el => el.addEventListener(el === search ? 'input' : 'change', render))

const modal = $('soa-modal'), companySearch = $('soa-company-search'), options = $('soa-company-options')
function companiesWithReceivables() { const ids = new Set(rows().map(r => r.companyId).filter(Boolean)); const names = new Set(rows().map(r => r.company)); return getCompanies().filter(c => ids.has(c.id) || names.has(c.companyName)) }
function renderCompanyOptions() { const q = companySearch.value.trim().toLowerCase(); const matches = companiesWithReceivables().filter(c => !q || c.companyName.toLowerCase().includes(q)); options.innerHTML = matches.length ? matches.map(c => `<button type="button" class="soa-company-option" data-company="${escapeHtml(c.id)}">${escapeHtml(c.companyName)}</button>`).join('') : '<div class="soa-company-option">No receivable company found</div>'; options.hidden = false }
function openModal() { selectedCompany = null; companySearch.value = ''; $('soa-from').value = ''; $('soa-to').value = ''; $('soa-error').hidden = true; modal.hidden = false; document.body.classList.add('modal-open') }
function closeModal() { modal.hidden = true; options.hidden = true; document.body.classList.remove('modal-open') }
$('open-soa').addEventListener('click', openModal); document.querySelectorAll('[data-close-soa]').forEach(el => el.addEventListener('click', closeModal)); companySearch.addEventListener('focus', renderCompanyOptions); companySearch.addEventListener('input', () => { selectedCompany = null; renderCompanyOptions() }); options.addEventListener('mousedown', e => e.preventDefault()); options.addEventListener('click', e => { const b = e.target.closest('[data-company]'); if (!b) return; selectedCompany = getCompanies().find(c => c.id === b.dataset.company); if (selectedCompany) { companySearch.value = selectedCompany.companyName; options.hidden = true } })
$('generate-soa').addEventListener('click', () => { const from = $('soa-from').value, to = $('soa-to').value, error = $('soa-error'); if (!selectedCompany || !from || !to || from > to) { error.textContent = 'Select a company and a valid From / To date range.'; error.hidden = false; return } const draft = buildSoa(selectedCompany.id, selectedCompany.companyName, from, to); if (!draft.transactions.length) { error.textContent = 'No invoices or payments were found for this company in the selected date range.'; error.hidden = false; return } const contact = selectedCompany.contacts?.[0] || {}; const emailId = `soa-generated-${Date.now()}`; let emails = getEmails(); emails.push({ id: emailId, partyType: 'customer', subject: `Statement of Account - ${selectedCompany.companyName}`, category: 'Statement of Account', originalCategory: 'Statement of Account', section: 'customer-receivable', receivedDate: to, status: 'Pending', pendingAt: new Date().toISOString(), body: `Generated Statement of Account for ${from} to ${to}.`, attachments: [], from: contact.email || '', amount: draft.balance }); saveEmails(emails); const created = getEmails().find(e => e.id === emailId); draft.documentId = created?.documentId || ''; draft.fileName = created?.fileName || `${draft.documentId}.pdf`; draft.generatedAt = new Date().toISOString(); saveSoaDraft(emailId, draft); closeModal(); window.location.href = './pending.html' })
render()
