import { escapeHtml } from '../core/quotationUtils.js'

export function attachmentRecord(value) {
  if (value && typeof value === 'object') {
    return {
      name: String(value.name || value.fileName || 'Attachment'),
      url: value.url || value.href || ''
    }
  }
  return { name: String(value || 'Attachment'), url: '' }
}

export function attachmentHref(value) {
  const attachment = attachmentRecord(value)
  if (attachment.url) return attachment.url
  return `./attachment-viewer.html?name=${encodeURIComponent(attachment.name)}`
}

export function renderAttachmentLinks(attachments = []) {
  if (!attachments.length) return '<span class="attachment">No attachments</span>'

  return attachments.map(value => {
    const attachment = attachmentRecord(value)
    return `<a class="attachment attachment-link" href="${escapeHtml(attachmentHref(value))}" target="_blank" rel="noopener noreferrer" title="Open attachment in a new tab">📎 ${escapeHtml(attachment.name)} ↗</a>`
  }).join('')
}

export function attachmentNames(attachments = []) {
  return attachments.map(value => attachmentRecord(value).name)
}
