/**
 * Echtzeit-Chat (WebSocket)
 * ─────────────────────────────────────────────────────────────────────────────
 * Zwei Arten von Chat-Kanälen:
 *   - 'team'          → allgemeiner Team-Chat, für alle eingeloggten Nutzer sichtbar
 *   - 'project:<id>'  → Chat zu einem konkreten Auftrag
 *
 * Auth: Der Login-Cookie ("token", JWT) wird beim WebSocket-Handshake genauso
 * geprüft wie bei normalen HTTP-Requests (middleware/auth.js) – so bleibt es
 * nur einem eingeloggten Nutzer möglich, sich zu verbinden.
 *
 * Protokoll (JSON-Textnachrichten):
 *   Client → Server:
 *     { type: 'join', channel: 'team' | 'project:123', sinceId: 0 }
 *     { type: 'send', channel: '...', text: '...' }
 *   Server → Client:
 *     { type: 'history', channel, messages: [...] }
 *     { type: 'message', channel, message: {...} }
 *     { type: 'error', error: '...' }
 */

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { dbQuery } = require('./db');
const { JWT_SECRET } = require('../middleware/auth');

const isPg = !!process.env.DATABASE_URL;

// Absicherung: Tabelle wird hier zusätzlich zur regulären Migration erstellt.
// Falls die Migration aus irgendeinem Grund nicht sauber durchgelaufen ist
// (z.B. Buchführungs-Konflikt in schema_migrations), sorgt das hier dafür,
// dass der Chat trotzdem funktioniert - CREATE TABLE IF NOT EXISTS ist
// gefahrlos, auch wenn die Tabelle längst existiert.
let ensureTablePromise = null;
function ensureChatTable() {
  if (ensureTablePromise) return ensureTablePromise;
  ensureTablePromise = (async () => {
    try {
      await dbQuery(`CREATE TABLE IF NOT EXISTS chat_messages (
        id          ${isPg ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isPg ? '' : 'AUTOINCREMENT'},
        channel     TEXT NOT NULL,
        user_id     INTEGER NOT NULL,
        message     TEXT NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await dbQuery(`CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel, created_at)`);
      console.log('💬 chat_messages-Tabelle geprüft/erstellt.');
    } catch (err) {
      console.error('💬 Konnte chat_messages-Tabelle nicht sicherstellen:', err.message);
    }
  })();
  return ensureTablePromise;
}

// channel (string) -> Set von { ws, user }
const channels = new Map();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = val;
  });
  return out;
}

function isValidChannel(ch) {
  if (typeof ch !== 'string') return false;
  if (ch === 'team') return true;
  return /^project:\d+$/.test(ch);
}

function addToChannel(channel, entry) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(entry);
}

function removeFromAllChannels(entry) {
  for (const set of channels.values()) set.delete(entry);
}

function broadcast(channel, payload) {
  const set = channels.get(channel);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const { ws } of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

async function fetchHistory(channel, sinceId) {
  const result = await dbQuery(
    `SELECT chat_messages.id, chat_messages.channel, chat_messages.user_id,
            chat_messages.message, chat_messages.created_at, users.username
     FROM chat_messages
     JOIN users ON users.id = chat_messages.user_id
     WHERE chat_messages.channel = ? AND chat_messages.id > ?
     ORDER BY chat_messages.id ASC
     LIMIT 200`,
    [channel, sinceId || 0]
  );
  return result.rows || [];
}

function initChatServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { socket.destroy(); return; }
    if (url.pathname !== '/ws/chat') return; // andere Upgrade-Requests unangetastet lassen

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.token;
    if (!token) { socket.destroy(); return; }

    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch (_) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  });

  wss.on('connection', (ws, req, user) => {
    const entry = { ws, user, channel: null };

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch (_) { return; }

      if (data.type === 'join') {
        if (!isValidChannel(data.channel)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Ungültiger Kanal' }));
          return;
        }

        // Bei Auftrags-Chats sicherstellen, dass der Auftrag wirklich existiert
        // (verhindert Beitritt zu erfundenen/gelöschten project:<id>-Kanälen).
        // Auftrags-Details sind in dieser App für alle eingeloggten Nutzer
        // einsehbar (keine Zuweisungs-Einschränkung) – der Chat folgt derselben Regel.
        if (data.channel.startsWith('project:')) {
          const projectId = data.channel.split(':')[1];
          try {
            const projRes = await dbQuery('SELECT id FROM projects WHERE id = ?', [projectId]);
            if (!projRes.rows || projRes.rows.length === 0) {
              ws.send(JSON.stringify({ type: 'error', error: 'Auftrag nicht gefunden' }));
              return;
            }
          } catch (_) {
            ws.send(JSON.stringify({ type: 'error', error: 'Auftrag konnte nicht geprüft werden' }));
            return;
          }
        }

        // Bei Kanalwechsel: aus altem Kanal entfernen
        if (entry.channel) {
          const oldSet = channels.get(entry.channel);
          if (oldSet) oldSet.delete(entry);
        }
        entry.channel = data.channel;
        addToChannel(data.channel, entry);

        try {
          await ensureChatTable();
          const messages = await fetchHistory(data.channel, Number(data.sinceId) || 0);
          ws.send(JSON.stringify({ type: 'history', channel: data.channel, messages }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: 'Verlauf konnte nicht geladen werden' }));
        }
        return;
      }

      if (data.type === 'send') {
        if (!isValidChannel(data.channel)) return;
        const text = String(data.text || '').trim().slice(0, 2000);
        if (!text) return;

        try {
          await ensureChatTable();
          const result = await dbQuery(
            'INSERT INTO chat_messages (channel, user_id, message) VALUES (?, ?, ?)',
            [data.channel, user.id, text]
          );
          const messageId = result.lastID;
          const message = {
            id: messageId,
            channel: data.channel,
            user_id: user.id,
            username: user.username,
            message: text,
            created_at: new Date().toISOString()
          };
          broadcast(data.channel, { type: 'message', channel: data.channel, message });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: 'Nachricht konnte nicht gesendet werden' }));
        }
        return;
      }

      if (data.type === 'delete') {
        if (!isValidChannel(data.channel)) return;
        const messageId = Number(data.messageId);
        if (!messageId) return;

        try {
          await ensureChatTable();
          const isModerator = user.role === 'ADMIN' || user.role === 'CHEF';
          const ownRes = await dbQuery(
            'SELECT user_id FROM chat_messages WHERE id = ? AND channel = ?',
            [messageId, data.channel]
          );
          const msg = (ownRes.rows || [])[0];
          if (!msg) return; // schon gelöscht oder existiert nicht
          if (!isModerator && String(msg.user_id) !== String(user.id)) {
            ws.send(JSON.stringify({ type: 'error', error: 'Nur eigene Nachrichten können gelöscht werden' }));
            return;
          }

          await dbQuery('DELETE FROM chat_messages WHERE id = ? AND channel = ?', [messageId, data.channel]);
          broadcast(data.channel, { type: 'deleted', channel: data.channel, messageId });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: 'Nachricht konnte nicht gelöscht werden' }));
        }
        return;
      }
    });

    ws.on('close', () => removeFromAllChannels(entry));
    ws.on('error', () => removeFromAllChannels(entry));
  });

  console.log('💬 Chat-WebSocket-Server aktiv unter /ws/chat');
  return wss;
}

module.exports = { initChatServer, ensureChatTable };
