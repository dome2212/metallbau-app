const {test}=require('node:test');
const assert=require('node:assert/strict');
const railing=require('../Public/js/cad-railing');
const parts=require('../Public/js/cad-parts');
const base={width:2000,height:1000,postSpacing:1000,clearance:100,barGap:100,x:0,y:0,material:'S235JR',finish:'Unbehandelt',postProfile:'40x40x2',railProfile:'40x40x2',barProfile:'12x12x0',infill:'bars',plates:true,plateSize:100,plateThickness:8};
test('generated railing fits specified bounds and reports the actual clear opening',()=>{
  const g=railing.generate(base), o=g.objects, rows=parts.rows(o);
  assert.equal(g.posts,3);assert.equal(g.bars,16);assert.ok(g.opening<=base.barGap);
  assert.equal(rows.find(r=>r.part.name==='Pfosten').quantity,3);assert.equal(rows.find(r=>r.part.name==='Pfosten').length,960);
  assert.equal(rows.find(r=>r.part.name==='Handlauf').length,2000);assert.equal(rows.find(r=>r.part.name==='Untergurt').quantity,2);assert.equal(rows.find(r=>r.part.name==='Untergurt').length,940);
  assert.equal(rows.find(r=>r.part.name==='Füllstab').length,820);assert.equal(rows.find(r=>r.part.name==='Fußplatte').quantity,3);
  for(const a of o)assert.deepEqual(parts.validatePart(a.part,a),a.part);
  const rail=o.find(a=>a.part?.name==='Handlauf');assert.equal(rail.z+rail.depth,base.height);assert.equal(rail.part.lengthAxis,'x');
  assert.equal(o.filter(a=>a.part?.name==='Pfosten').at(-1).x+40,base.width);
  const csv=parts.csv(o,true);assert.ok(csv.includes('"Handlauf"'));assert.ok(csv.includes('"2000"'));
});
test('open infill and no plates remove only those parts; placement and materials persist',()=>{
  const g=railing.generate({...base,infill:'open',plates:false,x:100,y:200,material:'Edelstahl 1.4301',finish:'Geschliffen'});
  assert.equal(g.bars,0);assert.ok(g.objects.every(o=>!['Füllstab','Fußplatte'].includes(o.part?.name)));assert.ok(g.objects.filter(o=>o.part).every(o=>o.part.material==='Edelstahl 1.4301'&&o.part.finish==='Geschliffen'));assert.equal(g.objects[0].x,100);assert.equal(g.objects[0].y,200);
  const roundtrip=JSON.parse(JSON.stringify(g.objects));for(const o of roundtrip)assert.deepEqual(parts.validatePart(o.part,o),o.part);
});
test('bad measurements and impossible wall geometry are rejected',()=>{
  for(const patch of [{height:100},{width:NaN},{clearance:990},{barGap:0},{postProfile:'unknown'},{material:'bad'},{postSpacing:50}])assert.throws(()=>railing.generate({...base,...patch}));
  const rail=railing.generate(base).objects.find(o=>o.part?.name==='Handlauf');assert.throws(()=>parts.validatePart({...rail.part,wall:20},rail));
});
test('corner shares one post, adds second run at left or right angle and groups lengths',()=>{
 for(const turn of [90,-90,35]){
  const c={...base,corner:true,width2:1500,turn,angle:0};const g=railing.generate(c);
  const posts=g.objects.filter(o=>o.part?.name==='Pfosten'),plates=g.objects.filter(o=>o.part?.name==='Fußplatte'),rails=g.objects.filter(o=>o.part?.name==='Handlauf');
  assert.equal(posts.length,5);assert.equal(plates.length,5);assert.equal(rails.length,2);assert.equal(rails[1].angle,turn);assert.ok(Math.abs(rails[1].w-1480)<.002);assert.ok(Math.abs(rails[0].w-1980)<.002);
  const rows=parts.rows(g.objects);assert.equal(rows.find(r=>r.part.name==='Pfosten').quantity,5);assert.ok(rows.some(r=>r.part.name==='Handlauf'&&Math.abs(r.length-1480)<.002));
  const firstCenter={x:1980,y:20},center=parts.rotate(rails[1],{x:rails[1].x,y:rails[1].y+20});
  assert.ok(Math.hypot(center.x-firstCenter.x,center.y-firstCenter.y)<.002);
  assert.ok(rails[0].part.miterEnd!==undefined);assert.ok(rails[1].part.miterStart!==undefined);
 }
});
test('arbitrary bearing rotates footprints without changing lengths and invalid turns are rejected',()=>{
 const a=railing.generate({...base,angle:45}),o=a.objects.find(o=>o.part?.name==='Handlauf'),p=parts.rings(o).outer;
 assert.equal(o.angle,45);assert.ok(Math.abs(Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)-2000)<1e-8);
 const back=parts.rotate(o,p[1],true);assert.ok(Math.abs(back.x-o.x-2000)<1e-8);assert.ok(Math.abs(back.y-o.y)<1e-8);
 assert.throws(()=>railing.generate({...base,corner:true,width2:1500,turn:5}));assert.throws(()=>railing.generate({...base,angle:181}));
});
