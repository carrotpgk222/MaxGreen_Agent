import { API_BASE, apiJson } from '../core/api.js'
import { formatDateTimeSGT } from '../core/dateTime.js'
import { escapeHtml } from '../core/utils.js'

const statusEl = document.getElementById('status')
const syncResultEl = document.getElementById('sync-result')
const messagesEl = document.getElementById('messages')

async function refreshStatus() {
  statusEl.textContent = 'Checking local backend...'
  statusEl.className = ''
  try {
    const data = await apiJson('/api/gmail/status')
    if (data.connected) {
      statusEl.textContent = `Connected ✓  ${data.email}`
      statusEl.className = 'ok'
    } else {
      statusEl.textContent = `Not connected — ${data.message || 'Run connect_gmail.bat'}`
      statusEl.className = 'bad'
    }
  } catch (err) {
    statusEl.textContent = `Backend not reachable at ${API_BASE}. (${err.message})`
    statusEl.className = 'bad'
  }
}

async function syncGmail() {
  syncResultEl.textContent = 'Syncing...'
  try {
    const data = await apiJson(`/api/gmail/sync?limit=25&query=${encodeURIComponent('in:inbox')}`, { method: 'POST' })
    syncResultEl.textContent = `Fetched ${data.fetched} messages. Stored total: ${data.stored_messages}.`
    await loadMessages()
  } catch (err) {
    syncResultEl.textContent = `Sync failed: ${err.message}`
  }
}

async function loadMessages() {
  try {
    const data = await apiJson('/api/gmail/messages?limit=25')
    const messages = data.messages || []
    if (!messages.length) {
      messagesEl.innerHTML = '<tr><td colspan="4">No synced messages yet.</td></tr>'
      return
    }
    messagesEl.innerHTML = messages.map(m => `
      <tr>
        <td><strong>${escapeHtml(m.sender || m.sender_email || '')}</strong><br><small>${escapeHtml(m.sender_email || '')}</small></td>
        <td>${escapeHtml(m.subject || '')}</td>
        <td>${escapeHtml(formatDateTimeSGT(m.received_at))}</td>
        <td>${(m.attachments || []).length}</td>
      </tr>
    `).join('')
  } catch (err) {
    messagesEl.innerHTML = `<tr><td colspan="4">Could not load messages: ${escapeHtml(err.message)}</td></tr>`
  }
}

document.getElementById('refresh-status').addEventListener('click', refreshStatus)
document.getElementById('sync').addEventListener('click', syncGmail)
document.getElementById('load').addEventListener('click', loadMessages)

refreshStatus()
