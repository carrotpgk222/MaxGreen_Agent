import { API_BASE, apiJson } from '../core/api.js'
import { formatDateTimeSGT } from '../core/dateTime.js'
import { escapeHtml, getQueryParam } from '../core/utils.js'

const messageId = getQueryParam('id')
const title = document.getElementById('message-title')
const from = document.getElementById('message-from')
const fromEmail = document.getElementById('message-from-email')
const received = document.getElementById('message-received')
const body = document.getElementById('message-body')
const attachmentList = document.getElementById('message-attachments')
const openGmail = document.getElementById('open-gmail')
const toggleBody = document.getElementById('toggle-message-body')

if (toggleBody) {
  toggleBody.addEventListener('click', () => {
    body.hidden = !body.hidden
    toggleBody.textContent = body.hidden ? 'Show email body' : 'Hide email body'
    toggleBody.setAttribute('aria-expanded', body.hidden ? 'false' : 'true')
  })
}

function fail(message) {
  title.textContent = 'Message not available'
  body.textContent = message
  attachmentList.innerHTML = '<span class="attachment-empty">No attachments available.</span>'
  openGmail.hidden = true
}

async function loadMessage() {
  if (!messageId) {
    fail('No Gmail message ID was provided.')
    return
  }

  try {
    const data = await apiJson(`/api/gmail/messages/${encodeURIComponent(messageId)}`)
    const message = data.message

    title.textContent = message.subject || '(No subject)'
    from.textContent = message.sender || message.sender_email || 'Unknown sender'
    fromEmail.textContent = message.sender_email || ''
    received.textContent = formatDateTimeSGT(message.received_at)
    body.textContent = message.body_text || message.snippet || '(No readable email body)'

    const classification = document.getElementById('message-classification')
    if (classification) {
      const category = message.ai_category || 'Unclassified'
      const party = message.ai_party_type || 'Unknown'
      const security = message.ai_security_status || 'Pending'
      const confidence = Number.isFinite(Number(message.ai_confidence))
        ? `${Math.round(Number(message.ai_confidence) * 100)}%`
        : '—'
      classification.innerHTML = `
        <strong>${escapeHtml(category)}</strong>
        <span>Party: ${escapeHtml(party)}</span>
        <span>Security: ${escapeHtml(security)}</span>
        <span>Confidence: ${escapeHtml(confidence)}</span>
        ${message.ai_reason ? `<small>${escapeHtml(message.ai_reason)}</small>` : ''}
      `
    }

    const gmailTarget = message.thread_id || message.gmail_message_id
    openGmail.href = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(gmailTarget)}`

    const attachments = message.attachments || []
    if (!attachments.length) {
      attachmentList.innerHTML = '<span class="attachment-empty">No attachments</span>'
      return
    }

    attachmentList.innerHTML = attachments.map(item => {
      const filename = item.filename || 'attachment'
      const attachmentId = item.attachment_id || ''
      if (!attachmentId) {
        return `<span class="attachment-card">📎 ${escapeHtml(filename)}</span>`
      }

      const href = `${API_BASE}/api/gmail/messages/${encodeURIComponent(message.gmail_message_id)}/attachments/${encodeURIComponent(attachmentId)}?filename=${encodeURIComponent(filename)}`
      return `
        <a class="attachment-card attachment-link" href="${href}" target="_blank" rel="noopener">
          <span>📎</span>
          <span>
            <strong>${escapeHtml(filename)}</strong>
            <small>${escapeHtml(item.mime_type || 'Attachment')}</small>
          </span>
          <span>↗</span>
        </a>
      `
    }).join('')
  } catch (error) {
    fail(`Could not load this Gmail message: ${error.message}`)
  }
}

loadMessage()
