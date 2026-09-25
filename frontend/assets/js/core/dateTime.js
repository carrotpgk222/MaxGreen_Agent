function toDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function partsForSGT(value, includeTime = false) {
  const date = toDate(value)
  if (!date) return null

  const options = {
    timeZone: 'Asia/Singapore',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }

  if (includeTime) {
    options.hour = '2-digit'
    options.minute = '2-digit'
    options.hour12 = false
  }

  const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value || ''

  return {
    day: get('day'),
    month: get('month'),
    year: get('year'),
    hour: get('hour'),
    minute: get('minute')
  }
}

export function formatDateSGT(value) {
  const parts = partsForSGT(value, false)
  if (!parts) return '—'
  return `${parts.day}/${parts.month}/${parts.year}`
}

export function formatDateTimeSGT(value) {
  const parts = partsForSGT(value, true)
  if (!parts) return '—'
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`
}

export function sgtDateKey(value) {
  const parts = partsForSGT(value, false)
  if (!parts) return ''
  return `${parts.year}-${parts.month}-${parts.day}`
}
