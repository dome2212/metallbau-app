/* Construction helpers shared by the browser and geometry tests. All dimensions in mm. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'),require('./cad-railing'));else root.CadConstruction=factory(root.CadParts,root.CadRailing);})(typeof globalThis!=='undefined'?globalThis:this,function(parts,railing){
 'use strict';
 function number(c,key,min,max){const n=c[key];if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw Error('Maß prüfen: '+key+' ('+min+'–'+max+').');return n;}
 function material(c){if(!railing.materials.includes(c.material)||!['Unbehandelt','Feuerverzinkt','Pulverbeschichtet','Geschliffen'].includes(c.finish))throw Error('Material oder Oberfläche ungültig.');}
 function construct(c){
  material(c);const length=number(c,'length',20,20000),x=number(c,'x',-50000,50000),y=number(c,'y',-50000,50000),z=number(c,'z',-10000,50000),angle=number(c,'angle',-180,180);
  if(!['member','frame','ibeam','channel'].includes(c.kind)||!['horizontal','vertical'].includes(c.direction))throw Error('Konstruktionsart oder Ausrichtung ungültig.');
  const result=[],add=(o,name,wall=0,axis='x',extra={})=>{o.part=parts.validatePart({catalogId:'custom',name,material:c.material,finish:c.finish,lengthAxis:axis,wall,...extra},o);result.push(o);};
  const p=railing.profiles[c.profile];if(!p)throw Error('Profil auswählen.');
  const member=(xx,yy,len,vertical=false)=>{
   if(vertical){const round=p.round;add({type:round?'circle':'rect',x:round?xx:xx-p.b/2,y:round?yy:yy-p.h/2,z:0,w:round?p.b/2:p.b,h:round?p.b/2:p.h,depth:len},c.profile,p.wall,'z');}
   else add({type:'rect',x:xx,y:yy-p.b/2,z:0,w:len,h:p.b,depth:p.h},c.profile,p.wall,'x',p.round?{section:'round'}:{});
  };
  if(c.kind==='member')member(0,0,length,c.direction==='vertical');
  if(c.kind==='frame'){
   if(p.round)throw Error('Für den Rahmen ein Rechteck- oder Flachprofil auswählen.');const width=number(c,'width',p.b*2+20,20000);
   // Outside dimensions; side members fit exactly between the end members.
   member(0,p.b/2,length);member(0,width-p.b/2,length);
   for(const xx of [p.b/2,length-p.b/2]){if(length<=2*p.b)throw Error('Rahmenlänge muss größer als zwei Profilbreiten sein.');const n=result.length;member(0,0,width-2*p.b);const o=result[n];o.angle=90;o.x=xx+p.b/2;o.y=p.b;}
  }
  if(['ibeam','channel'].includes(c.kind)){
   const b=number(c,'width',20,1000),h=number(c,'height',20,1500),t=number(c,'thickness',1,100);if(2*t>=h||2*t>=b)throw Error('Trägerdicke muss kleiner als der halbe Querschnitt sein.');
   // Fabricated sections: three actual plates, not an inaccurate solid bounding box.
   for(const zz of [0,h-t])add({type:'rect',x:0,y:-b/2,z:zz,w:length,h:b,depth:t},'Trägerflansch · '+c.kind);
   add({type:'rect',x:0,y:c.kind==='ibeam'?-t/2:-b/2,z:t,w:length,h:t,depth:h-2*t},'Trägersteg · '+c.kind);
  }
  const a=angle*Math.PI/180;for(const o of result){const xx=o.x,yy=o.y;o.x=x+xx*Math.cos(a)-yy*Math.sin(a);o.y=y+xx*Math.sin(a)+yy*Math.cos(a);o.z+=z;o.angle=((o.angle||0)+angle+540)%360-180;}
  return result;
 }
 function sheet(c){
  material(c);const base=number(c,'base',20,5000),length=number(c,'length',20,10000),t=number(c,'thickness',.5,30),r=number(c,'radius',.5,100),k=number(c,'k',.2,.5),flange=number(c,'flange',10,1000);
  if(!['flat','l','u'].includes(c.shape)||!Number.isInteger(c.holes)||![0,2,4].includes(c.holes))throw Error('Blechform oder Bohrbild ungültig.');
  const n=c.shape==='flat'?0:c.shape==='l'?1:2,allowance=Math.PI/2*(r+k*t),w=base+n*(flange+allowance),offset=n?flange+allowance:0;
  const d=c.holes?number(c,'diameter',1,100):0,edge=number(c,'edge',1,1000),holes=[];
  if(c.holes){if(edge<=d/2||2*edge+d>=Math.min(base,length))throw Error('Bohrbild passt nicht in die gerade Grundfläche.');for(const xx of [edge,base-edge])for(const yy of c.holes===2?[length/2]:[edge,length-edge])holes.push({x:offset+xx,y:yy,d});}
  const blank={type:'rect',x:0,y:0,z:0,w,h:length,depth:t};
  const notes=`Kantteil ${c.shape.toUpperCase()}; Abwicklung ${w.toFixed(3)} × ${length} × ${t} mm; ${n} × 90°; Innenradius ${r}; K ${k}; Biegezugabe je Kantung ${allowance.toFixed(3)} mm. Eingabemaße sind gerade Tangentenlängen. K-Faktor anhand Werkzeug/Material prüfen.`;
  blank.part=parts.validatePart({catalogId:'custom',name:'Kantblech · Abwicklung',material:c.material,finish:c.finish,lengthAxis:'plate',notes,holes,drillCount:holes.length,drillDiameter:d},blank);
  const bends=n===0?[]:n===1?[flange+allowance/2]:[flange+allowance/2,offset+base+allowance/2];
  const objects=[blank,...bends.map(x=>({type:'line',x,y:0,z:t,w:0,h:length,depth:0,reference:true}))];
  // A separate reference assembly shows the fold without adding stock to the BOM.
  if(n){const x=w+150,basePlate={...blank,x:x+r+t,y:0,w:base,part:{...blank.part,name:'Kantvorschau · Grundfläche',holes:holes.map(h=>({...h,x:h.x-offset}))},reference:true};objects.push(basePlate);
   for(const xx of n===1?[x]:[x,x+base+2*r+t]){const o={type:'rect',x:xx,y:0,z:r+t,w:t,h:length,depth:flange,reference:true};o.part=parts.validatePart({catalogId:'custom',name:'Kantvorschau · Schenkel',material:c.material,finish:c.finish,lengthAxis:'plate'},o);objects.push(o);}
   // Four joined polygon sectors approximate each quarter-circle bend.
   for(const [side,cx] of n===1?[[-1,x+r+t]]:[[-1,x+r+t],[1,x+r+t+base]])for(let i=0;i<4;i++){
    const a=(i+.5)*Math.PI/8,rad=r+t/2,half=Math.PI/16,sectionT=t*Math.cos(half),ds=2*rad*Math.sin(half),pitch=(Math.PI/2-a)*180/Math.PI;
    const centerX=cx+side*rad*Math.sin(a)*Math.cos(half),centerZ=r+t-rad*Math.cos(a)*Math.cos(half);
    // local +Y tilts toward side*X after yaw; center the segment on its tangent.
    const yaw=side===1?-90:90,oy=length/2,ox=centerX;
    const o={type:'rect',x:ox,y:oy,z:centerZ-ds*Math.cos(pitch*Math.PI/180)/2,w:length,h:sectionT,depth:ds,pitch,angle:yaw,reference:true};
    // Cross-section origin is rotated so its centre lies at the desired bend centre.
    const ar=yaw*Math.PI/180;o.x=ox-length/2*Math.cos(ar)+sectionT/2*Math.sin(ar)-side*ds*Math.sin(pitch*Math.PI/180)/2;o.y=oy-length/2*Math.sin(ar)-sectionT/2*Math.cos(ar);
    o.part=parts.validatePart({catalogId:'custom',name:'Kantvorschau · Biegeradius',material:c.material,finish:c.finish,lengthAxis:'z',miterStart:-11.25,miterEnd:11.25,cutStart:11.25,cutEnd:11.25,miterAxisStart:'height',miterAxisEnd:'height'},o);objects.push(o);
   }
  }
  return {objects,blank,bends,width:w,length,allowance,notes};
 }
 function laser(o){
  if(o?.type!=='rect'||o.part?.lengthAxis!=='plate'||o.reference||o.shear)throw Error('Eine rechteckige Platte oder Blechabwicklung auswählen.');
  const lines=['0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC','0','SECTION','2','ENTITIES'];
  const line=(layer,x,y,xx,yy)=>lines.push('0','LINE','8',layer,'10',String(x),'20',String(y),'30','0','11',String(xx),'21',String(yy),'31','0');
  line('CUT',0,0,o.w,0);line('CUT',o.w,0,o.w,o.h);line('CUT',o.w,o.h,0,o.h);line('CUT',0,o.h,0,0);
  for(const h of o.part.holes||[])lines.push('0','CIRCLE','8','CUT','10',String(h.x),'20',String(h.y),'30','0','40',String(h.d/2));
  if(o.part.name.startsWith('Kantblech')&&o.generator?.kind!=='sheet')throw Error('Kantdaten fehlen bei dieser Kopie. Blech für den Kantlinienexport neu erzeugen.');
  if(o.generator?.kind==='sheet'){
   const s=sheet(o.generator.config);if(Math.abs(s.width-o.w)>1e-6||Math.abs(s.length-o.h)>1e-6||Math.abs(o.depth-s.blank.depth)>1e-6)throw Error('Blechmaße wurden geändert. Abwicklung neu erzeugen, bevor Kantlinien exportiert werden.');
   for(const x of s.bends)line('BEND',x,0,x,o.h);
  }
  // Position/mark on a dedicated etching layer, separate from the cut paths.
  const label='PLATTE '+o.w.toFixed(2)+'x'+o.h.toFixed(2)+'x'+o.depth.toFixed(2);
  lines.push('0','TEXT','8','MARK','10',String(o.w/2),'20',String(o.h/2),'30','0','40',String(Math.min(3,o.w/(label.length*.7))),'1',label,'72','1','11',String(o.w/2),'21',String(o.h/2),'0','ENDSEC','0','EOF');return lines.join('\r\n');
 }
 return {construct,sheet,laser};
});
