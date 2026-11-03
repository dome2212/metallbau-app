/* Shared, deterministic part model used by CAD and fabrication exports. Units: mm. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CadParts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const catalog = [
    {id:'rhs',name:'Rechteckrohr',category:'Hohlprofile',symbol:'▣',type:'rect',w:60,h:40,depth:1000,wall:3,axis:'z'},
    {id:'shs',name:'Quadratrohr',category:'Hohlprofile',symbol:'▣',type:'rect',w:40,h:40,depth:1000,wall:3,axis:'z'},
    {id:'chs',name:'Rundrohr',category:'Hohlprofile',symbol:'◎',type:'circle',w:24.15,h:24.15,depth:1000,wall:2.6,axis:'z'},
    {id:'flat',name:'Flachstahl',category:'Vollmaterial',symbol:'▬',type:'rect',w:40,h:8,depth:1000,wall:0,axis:'z'},
    {id:'round',name:'Rundstahl',category:'Vollmaterial',symbol:'●',type:'circle',w:10,h:10,depth:1000,wall:0,axis:'z'},
    {id:'rhs80',name:'Rechteckrohr 80 × 40 × 3',category:'Hohlprofile',symbol:'▣',type:'rect',w:80,h:40,depth:1000,wall:3,axis:'z'},
    {id:'rhs100',name:'Rechteckrohr 100 × 50 × 3',category:'Hohlprofile',symbol:'▣',type:'rect',w:100,h:50,depth:1000,wall:3,axis:'z'},
    {id:'shs60',name:'Quadratrohr 60 × 60 × 3',category:'Hohlprofile',symbol:'▣',type:'rect',w:60,h:60,depth:1000,wall:3,axis:'z'},
    {id:'chs42',name:'Rundrohr 42,4 × 2,6',category:'Hohlprofile',symbol:'◎',type:'circle',w:21.2,h:21.2,depth:1000,wall:2.6,axis:'z'},
    {id:'flat50',name:'Flachstahl 50 × 10',category:'Vollmaterial',symbol:'▬',type:'rect',w:50,h:10,depth:1000,wall:0,axis:'z'},
    {id:'flat60',name:'Flachstahl 60 × 6',category:'Vollmaterial',symbol:'▬',type:'rect',w:60,h:6,depth:1000,wall:0,axis:'z'},
    {id:'plate',name:'Blechplatte',category:'Bleche',symbol:'▱',type:'rect',w:200,h:150,depth:8,wall:0,axis:'plate'}
  ];
  function text(value, fallback, max) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > max) throw Error('Ungültiger oder zu langer Bauteiltext.');
    return value.trim();
  }
  function number(value, fallback, min, max, integer=false) {
    if(value === undefined) return fallback;
    if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw Error('Ungültiger Zahlenwert in den Fertigungsdaten.');
    return value;
  }
  function validatePart(value, o) {
    if (value===undefined) return undefined;
    if(!value||typeof value!=='object'||Array.isArray(value)||!['rect','circle'].includes(o.type))throw Error('Bauteildaten nur für geschlossene Konturen möglich.');
    const id=text(value.catalogId,'custom',30), template=catalog.find(t=>t.id===id);
    if(id!=='custom'&&!template)throw Error('Unbekanntes Bibliotheksbauteil.');
    if(template&&template.type!==o.type)throw Error('Profil und Kontur passen nicht zusammen.');
    if(template&&o.depth<=0)throw Error('Bauteillänge bzw. Blechdicke muss positiv sein.');
    if(['shs','shs60'].includes(id)&&o.w!==o.h)throw Error('Beim Quadratrohr müssen Breite und Höhe gleich sein.');
    const axis=value.lengthAxis===undefined?(template?.axis||'plate'):value.lengthAxis;
    if(!['x','z','plate'].includes(axis)||(axis==='x'&&o.type!=='rect')||(template&&axis!==template.axis))throw Error('Ungültige Profilausrichtung.');
    if(value.section!==undefined&&(value.section!=='round'||axis!=='x'||o.type!=='rect'||Math.abs(o.h-o.depth)>1e-7))throw Error('Rundprofil benötigt einen kreisförmigen Querschnitt.');
    const wall=number(value.wall,template?.wall||0,0,10000);
    if(template&&!template.wall&&wall!==0)throw Error('Vollmaterial und Blech haben keine Hohlprofil-Wandstärke.');
    if((template?.wall>0&&wall<=0)||(wall>0&&wall*2>=(axis==='x'?Math.min(o.h,o.depth):Math.min(o.w*(o.type==='circle'?2:1),o.h*(o.type==='circle'?2:1)))))throw Error('Wandstärke muss kleiner als der halbe Querschnitt sein.');
    const part={catalogId:id,name:text(value.name,template?.name||'Freies Bauteil',100),material:text(value.material,'S235JR',60),quantity:number(value.quantity,1,1,10000,true),wall,finish:text(value.finish,'Unbehandelt',80),cutStart:number(value.cutStart,0,0,89),cutEnd:number(value.cutEnd,0,0,89),drillCount:number(value.drillCount,0,0,10000,true),drillDiameter:number(value.drillDiameter,0,0,1000),notes:text(value.notes,'',500)};
    if(value.lengthAxis!==undefined)part.lengthAxis=axis;if(value.section!==undefined)part.section=value.section;
    for(const key of ['miterStart','miterEnd'])if(value[key]!==undefined){
      const v=number(value[key],0,-89,89);if(axis==='plate'||(axis==='x'&&o.type!=='rect'))throw Error('Gehrungen sind nur für Profile möglich.');
      part[key]=v;
      const cut=key==='miterStart'?'cutStart':'cutEnd';if(Math.abs(v)!==part[cut])throw Error('Gehrung und Schnittwinkel müssen übereinstimmen.');
    }
    for(const [key,cut] of [['miterAxisStart','miterStart'],['miterAxisEnd','miterEnd']])if(value[key]!==undefined){
      if(!['width','height'].includes(value[key])||part[cut]===undefined)throw Error('Ungültige Schnittebene.');part[key]=value[key];
    }
    if(part.miterStart||part.miterEnd){
      const length=axis==='x'?o.w:o.depth, width=axis==='x'?o.h:(o.type==='circle'?o.w*2:o.w), height=axis==='x'?o.depth:(o.type==='circle'?o.w*2:o.h);
      const slope=(end,plane)=>((part[end==='start'?'miterAxisStart':'miterAxisEnd']||'width')===plane?Math.tan((part[end==='start'?'miterStart':'miterEnd']||0)*Math.PI/180):0);
      const overlap=Math.abs(slope('end','width')-slope('start','width'))*width/2+Math.abs(slope('end','height')-slope('start','height'))*height/2;
      if(length<=overlap+1e-8)throw Error('Die Gehrungen überschneiden sich. Profil länger oder Winkel kleiner wählen.');
    }
    if(value.holes!==undefined){
      if(!Array.isArray(value.holes)||value.holes.length>100||axis!=='plate'||o.type!=='rect'||wall!==0)throw Error('Ungültige Plattenbohrungen.');
      part.holes=value.holes.map(h=>{if(!h||typeof h.x!=='number'||typeof h.y!=='number'||typeof h.d!=='number'||![h.x,h.y,h.d].every(Number.isFinite)||h.d<=0||h.d>1000||h.x-h.d/2<=0||h.x+h.d/2>=o.w||h.y-h.d/2<=0||h.y+h.d/2>=o.h)throw Error('Bohrung muss vollständig innerhalb der Platte liegen.');return {x:h.x,y:h.y,d:h.d};});
      for(let i=0;i<part.holes.length;i++)for(let j=0;j<i;j++){const a=part.holes[i],b=part.holes[j];if(Math.hypot(a.x-b.x,a.y-b.y)<=(a.d+b.d)/2)throw Error('Bohrungen dürfen sich nicht überschneiden.');}
      if(part.drillCount!==part.holes.length||part.holes.some(h=>h.d!==part.drillDiameter))throw Error('Bohrungsangaben müssen mit der Geometrie übereinstimmen.');
    }
    if(!part.name||!part.material)throw Error('Bezeichnung und Material sind erforderlich.');
    if(part.drillCount>0&&part.drillDiameter<=0)throw Error('Für Bohrungen einen positiven Durchmesser eintragen.');
    return part;
  }
  function create(id) {
    const t=catalog.find(t=>t.id===id);if(!t)throw Error('Unbekanntes Bauteil.');
    const o={type:t.type,x:0,y:0,w:t.w,h:t.h,depth:t.depth};o.part=validatePart({catalogId:id},o);return o;
  }
  // Profiles are XY cross sections extruded along Z; free contours and plates use W×H×D.
  function dimensions(o) {if(o.part?.section==='round')return `Ø ${o.h} × ${o.w}`;return o.type==='circle'?`Ø ${o.w*2} × ${o.depth}`:`${o.w} × ${o.h} × ${o.depth}`;}
  function length(o) {const axis=o.part?.lengthAxis||catalog.find(t=>t.id===o.part?.catalogId)?.axis;return axis==='z'?o.depth:axis==='x'?o.w:null;}
  function rows(objects) {
    const groups=new Map();
    objects.forEach((o,index)=>{
      if(!['rect','circle'].includes(o.type))return;
      const p=o.part||validatePart({catalogId:'custom',name:o.type==='circle'?'Freier Rundkörper':'Freie Rechteckkontur',material:'Nicht zugeordnet'},o);
      const groupKey=JSON.stringify([o.type,o.w,o.h,o.depth,o.pitch||0,{...p,quantity:0}]);
      if(!groups.has(groupKey))groups.set(groupKey,{position:groups.size+1,indices:[],part:p,dimensions:dimensions(o),length:length(o),pitch:o.pitch||0,quantity:0});
      const row=groups.get(groupKey);row.indices.push(index);row.quantity+=p.quantity;
    });return [...groups.values()];
  }
  function csvCell(value) {let s=String(value??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
  function csv(objects,production=false) {
    const header=['Pos','Bauteil','Material','Maße mm (B × H × Tiefe / Ø × Tiefe)','Wand mm','Menge','Zuschnittlänge mm','Oberfläche'];
    if(production)header.push('Schnitt Anfang °','Schnitt Ende °','Bohrungen je Teil','Bohrung Ø mm','Hinweise','Geometrie Anfang °','Geometrie Ende °','Bohrpositionen (X/Y/Ø mm)','Schnittebene Anfang','Schnittebene Ende','Profilachse','Neigung zur Senkrechten °');
    const data=rows(objects).map(r=>{const p=r.part,a=[r.position,p.name,p.material,r.dimensions,p.wall,r.quantity,r.length??'',p.finish];if(production)a.push(p.cutStart,p.cutEnd,p.drillCount,p.drillDiameter,p.notes,p.miterStart??'',p.miterEnd??'',p.holes?.map(h=>`${h.x}/${h.y}/${h.d}`).join(' | ')||'',p.miterStart!==undefined?(p.miterAxisStart||'width'):'',p.miterEnd!==undefined?(p.miterAxisEnd||'width'):'',p.lengthAxis||catalog.find(t=>t.id===p.catalogId)?.axis||'plate',r.pitch);return a;});
    return '\uFEFF'+[header,...data].map(r=>r.map(csvCell).join(';')).join('\r\n');
  }
  function rotate(o,p,reverse=false) {const a=(o.angle||0)*Math.PI/180*(reverse?-1:1),x=p.x-o.x,y=p.y-o.y;return {x:o.x+x*Math.cos(a)-y*Math.sin(a),y:o.y+x*Math.sin(a)+y*Math.cos(a)};}
  // Signed angles define the slope of each end in local coordinates. Length is measured at the profile centre.
  function miterOffset(o,end,widthOffset,heightOffset=0){const part=o.part||{},angle=part[end==='start'?'miterStart':'miterEnd']||0,axis=part[end==='start'?'miterAxisStart':'miterAxisEnd']||'width';return Math.tan(angle*Math.PI/180)*(axis==='height'?heightOffset:widthOffset);}
  // Profile axis tilts toward local +Y; rotation about local X keeps the cross-section perpendicular.
  function profilePoint(o,p,d){const l=rotate(o,p,true),cy=o.type==='circle'?o.y:o.y+o.h/2,theta=(o.pitch||0)*Math.PI/180,dy=l.y-cy;const q=rotate(o,{x:l.x,y:cy+dy*Math.cos(theta)+d*Math.sin(theta)});return{x:q.x,y:q.y,z:(o.z||0)-dy*Math.sin(theta)+d*Math.cos(theta)+(o.shear||0)*(l.x-(o.x+o.w/2))};}
  function footprint(o){const ring=rings(o).outer,cy=o.type==='circle'?o.y:o.y+o.h/2,cx=o.type==='circle'?o.x:o.x+o.w/2,points=[];for(const p of ring){const local=rotate(o,p,true);for(const end of ['start','end']){const d=(end==='start'?0:o.depth)+miterOffset(o,end,local.x-cx,local.y-cy);points.push(profilePoint(o,p,d));}}points.sort((a,b)=>a.x-b.x||a.y-b.y);const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),half=arr=>{const h=[];for(const p of arr){while(h.length>1&&cross(h[h.length-2],h[h.length-1],p)<=1e-9)h.pop();h.push(p);}return h;};const a=half(points),b=half([...points].reverse());return a.slice(0,-1).concat(b.slice(0,-1));}
  function rings(o) {
    const wall=o.part?.wall||0;
    if(o.type==='circle') {const ring=r=>Array.from({length:48},(_,i)=>({x:o.x+Math.cos(i/48*Math.PI*2)*r,y:o.y+Math.sin(i/48*Math.PI*2)*r}));return {outer:ring(o.w),inner:wall?ring(o.w-wall):null};}
    const ring=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
    const orient=points=>points.map(p=>{if(o.part?.lengthAxis==='x'){const end=p.x===o.x?'start':'end';p.x+=miterOffset(o,end,p.y-(o.y+o.h/2));}return rotate(o,p);});
    return {outer:orient(ring(o.x,o.y,o.w,o.h)),inner:wall?orient(ring(o.x+wall,o.y+wall,o.w-2*wall,o.h-2*wall)):null};
  }
  return {catalog,validatePart,create,dimensions,length,rows,csv,rings,rotate,miterOffset,profilePoint,footprint};
});
