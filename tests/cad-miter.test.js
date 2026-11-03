const {test}=require('node:test');
const assert=require('node:assert/strict');
const parts=require('../Public/js/cad-parts');
const railing=require('../Public/js/cad-railing');
const config={width:2000,height:1000,postSpacing:1000,clearance:100,barGap:100,x:0,y:0,material:'S235JR',finish:'Unbehandelt',postProfile:'40x40x2',railProfile:'40x40x2',barProfile:'12x12x0',infill:'bars',plates:false,plateSize:100,plateThickness:8};
const rail=()=>railing.generate(config).objects.find(o=>o.part.name==='Handlauf');
test('signed miter modifies each endpoint and keeps centreline length',()=>{
  const o=rail();o.part=parts.validatePart({...o.part,cutStart:45,cutEnd:45,miterStart:45,miterEnd:-45},o);
  const ring=parts.rings(o).outer;
  assert.ok(Math.abs(ring[0].x+20)<1e-7);assert.ok(Math.abs(ring[3].x-20)<1e-7);
  assert.ok(Math.abs(ring[1].x-2020)<1e-7);assert.ok(Math.abs(ring[2].x-1980)<1e-7);
  assert.equal(parts.length(o),2000);assert.equal(parts.miterOffset(o,'start',0),0);
  const rotated={...o,angle:90};const p=parts.rings(rotated).outer;assert.ok(Math.abs(p[0].y+20)<1e-7);assert.ok(Math.abs(p[3].y-20)<1e-7);
});
test('legacy angles remain metadata and geometry flags survive roundtrip',()=>{
  const o=rail();o.part=parts.validatePart({...o.part,cutStart:45},o);assert.equal(o.part.miterStart,undefined);assert.equal(parts.rings(o).outer[0].x,o.x);
  o.part=parts.validatePart({...o.part,miterStart:-45},o);const copy=JSON.parse(JSON.stringify(o));assert.deepEqual(parts.validatePart(copy.part,copy),o.part);assert.ok(parts.csv([copy],true).includes('Geometrie Anfang'));assert.ok(parts.csv([copy],true).includes('"\'-45"'));
});
test('reject intersecting cuts, unsupported plates and inconsistent metadata',()=>{
  const o=rail();const candidate={...o,w:10};assert.throws(()=>parts.validatePart({...o.part,cutStart:45,cutEnd:45,miterStart:45,miterEnd:-45},candidate),/überschneiden/);
  assert.throws(()=>parts.validatePart({...o.part,cutStart:45,miterStart:30},o),/übereinstimmen/);
  const plate=parts.create('plate');assert.throws(()=>parts.validatePart({...plate.part,miterStart:45,cutStart:45},plate),/Profile/);
});
test('vertical profile slopes at both sides of the section',()=>{
  const o=parts.create('shs');o.part=parts.validatePart({...o.part,miterEnd:45,cutEnd:45},o);assert.ok(Math.abs(parts.miterOffset(o,'end',20)-20)<1e-7);assert.ok(Math.abs(parts.miterOffset(o,'end',-20)+20)<1e-7);
});
test('both cut planes and directions preserve signed geometry and CSV metadata',()=>{
 const o=rail();o.part=parts.validatePart({...o.part,cutStart:45,miterStart:-45,miterAxisStart:'height',cutEnd:30,miterEnd:30,miterAxisEnd:'width'},o);
 assert.ok(Math.abs(parts.miterOffset(o,'start',100,20)+20)<1e-7);assert.ok(Math.abs(parts.miterOffset(o,'start',20,0))<1e-9);assert.ok(Math.abs(parts.miterOffset(o,'end',10,100)-Math.tan(Math.PI/6)*10)<1e-7);
 assert.deepEqual(parts.validatePart(JSON.parse(JSON.stringify(o.part)),o),o.part);const csv=parts.csv([o],true);assert.match(csv,/Schnittebene Anfang/);assert.ok(csv.includes('"height";"width";"x"'));
});
test('mixed-axis end cuts may not intersect and unknown axes are rejected',()=>{
 const o=rail(),short={...o,w:15};assert.throws(()=>parts.validatePart({...o.part,cutStart:45,miterStart:-45,miterAxisStart:'height',cutEnd:45,miterEnd:45,miterAxisEnd:'width'},short),/überschneiden/);
 assert.throws(()=>parts.validatePart({...o.part,miterAxisStart:'height'},o),/Schnittebene/);assert.throws(()=>parts.validatePart({...o.part,cutStart:45,miterStart:45,miterAxisStart:'diagonal'},o),/Schnittebene/);
});
