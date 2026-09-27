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
    // `code` is the stable, machine-readable failure identifier and is carried on the
    // error so callers can branch on it. `detail` is the human message.
    const error = new Error(payload.detail || `HTTP ${response.status}`)
    error.code = payload.code || String(response.status)
    error.requestId = payload.request_id || ''
    error.status = response.status
    throw error
  }

  return payload
}
