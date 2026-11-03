const PDFDocument=require('pdfkit');
const parts=require('../Public/js/cad-parts');
function endpoints(o){
 if(['line','dim'].includes(o.type))return [[{x:o.x,y:o.y,z:o.z||0},{x:o.x+o.w,y:o.y+o.h,z:(o.z||0)+(o.dz||0)}]];
 const rings=parts.rings(o),result=[];
 for(const ring of [rings.outer,rings.inner].filter(Boolean)){
 const end=(p,last)=>{const l=parts.rotate(o,p,true),cx=o.type==='circle'?o.x:o.x+o.w/2,cy=o.type==='circle'?o.y:o.y+o.h/2;
 if(o.part?.lengthAxis==='x'){const which=l.x<=o.x+o.w/2?'start':'end',z=(o.z||0)+(last?o.depth:0),q=parts.rotate(o,{x:l.x+parts.miterOffset(o,which,l.y-cy,z-((o.z||0)+o.depth/2)),y:l.y});return {...q,z};}
 return parts.profilePoint(o,p,(last?o.depth:0)+parts.miterOffset(o,last?'end':'start',l.x-cx,l.y-cy));};
 const a=ring.map(p=>end(p,false)),b=ring.map(p=>end(p,true));for(let i=0;i<a.length;i++){const j=(i+1)%a.length;result.push([a[i],a[j]],[b[i],b[j]],[a[i],b[i]]);}
 }
 for(const h of o.part?.holes||[]){let prev;for(let i=0;i<=24;i++){const t=i*Math.PI/12,q=parts.rotate(o,{x:o.x+h.x+Math.cos(t)*h.d/2,y:o.y+h.y+Math.sin(t)*h.d/2}),p={...q,z:(o.z||0)+o.depth};if(prev)result.push([prev,p]);prev=p;}}
 return result;
}
function workshop(data,res){const pdf=new PDFDocument({size:'A4',layout:'landscape',margin:30});res.type('application/pdf');res.setHeader('Content-Disposition','attachment; filename="werkstattzeichnung.pdf"');pdf.pipe(res);
 pdf.fontSize(18).text(data.name);pdf.fontSize(9).text('Werkstattzeichnung · Maße in mm · Ansichten jeweils eingepasst');
 const geometry=data.objects.map(endpoints),rows=parts.rows(data.objects),projections=[['Vorne',p=>[p.x,-p.z]],['Draufsicht',p=>[p.x,-p.y]],['Seite',p=>[p.y,-p.z]]];
 projections.forEach(([title,project],index)=>{const x=30+index*260,y=105,w=245,h=380,all=geometry.flat().flat().map(project);pdf.fontSize(12).text(title,x,y-25);if(!all.length)return;const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),scale=Math.min((w-65)/Math.max(1,maxX-minX),(h-45)/Math.max(1,maxY-minY)),map=p=>{const q=project(p);return [x+15+(q[0]-minX)*scale,y+15+(q[1]-minY)*scale];};
 pdf.lineWidth(.4);geometry.forEach(edges=>edges.forEach(([a,b])=>{const A=map(a),B=map(b);pdf.moveTo(...A).lineTo(...B).stroke('#364c5d');}));
 const annotations=rows.map(row=>{const edges=geometry[row.indices[0]],points=edges.flat();if(!points.length)return null;const p=points.reduce((a,b)=>({x:a.x+b.x/points.length,y:a.y+b.y/points.length,z:a.z+b.z/points.length}),{x:0,y:0,z:0});return {position:row.position,point:map(p)};}).filter(Boolean).sort((a,b)=>a.point[1]-b.point[1]);
 annotations.forEach((a,i)=>{const lx=x+w-14,ly=y+25+i*Math.min(22,(h-50)/Math.max(1,annotations.length));pdf.lineWidth(.3).moveTo(...a.point).lineTo(lx-8,ly).stroke('#859aa5');pdf.circle(lx,ly,7).fillAndStroke('white','#116878');pdf.fillColor('#116878').fontSize(7).text(String(a.position),lx-6,ly-3,{width:12,align:'center',lineBreak:false});});

 data.objects.filter(o=>o.type==='dim').forEach(o=>{const A=map({x:o.x,y:o.y,z:o.z||0}),B=map({x:o.x+o.w,y:o.y+o.h,z:(o.z||0)+(o.dz||0)});if(Math.hypot(A[0]-B[0],A[1]-B[1])>10)pdf.fillColor('black').fontSize(7).text(Math.hypot(...project({x:o.w,y:o.h,z:o.dz||0})).toFixed(1)+' mm',(A[0]+B[0])/2,(A[1]+B[1])/2-9,{lineBreak:false});});
 const physical=geometry.filter((_,i)=>data.objects[i].type!=='dim').flat().flat().map(project),px=physical.map(p=>p[0]),py=physical.map(p=>p[1]);pdf.fillColor('black').fontSize(9).text(`Gesamt: ${physical.length?(Math.max(...px)-Math.min(...px)).toFixed(1):0} × ${physical.length?(Math.max(...py)-Math.min(...py)).toFixed(1):0} mm`,x,y+h-10,{width:w});
 });
 pdf.addPage();pdf.fontSize(16).text(data.name+' · Stückliste und Fertigung');pdf.moveDown();
 for(const row of rows){if(pdf.y>510)pdf.addPage();const p=row.part;pdf.fontSize(10).text(`Pos. ${row.position} · ${p.name} · ${row.quantity} Stück`);pdf.fontSize(9).text(`${p.material} | ${row.dimensions} mm | t ${p.wall} | ${p.finish}`);pdf.text(`Zuschnitt ${row.length===null?'–':row.length.toFixed(2)+' mm'} | Schnitt ${p.cutStart.toFixed(2)}° / ${p.cutEnd.toFixed(2)}° | Bohrungen ${p.drillCount} × Ø ${p.drillDiameter} mm`);if(p.holes?.length)pdf.text(p.holes.map(h=>`X ${h.x} Y ${h.y}`).join(' | '));if(p.notes)pdf.text(p.notes);pdf.moveDown(.5);}
 pdf.end();}
module.exports={workshop,endpoints};
