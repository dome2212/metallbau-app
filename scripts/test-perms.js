process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-perms';
const { hasPerm, canSeeMoney } = require('../middleware/auth');

const firma = {};
const chef = { role: 'CHEF' };
const admin = { role: 'ADMIN' };
const sec = { role: 'SECRETARY' };
const emp = { role: 'EMPLOYEE' };

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('  ✓', msg);
}

console.log('hasPerm / canSeeMoney');
assert(hasPerm(chef, 'money', firma) === true, 'CHEF sees money');
assert(canSeeMoney(chef, firma) === true, 'CHEF canSeeMoney');
assert(hasPerm(sec, 'documents', firma) === true, 'SECRETARY documents default');
assert(hasPerm(sec, 'lager', firma) === true, 'SECRETARY lager default');
assert(hasPerm(sec, 'timetracking', firma) === false, 'SECRETARY no timetracking default');
assert(canSeeMoney(sec, firma) === true, 'SECRETARY money default');
assert(hasPerm(emp, 'documents', firma) === false, 'EMPLOYEE no documents default');
assert(canSeeMoney(emp, firma) === false, 'EMPLOYEE no money');
assert(hasPerm(admin, 'projects', firma) === true, 'ADMIN projects default');
assert(canSeeMoney(admin, firma) === false, 'ADMIN money off by default');
console.log('All perm tests passed.');
