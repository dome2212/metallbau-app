/**
 * Lieferanten, Bestellungen, Wareneingang
 */
const express = require('express');
const router = express.Router();
const { requireOffice, requireAdmin } = require('../middleware/auth');
const { dbQuery } = require('../utils/db');
const { getFirma } = require('../utils/companySettings');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilddateien erlaubt.'));
  }
});

async function callGeminiVision(systemPrompt, b64, mimeType) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY nicht konfiguriert.');
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.0-flash-lite'];
  let lastErr;
  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: systemPrompt },
              { inline_data: { mime_type: mimeType, data: b64 } }
            ]}],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
          })
        }
      );
      const data = await response.json();
      if (!response.ok) { lastErr = data; continue; }
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) { lastErr = err; }
  }
  throw new Error('Gemini Vision fehlgeschlagen: ' + JSON.stringify(lastErr));
}

async function callOpenRouterVision(systemPrompt, b64, mimeType) {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) throw new Error('OPENROUTER_API_KEY nicht konfiguriert.');
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + orKey,
      'HTTP-Referer': process.env.APP_URL || 'https://localhost',
      'X-Title': 'Metallbau App'
    },
    body: JSON.stringify({
      model: 'google/gemma-3-27b-it:free',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
        ]
      }],
      temperature: 0.2,
      max_tokens: 4096
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data?.choices?.[0]?.message?.content || '';
}

async function callVision(systemPrompt, b64, mimeType) {
  let lastError;
  if (process.env.GROQ_API_KEY) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: systemPrompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
            ]
          }],
          temperature: 0.2,
          max_tokens: 4096
        })
      });
      const data = await response.json();
      if (response.ok) return data?.choices?.[0]?.message?.content || '';
      lastError = data;
    } catch (err) { lastError = err; }
  }
  if (process.env.GEMINI_API_KEY) {
    try { return await callGeminiVision(systemPrompt, b64, mimeType); } catch (err) { lastError = err; }
  }
  if (process.env.OPENROUTER_API_KEY) {
    return await callOpenRouterVision(systemPrompt, b64, mimeType);
  }
  throw new Error('Kein Vision-API-Key (GROQ/GEMINI/OPENROUTER). Letzter Fehler: ' + JSON.stringify(lastError));
}

function parseItemsJson(reply) {
  let jsonStr = String(reply || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const start = jsonStr.indexOf('[');
  if (start === -1) return [];
  jsonStr = jsonStr.slice(start);
  let end = jsonStr.lastIndexOf(']');
  if (end === -1) {
    const lastClose = jsonStr.lastIndexOf('}');
    if (lastClose === -1) return [];
    jsonStr = jsonStr.slice(0, lastClose + 1) + ']';
  } else {
    jsonStr = jsonStr.slice(0, end + 1);
  }
  try {
    const items = JSON.parse(jsonStr);
    return Array.isArray(items) ? items : [items];
  } catch (_) {
    return [];
  }
}


function num(v, fallback = 0) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

// ── Lieferanten ──────────────────────────────────────────────────────────────
router.get('/suppliers', requireOffice, async (req, res) => {
  try {
    const rows = (await dbQuery(
      `SELECT s.*,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) AS order_count
       FROM suppliers s
       ORDER BY s.active DESC, s.name ASC`
    )).rows || [];
    res.render('suppliers', { suppliers: rows, success: req.query.saved === '1', firma: await getFirma().catch(() => ({})) });
  } catch (err) {
    console.error('Lieferanten:', err.message);
    res.status(500).send('Fehler beim Laden der Lieferanten.');
  }
});

router.post('/suppliers', requireOffice, async (req, res) => {
  try {
    const { name, contact, email, phone, address, notes } = req.body;
    if (!(name || '').trim()) return res.status(400).send('Name ist Pflicht.');
    await dbQuery(
      `INSERT INTO suppliers (name, contact, email, phone, address, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      [(name || '').trim(), (contact || '').trim() || null, (email || '').trim() || null,
       (phone || '').trim() || null, (address || '').trim() || null, (notes || '').trim() || null]
    );
    res.redirect('/einkauf/suppliers?saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

router.post('/suppliers/:id/update', requireOffice, async (req, res) => {
  try {
    const { name, contact, email, phone, address, notes, active } = req.body;
    await dbQuery(
      `UPDATE suppliers SET name=?, contact=?, email=?, phone=?, address=?, notes=?, active=? WHERE id=?`,
      [(name || '').trim(), (contact || '').trim() || null, (email || '').trim() || null,
       (phone || '').trim() || null, (address || '').trim() || null, (notes || '').trim() || null,
       active === '0' || active === 'false' ? 0 : 1, req.params.id]
    );
    res.redirect('/einkauf/suppliers?saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

// ── Bestellungen ─────────────────────────────────────────────────────────────
router.get('/orders', requireOffice, async (req, res) => {
  try {
    const status = (req.query.status || '').trim();
    let sql = `
      SELECT po.*, s.name AS supplier_name, p.title AS project_title,
        (SELECT COALESCE(SUM(quantity * unit_price),0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS total_net
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      LEFT JOIN projects p ON po.project_id = p.id`;
    const params = [];
    if (status) { sql += ' WHERE po.status = ?'; params.push(status); }
    sql += ' ORDER BY po.created_at DESC LIMIT 200';
    const orders = (await dbQuery(sql, params)).rows || [];
    const suppliers = (await dbQuery(`SELECT id, name FROM suppliers WHERE active = 1 OR active = true ORDER BY name`)).rows || [];
    const projects = (await dbQuery(`SELECT id, title FROM projects WHERE status IS NULL OR status NOT IN ('ARCHIV','STORNIERT') ORDER BY id DESC LIMIT 300`)).rows || [];
    res.render('purchase-orders', {
      orders, suppliers, projects, statusFilter: status,
      success: req.query.saved === '1',
      firma: await getFirma().catch(() => ({}))
    });
  } catch (err) {
    console.error('Bestellungen:', err.message);
    res.status(500).send('Fehler beim Laden der Bestellungen.');
  }
});

router.post('/orders', requireOffice, async (req, res) => {
  try {
    const { supplier_id, project_id, order_number, notes, expected_at } = req.body;
    const ins = await dbQuery(
      `INSERT INTO purchase_orders (supplier_id, project_id, order_number, status, notes, expected_at, created_by)
       VALUES (?, ?, ?, 'ENTWURF', ?, ?, ?)`,
      [
        supplier_id || null,
        project_id || null,
        (order_number || '').trim() || null,
        (notes || '').trim() || null,
        (expected_at || '').trim() || null,
        req.user?.id || null
      ]
    );
    const id = ins.lastID || ins.rows?.[0]?.id;
    res.redirect('/einkauf/orders/' + id);
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

router.get('/orders/:id', requireOffice, async (req, res) => {
  try {
    const po = (await dbQuery(
      `SELECT po.*, s.name AS supplier_name, s.email AS supplier_email, p.title AS project_title
       FROM purchase_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       LEFT JOIN projects p ON po.project_id = p.id
       WHERE po.id = ?`, [req.params.id]
    )).rows?.[0];
    if (!po) return res.status(404).send('Bestellung nicht gefunden.');
    const items = (await dbQuery(
      `SELECT i.*, li.bezeichnung AS lager_name
       FROM purchase_order_items i
       LEFT JOIN lager_items li ON i.lager_item_id = li.id
       WHERE i.purchase_order_id = ?
       ORDER BY i.id ASC`, [req.params.id]
    )).rows || [];
    const suppliers = (await dbQuery(`SELECT id, name FROM suppliers ORDER BY name`)).rows || [];
    const projects = (await dbQuery(`SELECT id, title FROM projects ORDER BY id DESC LIMIT 300`)).rows || [];
    const lager = (await dbQuery(`SELECT id, bezeichnung, profil, einheit, einheitspreis FROM lager_items ORDER BY bezeichnung ASC LIMIT 500`)).rows || [];
    const total = items.reduce((s, i) => s + num(i.quantity) * num(i.unit_price), 0);
    res.render('purchase-order-detail', {
      po, items, suppliers, projects, lager, total,
      success: req.query.saved === '1',
      firma: await getFirma().catch(() => ({}))
    });
  } catch (err) {
    console.error('Bestellung Detail:', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});

router.post('/orders/:id/update', requireOffice, async (req, res) => {
  try {
    const { supplier_id, project_id, order_number, notes, expected_at, status } = req.body;
    const allowed = ['ENTWURF', 'BESTELLT', 'TEILWEISE', 'GELIEFERT', 'STORNIERT'];
    const st = allowed.includes(status) ? status : 'ENTWURF';
    await dbQuery(
      `UPDATE purchase_orders SET supplier_id=?, project_id=?, order_number=?, notes=?, expected_at=?, status=?,
        ordered_at = CASE WHEN ? = 'BESTELLT' AND (ordered_at IS NULL OR ordered_at = '') THEN ? ELSE ordered_at END
       WHERE id=?`,
      [
        supplier_id || null, project_id || null,
        (order_number || '').trim() || null,
        (notes || '').trim() || null,
        (expected_at || '').trim() || null,
        st, st, new Date().toISOString().slice(0, 10),
        req.params.id
      ]
    );
    res.redirect('/einkauf/orders/' + req.params.id + '?saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

router.post('/orders/:id/items', requireOffice, async (req, res) => {
  try {
    const { description, quantity, unit, unit_price, lager_item_id } = req.body;
    if (!(description || '').trim()) return res.status(400).send('Beschreibung fehlt.');
    await dbQuery(
      `INSERT INTO purchase_order_items (purchase_order_id, description, quantity, unit, unit_price, lager_item_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.params.id,
        description.trim(),
        num(quantity, 1),
        (unit || 'Stk').trim() || 'Stk',
        num(unit_price),
        lager_item_id || null
      ]
    );
    res.redirect('/einkauf/orders/' + req.params.id + '?saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

router.post('/orders/:id/items/:itemId/delete', requireOffice, async (req, res) => {
  try {
    await dbQuery(`DELETE FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?`, [req.params.itemId, req.params.id]);
    res.redirect('/einkauf/orders/' + req.params.id + '?saved=1');
  } catch (err) {
    res.status(500).send('Fehler: ' + err.message);
  }
});

/**
 * Wareneingang: Mengen buchen, optional Lager erhöhen, Status aktualisieren
 */
router.post('/orders/:id/receive', requireOffice, async (req, res) => {
  try {
    const poId = req.params.id;
    const po = (await dbQuery(`SELECT * FROM purchase_orders WHERE id = ?`, [poId])).rows?.[0];
    if (!po) return res.status(404).send('Bestellung nicht gefunden.');
    if (po.status === 'STORNIERT') return res.status(400).send('Stornierte Bestellung.');

    const items = (await dbQuery(`SELECT * FROM purchase_order_items WHERE purchase_order_id = ?`, [poId])).rows || [];
    let anyPartial = false;
    let allDone = true;

    for (const item of items) {
      const field = 'recv_' + item.id;
      const recv = num(req.body[field], 0);
      if (recv <= 0) {
        if (num(item.received_qty) < num(item.quantity)) allDone = false;
        continue;
      }
      const newRecv = num(item.received_qty) + recv;
      await dbQuery(`UPDATE purchase_order_items SET received_qty = ? WHERE id = ?`, [newRecv, item.id]);

      // Lagerbestand erhöhen, wenn verknüpft
      if (item.lager_item_id) {
        await dbQuery(
          `UPDATE lager_items SET menge = COALESCE(menge,0) + ? WHERE id = ?`,
          [recv, item.lager_item_id]
        );
        // EK-Preis aktualisieren wenn gesetzt
        if (num(item.unit_price) > 0) {
          await dbQuery(`UPDATE lager_items SET einheitspreis = ? WHERE id = ?`, [num(item.unit_price), item.lager_item_id]);
        }
      }

      if (newRecv + 0.0001 < num(item.quantity)) {
        allDone = false;
        anyPartial = true;
      } else if (newRecv > 0) {
        anyPartial = true;
      }
    }

    let status = po.status;
    if (allDone && items.length) status = 'GELIEFERT';
    else if (anyPartial) status = 'TEILWEISE';

    await dbQuery(
      `UPDATE purchase_orders SET status = ?, received_at = CASE WHEN ? = 'GELIEFERT' THEN ? ELSE received_at END WHERE id = ?`,
      [status, status, new Date().toISOString().slice(0, 10), poId]
    );

    res.redirect('/einkauf/orders/' + poId + '?saved=1');
  } catch (err) {
    console.error('Wareneingang:', err.message);
    res.status(500).send('Fehler: ' + err.message);
  }
});


// ── Bestellung löschen ───────────────────────────────────────────────────────
router.post('/orders/:id/delete', requireOffice, async (req, res) => {
  try {
    const id = req.params.id;
    await dbQuery(`DELETE FROM purchase_order_items WHERE purchase_order_id = ?`, [id]);
    await dbQuery(`DELETE FROM purchase_orders WHERE id = ?`, [id]);
    res.redirect('/einkauf/orders?saved=1');
  } catch (err) {
    console.error('Bestellung löschen:', err.message);
    res.status(500).send('Fehler beim Löschen: ' + err.message);
  }
});

/**
 * Lieferschein fotografieren / aus Galerie – KI füllt Positionen vor.
 * POST multipart field "image"
 */
router.post('/orders/:id/scan-lieferschein', requireOffice, upload.single('image'), async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'Kein KI-API-Key konfiguriert (Gemini / Groq / OpenRouter).' });
    }
    if (!req.file) return res.status(400).json({ error: 'Kein Bild übermittelt.' });

    const b64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const systemPrompt = `Du bist Experte für Lieferscheine im deutschen Metallbau / Stahlhandel.
Extrahiere ALLE Positionen aus dem Lieferschein-Bild.

Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Markdown).
Schema je Position:
{"description":"string","quantity":number,"unit":"Stk|m|kg|Paket|lfm","unit_price":number|null,"lieferschein_nr":"string|null","lieferdatum":"YYYY-MM-DD|null","supplier_name":"string|null"}

Regeln:
1. description: klare deutsche Bezeichnung inkl. Profil/Abmessung wenn sichtbar (z.B. "IPE 200 S235 12m", "Flachstahl 40x5 6000mm")
2. quantity: nur Zahl
3. unit_price: Einzelpreis netto wenn auf dem Beleg, sonst null
4. Eine Tabellenzeile = eine Position
5. Lieferscheinnummer, Datum, Lieferant wenn sichtbar
6. Nichts erfinden; unleserlich = null

Beispiel:
[{"description":"IPE 200 S235 L=12000mm","quantity":6,"unit":"Stk","unit_price":89.50,"lieferschein_nr":"LS-10482","lieferdatum":"2026-03-12","supplier_name":"Stahlhandel Muster GmbH"}]`;

    const reply = await callVision(systemPrompt, b64, mimeType);
    const items = parseItemsJson(reply).map((it) => ({
      description: String(it.description || it.bezeichnung || '').trim(),
      quantity: num(it.quantity || it.menge, 1),
      unit: String(it.unit || it.einheit || 'Stk').trim() || 'Stk',
      unit_price: it.unit_price != null ? num(it.unit_price) : (it.preis != null ? num(it.preis) : 0),
      lieferschein_nr: it.lieferschein_nr || null,
      lieferdatum: it.lieferdatum || null,
      supplier_name: it.supplier_name || null
    })).filter((it) => it.description);

    const meta = items[0] || {};
    res.json({
      items,
      meta: {
        lieferschein_nr: meta.lieferschein_nr || null,
        lieferdatum: meta.lieferdatum || null,
        supplier_name: meta.supplier_name || null
      },
      raw: items.length ? undefined : reply
    });
  } catch (err) {
    console.error('PO Lieferschein-Scan:', err.message);
    res.status(500).json({ error: 'KI-Analyse fehlgeschlagen: ' + (err.message || 'Unbekannt') });
  }
});

/**
 * Gescannte Positionen in die Bestellung übernehmen
 * Body: { items: [...], replace: true|false, order_number?, notes? }
 */
router.post('/orders/:id/apply-scan', requireOffice, async (req, res) => {
  try {
    const poId = req.params.id;
    const po = (await dbQuery(`SELECT * FROM purchase_orders WHERE id = ?`, [poId])).rows?.[0];
    if (!po) return res.status(404).json({ error: 'Bestellung nicht gefunden' });

    let items = req.body.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch (_) { items = []; }
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Keine Positionen' });
    }

    if (req.body.replace === true || req.body.replace === '1' || req.body.replace === 'true') {
      await dbQuery(`DELETE FROM purchase_order_items WHERE purchase_order_id = ?`, [poId]);
    }

    for (const it of items) {
      const desc = String(it.description || '').trim();
      if (!desc) continue;
      await dbQuery(
        `INSERT INTO purchase_order_items (purchase_order_id, description, quantity, unit, unit_price)
         VALUES (?, ?, ?, ?, ?)`,
        [poId, desc, num(it.quantity, 1), String(it.unit || 'Stk').trim() || 'Stk', num(it.unit_price)]
      );
    }

    const orderNumber = (req.body.order_number || req.body.lieferschein_nr || '').trim();
    const notesExtra = (req.body.notes || '').trim();
    if (orderNumber || notesExtra) {
      const noteVal = notesExtra
        ? ((po.notes ? String(po.notes) + '\n' : '') + notesExtra)
        : po.notes;
      await dbQuery(
        `UPDATE purchase_orders SET
           order_number = COALESCE(NULLIF(?, ''), order_number),
           notes = ?,
           status = CASE WHEN status = 'ENTWURF' THEN 'BESTELLT' ELSE status END
         WHERE id = ?`,
        [orderNumber || null, noteVal, poId]
      );
    } else {
      await dbQuery(
        `UPDATE purchase_orders SET status = CASE WHEN status = 'ENTWURF' THEN 'BESTELLT' ELSE status END WHERE id = ?`,
        [poId]
      );
    }

    if (req.accepts('html') && !String(req.headers.accept || '').includes('application/json')) {
      return res.redirect('/einkauf/orders/' + poId + '?saved=1');
    }
    res.json({ ok: true, count: items.length });
  } catch (err) {
    console.error('apply-scan:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
