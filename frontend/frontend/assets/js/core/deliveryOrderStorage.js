import { ensureDemoData } from './demoData.js'

const DRAFT_KEY = 'maxgreen-delivery-order-drafts'

function parse(key, fallback) {
  ensureDemoData()
  try {
    const value = JSON.parse(localStorage.getItem(key))
    return value ?? fallback
  } catch {
    return fallback
  }
}

export function getDeliveryOrderDraft(emailId) {
  const drafts = parse(DRAFT_KEY, {})
  return drafts[emailId] || null
}

export function saveDeliveryOrderDraft(emailId, draft) {
  const drafts = parse(DRAFT_KEY, {})
  drafts[emailId] = draft
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts))
}

export function removeDeliveryOrderDraft(emailId) {
  const drafts = parse(DRAFT_KEY, {})
  delete drafts[emailId]
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts))
}
