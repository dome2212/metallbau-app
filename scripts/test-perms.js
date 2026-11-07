process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-perms';
const { hasPerm, canSeeMoney, isOffice, requireOffice, requireAdmin, ROLES } = require('../middleware/auth');

const firma = {};
const chef = { role: 'CHEF' };
const admin = { role: 'ADMIN' };
const emp = { role: 'EMPLOYEE' };
const buero = { role: 'BUERO' };

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ✓', msg);
}

console.log('hasPerm / canSeeMoney');
assert(hasPerm(chef, 'money', firma) === true, 'CHEF sees money');
assert(canSeeMoney(chef, firma) === true, 'CHEF canSeeMoney');
assert(hasPerm(emp, 'documents', firma) === false, 'EMPLOYEE no documents default');
assert(canSeeMoney(emp, firma) === false, 'EMPLOYEE no money');
assert(hasPerm(admin, 'projects', firma) === true, 'ADMIN projects default');
assert(canSeeMoney(admin, firma) === false, 'ADMIN money off by default');

console.log('Rolle BUERO');
assert(ROLES.includes('BUERO'), 'BUERO ist eine gültige Rolle');
assert(isOffice(buero) && isOffice(admin) && isOffice(chef) && !isOffice(emp), 'isOffice: Chef/Admin/Büro ja, Mitarbeiter nein');
assert(hasPerm(buero, 'documents', firma) === true, 'BUERO darf Angebote & Rechnungen');
assert(hasPerm(buero, 'customers', firma) === true, 'BUERO darf Kunden');
assert(hasPerm(buero, 'projects', firma) === true, 'BUERO darf Aufträge');
assert(hasPerm(buero, 'timetracking', firma) === true, 'BUERO darf Zeiterfassung');
assert(hasPerm(buero, 'cad', firma) === false, 'BUERO kein CAD (Standard)');
assert(canSeeMoney(buero, firma) === true, 'BUERO sieht Beträge (Standard)');
assert(canSeeMoney(buero, { perm_buero_money: 'false' }) === false, 'BUERO-Beträge abschaltbar');
assert(hasPerm(buero, 'documents', { perm_buero_documents: 'false' }) === false, 'BUERO-Recht per Matrix entziehbar');
function run(mw, user) { let r = null; mw({ user }, { status(c) { r = c; return this; }, send() {} }, () => { r = 'next'; }); return r; }
assert(run(requireOffice, buero) === 'next', 'requireOffice lässt BUERO durch');
assert(run(requireOffice, emp) === 403, 'requireOffice sperrt Mitarbeiter');
assert(run(requireAdmin, buero) === 403, 'requireAdmin (Nutzerverwaltung, Firmendaten, Panel) sperrt BUERO');
console.log('All perm tests passed.');
