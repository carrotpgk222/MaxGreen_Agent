// Local Live Server dev talks to the backend directly (CORS allows localhost).
// When served through nginx, use same-origin /api so requests go via the proxy.
const isLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname)

export const API_BASE = isLocalDev ? 'http://127.0.0.1:8000' : ''

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
