export const API_BASE = 'http://127.0.0.1:8000'

export async function apiJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options)
  let payload = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok) {
    throw new Error(payload.detail || `HTTP ${response.status}`)
  }

  return payload
}
