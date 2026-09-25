import { apiJson } from '../core/api.js'
import { formatDateTimeSGT, sgtDateKey } from '../core/dateTime.js'
import { escapeHtml } from '../core/utils.js'
import { routeForCategory } from '../core/workflowCategory.js'
import { upsertGmailWorkflowMessage } from '../core/gmailWorkflowBridge.js'

const searchInput = document.getElementById('inbox-search')
const categoryFilter = document.getElementById('category-filter')
const dateFilter = document.getElementById('date-filter')
const tableBody = document.getElementById('inbox-body')
const tabs = [...document.querySelectorAll('[data-party]')]
const syncButton = document.getElementById('sync-inbox')
const classifyButton = document.getElementById('classify-inbox')
const syncStatus = document.getElementById('sync-status')

let messages = []
const preparingMessageIds = new Set()

function viewUrl(item) {
  const category = item.ai_category || 'Others'
  if (category === 'Quotation' || category === 'Invoice & DO') {
    return routeForCategory(category, item.gmail_message_id)
  }
  return `./gmail-message.html?id=${encodeURIComponent(item.gmail_message_id)}`
}

const CURRENT_QUOTATION_EXTRACTION_VERSION = 4

function hasCurrentWorkflowExtraction(item) {
  const category = item?.ai_category || 'Others'
  if (category === 'Quotation') {
    const draft = item?.ai_quotation_draft
    const version = Number(draft?.extraction_version || 0)
    return Boolean(
      draft
      && typeof draft === 'object'
      && Array.isArray(draft.items)
      && version >= CURRENT_QUOTATION_EXTRACTION_VERSION
    )
  }
  if (category === 'Invoice & DO') {
    return Array.isArray(item?.ai_quotation_references) && item.ai_quotation_references.length > 0
  }
  return true
}

function prepareLocalWorkflowDrafts() {
  // Always mirror business workflow emails into the browser workflow store.
  // If Claude extraction is present, it is used. If it is temporarily unavailable,
  // the bridge creates a conservative editable fallback from the real email instead
  // of blocking View with a gateway error.
  messages.forEach(item => {
    const category = item.ai_category || 'Others'
    if (category === 'Quotation' || category === 'Invoice & DO') {
      upsertGmailWorkflowMessage(item)
    }
  })
}

async function prepareWorkflowAndNavigate(event, item) {
  const category = item.ai_category || 'Others'
  if (category !== 'Quotation' && category !== 'Invoice & DO') return

  event.preventDefault()

  if (preparingMessageIds.has(item.gmail_message_id)) return
  preparingMessageIds.add(item.gmail_message_id)

  let prepared = item
  const failureKey = `maxgreen-ai-prep-failed:${item.gmail_message_id}`
  const lastFailure = Number(sessionStorage.getItem(failureKey) || 0)
  const recentlyFailed = lastFailure && Date.now() - lastFailure < 60_000

  try {
    // Older records may have a category but no structured extraction. Try Claude
    // once, but never make document review depend on that network call succeeding.
    if (!hasCurrentWorkflowExtraction(item) && !recentlyFailed) {
      syncStatus.textContent = category === 'Quotation'
        ? 'Claude is preparing quotation details from the email…'
        : 'Reading the PO and finding its Quote Ref…'
      syncStatus.className = 'sync-status'

      try {
        await apiJson(`/api/ai/classify/${encodeURIComponent(item.gmail_message_id)}`, { method: 'POST' })
        const refreshed = await apiJson(`/api/gmail/messages/${encodeURIComponent(item.gmail_message_id)}`)
        prepared = refreshed.message || item
        const index = messages.findIndex(message => message.gmail_message_id === item.gmail_message_id)
        if (index >= 0) messages[index] = prepared
        sessionStorage.removeItem(failureKey)
      } catch (error) {
        // Do not trap the user in the Inbox. Open an editable fallback draft made
        // from the real Gmail message and allow a manual correction. Retry is
        // suppressed for 60 seconds to avoid a burst of repeated 502 requests.
        console.error('AI document preparation failed:', error)
        sessionStorage.setItem(failureKey, String(Date.now()))
        prepared = item
      }
    }

    upsertGmailWorkflowMessage(prepared)
    window.location.href = routeForCategory(prepared.ai_category || category, prepared.gmail_message_id)
  } finally {
    preparingMessageIds.delete(item.gmail_message_id)
  }
}


function setLoading(message = 'Loading stored Gmail messages…') {
  tableBody.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(message)}</td></tr>`
}

function populateDates() {
  const current = dateFilter.value
  const dateValues = [...new Set(messages.map(item => sgtDateKey(item.received_at)).filter(Boolean))].sort().reverse()
  dateFilter.innerHTML = '<option value="All">All dates</option>'

  dateValues.forEach(value => {
    const item = messages.find(message => sgtDateKey(message.received_at) === value)
    const option = document.createElement('option')
    option.value = value
    option.textContent = item ? formatDateTimeSGT(item.received_at).split(' ')[0] : value
    dateFilter.appendChild(option)
  })

  if ([...dateFilter.options].some(option => option.value === current)) {
    dateFilter.value = current
  }
}

function filteredRows() {
  const search = searchInput.value.trim().toLowerCase()
  const category = categoryFilter.value
  const date = dateFilter.value

  return messages
    .filter(item => {
      if (!search) return true
      return [item.sender, item.sender_email, item.subject]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(search))
    })
    .filter(item => category === 'All' || (item.ai_category || 'Unclassified') === category)
    .filter(item => date === 'All' || sgtDateKey(item.received_at) === date)
    .filter(item => (item.ai_party_type || 'Unknown') !== 'Supplier' && (item.ai_category || '') !== 'Supplier Payable')
}

function categoryChip(item) {
  const category = item.ai_category || 'Unclassified'
  const security = item.ai_security_status || 'Pending'
  const warning = ['Prompt Injection', 'Spam', 'Suspicious'].includes(security)
  const cls = category === 'Unclassified' ? 'chip-unclassified' : warning ? 'chip-warning' : 'chip-classified'
  const suffix = warning ? ` · ${security}` : ''
  return `<span class="chip ${cls}" title="${escapeHtml(item.ai_reason || '')}">${escapeHtml(category + suffix)}</span>`
}

function renderRows() {
  const rows = filteredRows()

  if (!rows.length) {
    tableBody.innerHTML = '<tr><td colspan="5" class="empty-state">No matching Gmail messages.</td></tr>'
    return
  }

  tableBody.innerHTML = rows.map(item => {
    const href = viewUrl(item)
    const senderEmail = item.sender_email || item.sender || 'Unknown sender'
    const senderName = item.sender && item.sender !== item.sender_email ? item.sender : ''

    return `
      <tr>
        <td>
          <a class="sender-link" data-message-id="${escapeHtml(item.gmail_message_id)}" href="${href}">${escapeHtml(senderEmail)}</a>
          ${senderName ? `<div class="sender-name">${escapeHtml(senderName)}</div>` : ''}
        </td>
        <td>${escapeHtml(item.subject || '(No subject)')}</td>
        <td>${categoryChip(item)}</td>
        <td>${escapeHtml(formatDateTimeSGT(item.received_at))}</td>
        <td class="view-cell"><a class="view-link" data-message-id="${escapeHtml(item.gmail_message_id)}" href="${href}">View</a></td>
      </tr>
    `
  }).join('')

  tableBody.querySelectorAll('a[data-message-id]').forEach(link => {
    link.addEventListener('click', event => {
      const item = messages.find(message => message.gmail_message_id === link.dataset.messageId)
      if (item) prepareWorkflowAndNavigate(event, item)
    })
  })
}

async function loadStoredMessages() {
  setLoading()
  try {
    const data = await apiJson('/api/gmail/messages?limit=100')
    messages = data.messages || []
    prepareLocalWorkflowDrafts()
    populateDates()
    renderRows()
    syncStatus.textContent = `${messages.length} stored Gmail message${messages.length === 1 ? '' : 's'}`
    syncStatus.className = 'sync-status ok'
  } catch (error) {
    messages = []
    tableBody.innerHTML = `<tr><td colspan="5" class="empty-state error-state">Could not reach the local backend: ${escapeHtml(error.message)}</td></tr>`
    syncStatus.textContent = 'Backend not reachable'
    syncStatus.className = 'sync-status bad'
  }
}

async function syncGmail() {
  syncButton.disabled = true
  syncButton.textContent = 'Syncing…'
  syncStatus.textContent = 'Checking Gmail…'
  syncStatus.className = 'sync-status'

  try {
    const result = await apiJson(`/api/gmail/sync?limit=100&query=${encodeURIComponent('in:inbox')}`, { method: 'POST' })
    await loadStoredMessages()

    const ai = result.ai || {}
    const processed = Number(ai.processed || 0)
    const failed = Number(ai.failed || 0)
    if (ai.skipped_reason) {
      syncStatus.textContent = `Fetched ${result.fetched}. AI skipped: ${ai.skipped_reason}`
      syncStatus.className = 'sync-status bad'
    } else if (failed) {
      syncStatus.textContent = `Fetched ${result.fetched}. AI prepared ${processed - failed}; ${failed} need retry.`
      syncStatus.className = 'sync-status bad'
    } else {
      syncStatus.textContent = `Fetched ${result.fetched}. AI automatically prepared ${processed} message${processed === 1 ? '' : 's'}.`
      syncStatus.className = 'sync-status ok'
    }
  } catch (error) {
    syncStatus.textContent = `Sync failed: ${error.message}`
    syncStatus.className = 'sync-status bad'
  } finally {
    syncButton.disabled = false
    syncButton.textContent = 'Sync Gmail'
  }
}

async function classifyUnclassified() {
  classifyButton.disabled = true
  classifyButton.textContent = 'Classifying…'
  syncStatus.textContent = 'Sending unclassified messages to Claude…'
  syncStatus.className = 'sync-status'

  try {
    const result = await apiJson('/api/ai/classify-unclassified?limit=10', { method: 'POST' })
    const failures = (result.results || []).filter(item => !item.ok).length
    syncStatus.textContent = failures
      ? `Classified ${result.processed - failures}; ${failures} failed`
      : `Classified ${result.processed} message${result.processed === 1 ? '' : 's'}`
    syncStatus.className = failures ? 'sync-status bad' : 'sync-status ok'
    await loadStoredMessages()
  } catch (error) {
    syncStatus.textContent = `Classification failed: ${error.message}`
    syncStatus.className = 'sync-status bad'
  } finally {
    classifyButton.disabled = false
    classifyButton.textContent = 'Classify Unclassified'
  }
}

searchInput.addEventListener('input', renderRows)
categoryFilter.addEventListener('change', renderRows)
dateFilter.addEventListener('change', renderRows)
syncButton.addEventListener('click', syncGmail)
classifyButton.addEventListener('click', classifyUnclassified)

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.party === 'supplier') {
      window.location.href = './supplier-payable.html'
      return
    }
    tabs.forEach(item => item.classList.toggle('active', item === tab))
    renderRows()
  })
})

loadStoredMessages()
