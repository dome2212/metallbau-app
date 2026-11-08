/**
 * Lieferanten, Bestellungen, Wareneingang
 */
const express = require('express');
const router = express.Router();
const { requireOffice, requireAdmin } = require('../middleware/auth');
const { dbQuery } = require('../utils/db');
const { getFirma } = require('../utils/companySettings');

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

module.exports = router;
