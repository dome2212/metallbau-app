const {test}=require('node:test'),assert=require('node:assert/strict');const railing=require('../Public/js/cad-railing'),parts=require('../Public/js/cad-parts');
const base={width:2000,height:1000,postSpacing:1000,clearance:100,barGap:100,x:0,y:0,material:'S235JR',finish:'Unbehandelt',postProfile:'40x40x2',railProfile:'40x40x2',barProfile:'12x12x0',infill:'bars',plates:true,plateSize:100,plateThickness:8};
test('mixed rectangle, round and flat profiles preserve sizes and selected materials',()=>{
 const g=railing.generate({...base,postProfile:'80x40x3',railProfile:'round42.4x2.6',barProfile:'flat40x8',materialPost:'S355J2',materialRail:'Edelstahl 1.4404',materialBar:'Aluminium EN AW-6063'});
 const post=g.objects.find(o=>o.part?.name==='Pfosten'),rail=g.objects.find(o=>o.part?.name==='Handlauf'),bar=g.objects.find(o=>o.part?.name==='Füllstab');
 assert.equal(post.w,80);assert.equal(post.h,40);assert.equal(post.part.material,'S355J2');assert.equal(rail.h,42.4);assert.equal(rail.depth,42.4);assert.equal(rail.part.section,'round');assert.equal(rail.part.material,'Edelstahl 1.4404');assert.equal(bar.w,40);assert.equal(bar.h,8);assert.equal(bar.part.material,'Aluminium EN AW-6063');assert.match(parts.dimensions(rail),/Ø 42.4/);assert.deepEqual(parts.validatePart(JSON.parse(JSON.stringify(rail.part)),rail),rail.part);
});
test('round posts and bars retain proper geometry and corner placement',()=>{
 const g=railing.generate({...base,postProfile:'round48.3x2.6',railProfile:'50x30x2',barProfile:'round12',corner:true,width2:1500,turn:-90});const post=g.objects.find(o=>o.part?.name==='Pfosten'),rail=g.objects.find(o=>o.part?.name==='Handlauf'),bar=g.objects.find(o=>o.part?.name==='Füllstab');
 assert.equal(post.type,'circle');assert.equal(post.w,24.15);assert.equal(post.part.wall,2.6);assert.equal(bar.type,'circle');assert.equal(bar.w,6);assert.equal(rail.h,50);assert.equal(rail.depth,30);assert.equal(g.posts,5);
});
test('round handrail rejects incompatible section edits',()=>{const rail=railing.generate({...base,railProfile:'round42.4x2.6'}).objects.find(o=>o.part?.name==='Handlauf');assert.throws(()=>parts.validatePart(rail.part,{...rail,depth:30}),/Rundprofil/);assert.throws(()=>railing.generate({...base,materialPost:'unbekannt'}));});
