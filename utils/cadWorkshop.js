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
const design=require('../Public/js/cad-design');
const projections=[['Vorne',p=>[p.x,-p.z]],['Draufsicht',p=>[p.x,-p.y]],['Seite',p=>[p.y,-p.z]]];
function workshop(data,res,options={}){
 data={...data,meta:require('../Public/js/cad-document').validateMeta(data.meta)};
 const kind=options.kind||'workshop',denominator=options.scale||0,rows=parts.rows(data.objects),geometry=data.objects.map(endpoints);
 if(kind==='parts'&&rows.length>150)throw Error('Einzelteilzeichnungen: höchstens 150 Positionen pro Ausgabe.');
 if(kind==='labels'&&rows.reduce((n,r)=>n+r.quantity,0)>1000)throw Error('Etiketten: höchstens 1.000 Teile pro Ausgabe.');
 // Bound tile count before writing headers, so an oversized exact-scale drawing yields a usable error.
 const tileCount=(edges,project)=>{const all=edges.flat().map(project);if(!all.length)return 1;const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),s=72/25.4/denominator;return Math.max(1,Math.ceil((Math.max(...xs)-Math.min(...xs))*s/720))*Math.max(1,Math.ceil((Math.max(...ys)-Math.min(...ys))*s/400));};
 if(denominator&&['parts','workshop','customer'].includes(kind)){const groups=kind==='parts'?rows.map(r=>geometry[r.indices[0]]):[geometry.flat()];if(groups.reduce((n,g)=>n+projections.reduce((m,[,project])=>m+tileCount(g,project),0),0)>150)throw Error('Zu viele Blätter bei diesem Maßstab. Größeren Maßstab wählen.');}
 const pdf=new PDFDocument({size:'A4',layout:'landscape',margin:30,autoFirstPage:false});res.type('application/pdf');res.setHeader('Content-Disposition',`attachment; filename="cad-${kind}.pdf"`);pdf.pipe(res);
 const page=title=>{pdf.addPage();pdf.fillColor('black').fontSize(16).text(data.name+' · '+title,30,30,{width:780});pdf.fontSize(9).text('Maße in mm',30,56);};
 const line=text=>{if(pdf.y>510){page('Fortsetzung');pdf.y=85;}pdf.fillColor('black').fontSize(10).text(text,30,pdf.y,{width:770});pdf.moveDown(.4);};
 function diagram(edges,title,project,box,scaleDen=0,tx=0,ty=0){
  const {x,y,w,h}=box,all=edges.flat().map(project);pdf.fillColor('black').fontSize(11).text(title,x,y-18,{width:w});if(!all.length)return;
  const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),s=scaleDen?72/25.4/scaleDen:Math.min((w-25)/Math.max(1,maxX-minX),(h-35)/Math.max(1,maxY-minY)),map=p=>{const q=project(p);return [x+10+(q[0]-minX)*s-tx,y+10+(q[1]-minY)*s-ty];};
  pdf.save().rect(x,y,w,h).clip().lineWidth(.45);for(const [a,b] of edges){pdf.moveTo(...map(a)).lineTo(...map(b)).stroke('#364c5d');}
  if(kind!=='customer')for(const symbol of data.meta.symbols){const q=map(symbol);pdf.lineWidth(.7);if(symbol.kind==='weld')pdf.moveTo(q[0],q[1]).lineTo(q[0]+8,q[1]).lineTo(q[0]+8,q[1]-8).closePath().stroke('#116878');else pdf.circle(q[0]+4,q[1]-4,4).stroke('#116878');pdf.fillColor('#116878').fontSize(9).text(symbol.label,q[0]+12,q[1]-8,{lineBreak:false});}
  if(kind!=='customer')for(const row of rows){const first=geometry[row.indices[0]][0];if(!first||!edges.includes(first))continue;const q=map(first[0]);pdf.fillColor('#116878').fontSize(8).text('P'+row.position,q[0]+3,q[1]-10,{lineBreak:false});}
  for(const o of data.objects.filter((o,i)=>o.type==='dim'&&edges.includes(geometry[i][0]))){const a=map({x:o.x,y:o.y,z:o.z||0}),b=map({x:o.x+o.w,y:o.y+o.h,z:(o.z||0)+(o.dz||0)});if(Math.hypot(a[0]-b[0],a[1]-b[1])>10)pdf.fillColor('#805c20').fontSize(8).text(Math.hypot(o.w,o.h,o.dz||0).toFixed(1)+' mm',(a[0]+b[0])/2,(a[1]+b[1])/2-10,{lineBreak:false});}
  pdf.restore();pdf.fillColor('black').fontSize(8).text(`${(maxX-minX).toFixed(1)} × ${(maxY-minY).toFixed(1)} mm · ${scaleDen?'Maßstab 1:'+scaleDen:'eingepasst'}`,x,y+h+3,{width:w});
 }
 function views(edges,title){if(!edges.length){page(title+' · keine Bauteile');return;}if(!denominator){page(title);projections.forEach(([label,project],i)=>diagram(edges,label,project,{x:30+i*260,y:100,w:245,h:380}));return;}
  for(const [label,project] of projections){const all=edges.flat().map(project),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),s=72/25.4/denominator,nx=Math.max(1,Math.ceil((Math.max(...xs)-Math.min(...xs))*s/720)),ny=Math.max(1,Math.ceil((Math.max(...ys)-Math.min(...ys))*s/400));for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){page(`${title} · ${label} · Blatt ${x+1}/${nx}, ${y+1}/${ny}`);diagram(edges,label,project,{x:30,y:95,w:740,h:420},denominator,x*720,y*400);pdf.fontSize(8).text('Bei 100 % drucken · Blattversatz 720 pt horizontal / 400 pt vertikal',30,550);}}
 }
 const info=row=>{const p=row.part;line(`Pos. ${row.position} · ${p.name} · ${row.quantity} Stück`);line(`${p.material} | ${row.dimensions} mm | Wand ${p.wall} mm | ${p.finish}`);line(`Mittellänge ${row.length===null?'–':row.length.toFixed(2)+' mm'} | Schnitt A ${p.cutStart}° / E ${p.cutEnd}°`);line(`Gehrungsrichtung A ${p.miterStart??0}° (${p.miterAxisStart==='height'?'Höhe/Tiefe':'Breite'}) / E ${p.miterEnd??0}° (${p.miterAxisEnd==='height'?'Höhe/Tiefe':'Breite'})`);line(`Bohrungen: ${p.drillCount} × Ø ${p.drillDiameter} mm`);for(const h of p.holes||[])line(`Bohrmittelpunkt X ${h.x} / Y ${h.y} / Ø ${h.d} mm (lokal ab Plattenecke)`);if(p.notes)line(p.notes);};
 if(kind==='labels'){
  let index=0;for(const r of rows)for(let n=0;n<r.quantity;n++,index++){if(index%8===0)page('Bauteiletiketten');const x=30+(index%2)*390,y=85+Math.floor(index%8/2)*110;pdf.rect(x,y,375,100).stroke('#859aa5');pdf.fillColor('black').fontSize(13).text(`Pos. ${r.position} · ${n+1}/${r.quantity} · ${r.part.name}`,x+10,y+10,{width:355});pdf.fontSize(10).text(`${r.part.material}\n${r.dimensions} mm\nZuschnitt ${r.length??'–'} mm · A ${r.part.cutStart}° / E ${r.part.cutEnd}°`,x+10,y+32,{width:355});}if(!index)page('Keine Bauteile');
 }else if(kind==='parts'){
  if(!rows.length)page('Keine Bauteile');for(const r of rows){views(geometry[r.indices[0]],'Einzelteil · Pos. '+r.position+' · '+r.part.name);page('Fertigungsmaße · Pos. '+r.position);pdf.y=85;info(r);}
 }else if(kind==='installation'){
  views(geometry.flat(),'Montageübersicht');page('Montagefolge & Materialbedarf');pdf.y=85;
  const steps=data.meta.installation.length?data.meta.installation:[{text:'Aufmaß und Anschlusspunkte prüfen.',done:false},{text:'Pfosten mit Platten ausrichten und befestigen.',done:false},{text:'Handläufe und Füllung anhand der Positionsliste montieren.',done:false},{text:'Verbindungen und Oberflächen prüfen.',done:false}];steps.forEach((s,i)=>line(`${s.done?'[x]':'[ ]'} ${i+1}. ${s.text}`));for(const r of rows)line(`Pos. ${r.position}: ${r.quantity} × ${r.part.name} · ${r.part.material}`);
 }else{
  views(geometry.flat(),kind==='customer'?'Kundenansicht':'Werkstattübersicht');
  if(kind!=='customer'){page('Stückliste & Fertigung');pdf.y=85;for(const r of rows){info(r);pdf.moveDown();}}
 }
 if(kind!=='customer'&&kind!=='labels'){
  page('Materialbedarf & Gewicht');pdf.y=85;const totals=new Map();let unknown=0;for(const o of data.objects){if(!o.part)continue;const w=design.weight(o),t=totals.get(o.part.material)||{weight:0,length:0,quantity:0};if(w===null)unknown++;else t.weight+=w;t.length+=(parts.length(o)||0)*o.part.quantity;t.quantity+=o.part.quantity;totals.set(o.part.material,t);}for(const [material,t] of totals)line(`${material}: ${t.quantity} Teile · ${(t.length/1000).toFixed(2)} m Profile · ca. ${t.weight.toFixed(2)} kg`);line('Gewicht aus Nennmaßen und Materialdichte; ohne Schweißzusatz und Beschichtung.');if(unknown)line(`${unknown} Teile mit unbekannter Dichte: Gewicht nicht berechnet.`);
  if(data.meta.siteNotes||data.meta.photos.length){page('Aufmaß & Baustellenfotos');pdf.y=85;if(data.meta.siteNotes)line(data.meta.siteNotes);for(const photo of data.meta.photos){page(photo.name);pdf.image(Buffer.from(photo.data.split(',')[1],'base64'),35,90,{fit:[760,440],align:'center',valign:'center'});}}
 }
 pdf.end();
}
module.exports={workshop,endpoints};
