/**
 * Wiederverwendbares Chat-Modul (WebSocket-Client).
 * Wird sowohl von der Team-Chat-Seite als auch vom Auftrags-Chat-Tab genutzt.
 */
function mbChatInit(opts) {
  const { channel, listEl, formEl, inputEl, currentUserId, statusEl, isModerator } = opts;
  let ws = null;
  let lastId = 0;
  let reconnectDelay = 1500;

  // Bereits serverseitig gerenderte Nachrichten kennen, um Duplikate zu vermeiden
  Array.from(listEl.querySelectorAll('[data-msg-id]')).forEach(el => {
    const id = parseInt(el.dataset.msgId, 10);
    if (id > lastId) lastId = id;
  });

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function attachDeleteHandler(btn, messageId) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!confirm('Nachricht wirklich löschen?')) return;
      ws.send(JSON.stringify({ type: 'delete', channel, messageId }));
    });
  }

  // Lösch-Buttons an bereits serverseitig gerenderten Nachrichten (erster Seitenaufruf) aktivieren
  Array.from(listEl.querySelectorAll('[data-msg-id]')).forEach(el => {
    attachDeleteHandler(el.querySelector('.chat-delete-btn'), parseInt(el.dataset.msgId, 10));
  });

  function renderMessage(m) {
    if (!m || listEl.querySelector(`[data-msg-id="${m.id}"]`)) return;
    const empty = listEl.querySelector('.chat-empty-state');
    if (empty) empty.remove();
    const mine = String(m.user_id) === String(currentUserId);
    const canDelete = mine || isModerator;
    const div = document.createElement('div');
    div.dataset.msgId = m.id;
    div.className = 'flex ' + (mine ? 'justify-end' : 'justify-start') + ' mb-2.5 group';
    const time = new Date(String(m.created_at).replace(' ', 'T')).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div class="max-w-[78%] rounded-2xl px-3.5 py-2 shadow-sm relative ${mine
        ? 'text-white'
        : 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600'}"
        ${mine ? 'style="background:var(--primary);"' : ''}>
        ${mine ? '' : `<p class="text-[11px] font-bold mb-0.5" style="color:var(--primary);">${escapeHtml(m.username)}</p>`}
        <p class="text-sm whitespace-pre-wrap break-words">${escapeHtml(m.message)}</p>
        <p class="text-[10px] mt-1 text-right ${mine ? 'text-white/70' : 'text-slate-400'}">${time}</p>
        ${canDelete ? `
          <button type="button" class="chat-delete-btn absolute -top-2 ${mine ? '-left-2' : '-right-2'} w-5 h-5 rounded-full bg-white dark:bg-slate-600 border border-slate-200 dark:border-slate-500 shadow-sm text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition flex items-center justify-center"
            title="Nachricht löschen">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m2 0v13a1 1 0 01-1 1H8a1 1 0 01-1-1V7h10z"/></svg>
          </button>` : ''}
      </div>`;
    if (canDelete) {
      attachDeleteHandler(div.querySelector('.chat-delete-btn'), m.id);
    }
    listEl.appendChild(div);
    if (m.id > lastId) lastId = m.id;
  }

  function removeMessage(messageId) {
    const el = listEl.querySelector(`[data-msg-id="${messageId}"]`);
    if (el) el.remove();
    if (!listEl.querySelector('[data-msg-id]') && !listEl.querySelector('.chat-empty-state')) {
      const empty = document.createElement('div');
      empty.className = 'flex-1 flex flex-col items-center justify-center text-center text-slate-400 py-6 chat-empty-state';
      empty.innerHTML = '<p class="text-sm font-medium">Keine Nachrichten</p>';
      listEl.appendChild(empty);
    }
  }

  function setStatus(text, ok) {
    if (!statusEl) return;
    const dotClass = ok ? 'green' : 'amber';
    statusEl.className = 'text-xs font-medium inline-flex items-center gap-1.5 ' + (ok ? 'text-emerald-500' : 'text-amber-500');
    statusEl.innerHTML = '<span class="status-dot ' + dotClass + '"></span>' + text;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/chat`);

    ws.onopen = () => {
      setStatus('Verbunden', true);
      reconnectDelay = 1500;
      ws.send(JSON.stringify({ type: 'join', channel, sinceId: lastId }));
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (data.type === 'history') {
        (data.messages || []).forEach(renderMessage);
        listEl.scrollTop = listEl.scrollHeight;
      } else if (data.type === 'message' && data.channel === channel) {
        renderMessage(data.message);
        listEl.scrollTop = listEl.scrollHeight;
      } else if (data.type === 'deleted' && data.channel === channel) {
        removeMessage(data.messageId);
      }
    };

    ws.onclose = () => {
      setStatus('Verbindung getrennt – verbinde neu…', false);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
    };

    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  connect();

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus('Keine Verbindung – Nachricht konnte nicht gesendet werden', false);
      return;
    }
    ws.send(JSON.stringify({ type: 'send', channel, text }));
    inputEl.value = '';
    inputEl.focus();
  });

  // Beim Zurückkommen auf den Tab/App sicherstellen, dass die Verbindung noch lebt
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState === WebSocket.CLOSED)) {
      connect();
    }
  });

  listEl.scrollTop = listEl.scrollHeight;
}
