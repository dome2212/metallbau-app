const {test}=require('node:test'),assert=require('node:assert/strict');
const api=require('../Public/js/cad-construction'),doc=require('../Public/js/cad-document'),parts=require('../Public/js/cad-parts'),{endpoints}=require('../utils/cadWorkshop');
const config={kind:'member',profile:'40x40x2',direction:'horizontal',length:2000,width:1000,height:200,thickness:8,x:0,y:0,z:0,angle:0,material:'S235JR',finish:'Unbehandelt'};
const sheet={shape:'u',base:200,length:500,thickness:3,radius:3,k:.4,flange:50,holes:4,diameter:12,edge:25,material:'S355J2',finish:'Feuerverzinkt'};
function validate(objects){return doc.validate({version:1,name:'Test',objects}).objects;}
function bounds(o){const points=endpoints(o).flat();return ['x','y','z'].map(k=>[Math.min(...points.map(p=>p[k])),Math.max(...points.map(p=>p[k]))]);}
test('horizontal and vertical round profiles retain open section and material',()=>{
 for(const direction of ['horizontal','vertical']){const [o]=validate(api.construct({...config,profile:'round42.4x2.6',direction}));assert.equal(o.part.material,config.material);assert.equal(o.part.wall,2.6);assert.equal(parts.length(o),2000);assert.ok(parts.rings(o).inner);if(direction==='horizontal')assert.equal(o.part.section,'round');else assert.equal(o.type,'circle');}
});
test('outside frame dimensions and butt joints are flush without overlap',()=>{
 const objects=validate(api.construct({...config,kind:'frame'}));assert.equal(objects.length,4);const b=objects.map(bounds);assert.deepEqual(b[0],[[0,2000],[0,40],[0,40]]);assert.deepEqual(b[1],[[0,2000],[960,1000],[0,40]]);
 for(const side of b.slice(2)){assert.ok(Math.abs(side[1][0]-40)<1e-6);assert.ok(Math.abs(side[1][1]-960)<1e-6);}assert.ok(Math.abs(b[2][0][0])<1e-6);assert.ok(Math.abs(b[3][0][1]-2000)<1e-6);
 assert.ok(objects.every(o=>o.part.material==='S235JR'));
});
test('fabricated I and U beams contain three touching plates and accurate cut lengths',()=>{
 for(const kind of ['ibeam','channel']){const objects=validate(api.construct({...config,kind,width:100}));const b=objects.map(bounds);assert.equal(objects.length,3);assert.deepEqual(b[0][2],[0,8]);assert.deepEqual(b[2][2],[8,192]);assert.deepEqual(b[1][2],[192,200]);assert.equal(parts.rows(objects).reduce((n,r)=>n+r.quantity,0),3);assert.ok(objects.every(o=>parts.length(o)===2000));}
});
test('sheet allowance uses neutral radius; only the actual blank counts as material',()=>{
 const s=api.sheet(sheet),expected=300+Math.PI*(3+.4*3);assert.ok(Math.abs(s.width-expected)<1e-9);const objects=validate(s.objects);assert.equal(s.bends.length,2);assert.equal(s.blank.part.holes.length,4);assert.equal(parts.rows(objects).length,1);assert.equal(parts.rows(objects)[0].quantity,1);
 assert.ok(objects.slice(1).every(o=>o.reference));assert.ok(objects.every(o=>endpoints(o).flat().every(p=>Object.values(p).every(Number.isFinite))));assert.equal(objects[0].part.material,'S355J2');
});
test('laser DXF uses real hole positions, mm units and separate cutting/bending/marking layers',()=>{
 const s=api.sheet(sheet),o=s.blank;o.groupId='sheet';o.generator={kind:'sheet',config:sheet};const saved=validate([o])[0],dxf=api.laser(saved);assert.ok(dxf.includes('$INSUNITS\r\n70\r\n4'));assert.equal((dxf.match(/0\r\nCIRCLE/g)||[]).length,4);assert.equal((dxf.match(/8\r\nBEND/g)||[]).length,2);assert.equal((dxf.match(/8\r\nCUT/g)||[]).length,8);assert.ok(dxf.includes('8\r\nMARK'));assert.throws(()=>api.laser({...saved,w:saved.w+10}),/neu erzeugen/);assert.throws(()=>api.laser({...saved,generator:undefined}),/Kantdaten fehlen/);
});
test('invalid cross sections and bores are rejected, including nonfinite input',()=>{
 assert.throws(()=>api.construct({...config,kind:'frame',length:50}));assert.throws(()=>api.construct({...config,kind:'ibeam',thickness:100}));assert.throws(()=>api.construct({...config,x:NaN}));assert.throws(()=>api.sheet({...sheet,edge:4}));assert.throws(()=>api.sheet({...sheet,k:NaN}));
});
test('balcony includes supports and continuous three-sided configurable infill',()=>{
 const structures=require('../Public/js/cad-structures');for(const balconyInfill of ['bars','glass','open']){const objects=validate(structures.generate({type:'balcony',width:3000,depth:2000,height:2400,material:'S235JR',balconyInfill,railHeight:1100,deckThickness:30,balconyProfile:'50x50x2'}));assert.equal(objects.filter(o=>o.part?.name==='Balkonstütze').length,4);assert.equal(objects.filter(o=>o.part?.name==='Handlauf').length,3);assert.ok(objects.filter(o=>o.part?.name==='Pfosten').every(o=>o.z===2430));if(balconyInfill==='glass')assert.ok(objects.some(o=>o.part?.material.includes('VSG')));}
});
test('bend sectors share radial end faces with each other and meet the straight flanges',()=>{
 const s=api.sheet({...sheet,radius:9}),sectors=s.objects.filter(o=>o.part?.name==='Kantvorschau · Biegeradius');for(let side=0;side<2;side++)for(let i=0;i<3;i++){
  const a=sectors[side*4+i],b=sectors[side*4+i+1];const face=(o,end)=>parts.rings(o).outer.map(p=>{const local=parts.rotate(o,p,true);return parts.profilePoint(o,p,(end?o.depth:0)+parts.miterOffset(o,end?'end':'start',local.x-(o.x+o.w/2),local.y-(o.y+o.h/2)));});
  const pa=face(a,true),pb=face(b,false);assert.ok(pa.every(p=>pb.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-6)));
 }
});
test('folded flange feet connect to the radius for unequal radius and thickness',()=>{
 const s=api.sheet({...sheet,radius:9}),sectors=s.objects.filter(o=>o.part?.name==='Kantvorschau · Biegeradius'),flanges=s.objects.filter(o=>o.part?.name==='Kantvorschau · Schenkel');for(let i=0;i<2;i++){const o=sectors[i*4+3],face=parts.rings(o).outer.map(p=>{const l=parts.rotate(o,p,true);return parts.profilePoint(o,p,o.depth+parts.miterOffset(o,'end',l.x-(o.x+o.w/2),l.y-(o.y+o.h/2)));}),bottom=parts.rings(flanges[i]).outer.map(p=>({...p,z:flanges[i].z}));assert.ok(face.every(p=>bottom.some(q=>Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)<1e-6)));}
});
test('new construction and folded reference geometry builds finite WebGL meshes matching workshop bounds',async()=>{
 const THREE=await import('three'),{buildGeometry}=await import('../Public/js/cad-webgl-geometry.mjs');for(const o of [...api.sheet(sheet).objects,...api.construct({...config,kind:'frame',angle:35}),...api.construct({...config,kind:'ibeam',width:100})].filter(o=>o.part)){
  const g=buildGeometry(o,THREE,parts),ps=endpoints(o).flat();for(const axis of ['x','y','z']){assert.ok(Math.abs(g.boundingBox.min[axis]-Math.min(...ps.map(p=>p[axis])))<.02);assert.ok(Math.abs(g.boundingBox.max[axis]-Math.max(...ps.map(p=>p[axis])))<.02);}assert.ok([...g.attributes.position.array].every(Number.isFinite));g.dispose();
 }
});
test('two-hole sheets use one centred row even when the end margin exceeds half the length',()=>{
 const c={...sheet,shape:'flat',base:200,length:30,holes:2,edge:25,diameter:12};
 const s=api.sheet(c),objects=validate(s.objects);assert.deepEqual(objects[0].part.holes,[{x:25,y:15,d:12},{x:175,y:15,d:12}]);
 const dxf=api.laser({...s.blank,groupId:'test',generator:{kind:'sheet',config:c}});assert.equal((dxf.match(/0\r\nCIRCLE/g)||[]).length,2);
 assert.throws(()=>api.sheet({...c,holes:4}),/Bohrbild/);assert.throws(()=>api.sheet({...c,length:20,diameter:20}),/Bohrbild/);assert.throws(()=>api.sheet({...c,edge:96}),/Bohrbild/);
});
