const API = "http://127.0.0.1:8000";

const statusEl = document.getElementById("status");
const syncResultEl = document.getElementById("sync-result");
const messagesEl = document.getElementById("messages");

async function getJson(url, options) {
  const res = await fetch(url, options);
  let payload;
  try { payload = await res.json(); } catch { payload = {}; }
  if (!res.ok) throw new Error(payload.detail || `HTTP ${res.status}`);
  return payload;
}

async function refreshStatus() {
  statusEl.textContent = "Checking local backend...";
  statusEl.className = "";
  try {
    const data = await getJson(`${API}/api/gmail/status`);
    if (data.connected) {
      statusEl.textContent = `Connected ✓  ${data.email}`;
      statusEl.className = "ok";
    } else {
      statusEl.textContent = `Not connected — ${data.message || "Run connect_gmail.bat"}`;
      statusEl.className = "bad";
    }
  } catch (err) {
    statusEl.textContent = `Backend not reachable. Start backend/start_backend.bat. (${err.message})`;
    statusEl.className = "bad";
  }
}

async function syncGmail() {
  syncResultEl.textContent = "Syncing...";
  try {
    const data = await getJson(`${API}/api/gmail/sync?limit=25&query=${encodeURIComponent("in:inbox")}`, { method: "POST" });
    syncResultEl.textContent = `Fetched ${data.fetched} messages. Stored total: ${data.stored_messages}.`;
    await loadMessages();
  } catch (err) {
    syncResultEl.textContent = `Sync failed: ${err.message}`;
  }
}

async function loadMessages() {
  try {
    const data = await getJson(`${API}/api/gmail/messages?limit=25`);
    const messages = data.messages || [];
    if (!messages.length) {
      messagesEl.innerHTML = '<tr><td colspan="4">No synced messages yet.</td></tr>';
      return;
    }
    messagesEl.innerHTML = messages.map(m => `
      <tr>
        <td><strong>${escapeHtml(m.sender || m.sender_email || "")}</strong><br><small>${escapeHtml(m.sender_email || "")}</small></td>
        <td>${escapeHtml(m.subject || "")}</td>
        <td>${escapeHtml((m.received_at || "").replace("T", " ").slice(0, 19))}</td>
        <td>${(m.attachments || []).length}</td>
      </tr>
    `).join("");
  } catch (err) {
    messagesEl.innerHTML = `<tr><td colspan="4">Could not load messages: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

document.getElementById("refresh-status").addEventListener("click", refreshStatus);
document.getElementById("sync").addEventListener("click", syncGmail);
document.getElementById("load").addEventListener("click", loadMessages);

refreshStatus();
