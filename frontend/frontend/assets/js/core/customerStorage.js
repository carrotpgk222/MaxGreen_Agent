import { ensureDemoData } from './demoData.js'

const STORAGE_KEY = 'maxgreen_companies_v1'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function getCompanies() {
  ensureDemoData()
  const stored = localStorage.getItem(STORAGE_KEY)

  try {
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveCompanies(companies) {
  ensureDemoData()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(companies))
}

export function createCompanyDraft() {
  return {
    id: `company-${Date.now()}`,
    companyName: '',
    type: 'Supplier',
    contacts: [createContactDraft()]
  }
}

export function createContactDraft(seed = {}) {
  return {
    id: seed.id || `contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: seed.name || '',
    email: seed.email || '',
    address: seed.address || '',
    postal: seed.postal || '',
    contactNumber: seed.contactNumber || ''
  }
}
