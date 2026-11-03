const {test}=require('node:test');
const assert=require('node:assert/strict');
const parts=require('../Public/js/cad-parts');

test('all library templates have valid geometry, hollow profiles have inner contours',()=>{
  for(const t of parts.catalog){const o=parts.create(t.id);assert.deepEqual(parts.validatePart(o.part,o),o.part);const rings=parts.rings(o);assert.equal(Boolean(rings.inner),t.wall>0);if(rings.inner)assert.equal(rings.inner.length,rings.outer.length);}
  const tube=parts.create('rhs'),rings=parts.rings(tube);
  assert.deepEqual(rings.inner,[{x:3,y:3},{x:57,y:3},{x:57,y:37},{x:3,y:37}]);
  assert.equal(parts.length(tube),1000);assert.equal(parts.length(parts.create('plate')),null);
});
test('BOM merges identical specs across placements, sums quantities, separates fabrication differences',()=>{
  const a=parts.create('rhs'),b=parts.create('rhs');b.x=400;b.part.quantity=3;
  let rows=parts.rows([a,b,{type:'line',x:0,y:0,w:30,h:10,depth:0}]);
  assert.equal(rows.length,1);assert.equal(rows[0].quantity,4);assert.deepEqual(rows[0].indices,[0,1]);
  b.part.cutEnd=45;assert.equal(parts.rows([a,b]).length,2);
  b.part.cutEnd=0;b.depth=1500;assert.equal(parts.rows([a,b]).length,2);
});
test('old plain contours stay usable and have no invented profile cut length',()=>{
  const o={type:'rect',x:0,y:0,w:100,h:200,depth:10};assert.equal(parts.validatePart(undefined,o),undefined);
  const rows=parts.rows([o]);assert.equal(rows[0].part.material,'Nicht zugeordnet');assert.equal(rows[0].length,null);assert.equal(o.part,undefined);
});
test('invalid production data and incompatible geometry are rejected',()=>{
  const o=parts.create('rhs');
  for(const patch of [{quantity:0},{quantity:1.5},{quantity:Infinity},{wall:20},{wall:0},{cutStart:90},{drillCount:2,drillDiameter:0},{notes:'x'.repeat(501)},{catalogId:'unknown'},{material:''}])assert.throws(()=>parts.validatePart({...o.part,...patch},o));
  assert.throws(()=>parts.validatePart(o.part,{...o,type:'circle'}));
  assert.throws(()=>parts.validatePart(o.part,{...o,depth:0}));
  const square=parts.create('shs');assert.throws(()=>parts.validatePart(square.part,{...square,w:60}));
});
test('metadata survives JSON roundtrip; production CSV quotes multiline text and neutralizes formulas',()=>{
  const o=parts.create('chs');o.part.quantity=2;o.part.cutEnd=45;o.part.drillCount=4;o.part.drillDiameter=8.5;o.part.notes='=SUM(1;2)\n"Bohren"';
  const copy=JSON.parse(JSON.stringify(o));assert.deepEqual(parts.validatePart(copy.part,copy),o.part);
  const csv=parts.csv([o],true);assert.ok(csv.startsWith('\uFEFF"Pos";'));assert.ok(csv.includes('"45";"4";"8.5"'));assert.ok(csv.includes('"\'=SUM(1;2)\n""Bohren"""'));
});
