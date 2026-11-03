(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'),require('./cad-railing'));else root.CadWorkflow=factory(root.CadParts,root.CadRailing);})(typeof globalThis!=='undefined'?globalThis:this,function(parts,railing){
'use strict';
function generate(c){
 if(c.rise!==undefined&&(!Number.isFinite(c.rise)||c.rise<0))throw Error('Ungültige Stufenhöhe.');
 const stair=Number(c.rise)>0;
 if(stair&&(!Number.isFinite(c.run)||!Number.isFinite(c.steps)||!Number.isFinite(c.rise)||c.run<100||c.run>1000||c.rise>350||!Number.isInteger(c.steps)||c.steps<1||c.steps>50||c.corner))throw Error('Treppe: 1–50 Stufen, Auftritt 100–1000 mm, Steigung bis 350 mm; gerade Laufrichtung wählen.');
 const slope=stair?Math.atan(c.rise/c.run):0,cos=Math.cos(slope),s=Math.tan(slope);
 if(stair&&(slope<10*Math.PI/180||slope>60*Math.PI/180))throw Error('Treppenwinkel muss zwischen 10° und 60° liegen.');
 const width=stair?c.steps*c.run:c.width;
 const g=railing.generate({...c,width,angle:stair?0:c.angle,x:stair?0:c.x,y:stair?0:c.y,postRailJoint:stair?'butt':c.postRailJoint});
 if(stair){const rail=railing.profiles[c.railProfile],post=railing.profiles[c.postProfile],thick=rail.h/cos;if(c.height<=c.clearance+2*thick+10)throw Error('Füllung passt bei dieser Steigung nicht zwischen die Gurte.');
 for(let i=0;i<g.objects.length;i++){let o=g.objects[i];if(o.type==='dim'){if(o.w){o.dz=o.w*s;}continue;}
 const cx=o.type==='circle'?o.x:o.x+o.w/2;
 if(o.part.lengthAxis==='x'){
  const x=o.x,L=o.w,top=o.part.name==='Handlauf',centerZ=(top?c.height-thick/2:c.clearance+thick/2)+x*s;
  const t=90-slope*180/Math.PI;
  const q={type:rail.round?'circle':'rect',x:x-rail.h/2,y:post.h/2+rail.b/2,z:centerZ,w:rail.round?rail.b/2:rail.b,h:rail.round?rail.b/2:rail.h,depth:L/cos,angle:-90,pitch:t};
  if(rail.round){q.x=x;q.y=post.h/2;}
  const data={...o.part,lengthAxis:'z',miterStart:-slope*180/Math.PI,miterEnd:-slope*180/Math.PI,miterAxisStart:'height',miterAxisEnd:'height',cutStart:slope*180/Math.PI,cutEnd:slope*180/Math.PI};delete data.section;q.part=parts.validatePart(data,q);g.objects[i]=q;
 }else if(o.part.name==='Pfosten'||o.part.name==='Füllstab'){
  const bar=o.part.name==='Füllstab';o.z=(bar?c.clearance+thick:0)+cx*s;o.depth=bar?c.height-c.clearance-2*thick:c.height-thick;
  const angle=slope*180/Math.PI;o.part=parts.validatePart({...o.part,...(bar?{miterStart:angle,miterAxisStart:'width',cutStart:angle}:{}),miterEnd:angle,miterAxisEnd:'width',cutEnd:angle},o);
 }else if(o.part.name==='Glasfüllung'){o.z=c.clearance+thick+5+cx*s;o.depth=c.height-c.clearance-2*thick-10;o.shear=s;o.part=parts.validatePart(o.part,o);
 }else{o.z=(o.z||0)+cx*s;}
 }
 const a=(c.angle||0)*Math.PI/180;for(const o of g.objects){const x=o.x,y=o.y;o.x=c.x+x*Math.cos(a)-y*Math.sin(a);o.y=c.y+x*Math.sin(a)+y*Math.cos(a);o.angle=((o.angle||0)+(c.angle||0)+540)%360-180;if(o.type==='dim'){const w=o.w,h=o.h;o.w=w*Math.cos(a)-h*Math.sin(a);o.h=w*Math.sin(a)+h*Math.cos(a);}}
 }
 if(c.glassClamps&&c.glassClamps!=='none'){
 if(c.glassClamps!=='4'||c.infill!=='glass')throw Error('Glashalter benötigen eine Glasfüllung.');
 for(const glass of g.objects.filter(o=>o.part?.name==='Glasfüllung'))for(const right of [false,true])for(const top of [false,true]){
 if(glass.w<50||glass.depth<70)throw Error('Das Glasfeld ist für vier Halter zu klein.');
 const x=right?glass.w-20:0,z=top?glass.depth-25:0;
 for(const [name,dx,dy,w,h] of [['Klemmbacke',x,-5,20,5],['Klemmbacke',x,glass.h,20,5],['Steg',right?glass.w: -5,-5,5,glass.h+10]]){
 const q=parts.rotate(glass,{x:glass.x+dx,y:glass.y+dy}),o={type:'rect',x:q.x,y:q.y,z:glass.z+z+(glass.shear||0)*(x+10-glass.w/2),w,h,depth:25,angle:glass.angle||0};o.part=parts.validatePart({catalogId:'custom',name:'Glashalter · '+name,material:c.materialRail||c.material,finish:c.finish,wall:0,lengthAxis:'plate',notes:'Schematischer Klemmhalter; Abmessungen und Eignung mit dem gewählten System abstimmen.'},o);g.objects.push(o);
 }
 }
 }
 if(c.fasteners&&c.fasteners!=='none'){
 const diameter=Number(c.fasteners);if(![10,12,16].includes(diameter))throw Error('Ungültige Befestigung.');
 const plates=g.objects.filter(o=>o.part?.name==='Fußplatte');if(!plates.length)throw Error('Anker benötigen eine Platte unter dem Pfosten.');
 for(const plate of plates){const edge=Math.max(18,diameter*1.5),d=diameter+2,holes=[];for(const x of [edge,plate.w-edge])for(const y of [edge,plate.h-edge])holes.push({x,y,d});plate.part=parts.validatePart({...plate.part,holes,drillCount:4,drillDiameter:d},plate);
 for(const h of holes){const p=parts.rotate(plate,{x:plate.x+h.x,y:plate.y+h.y}),o={type:'circle',x:p.x,y:p.y,z:plate.z-80,w:diameter/2,h:diameter/2,depth:100};o.part=parts.validatePart({catalogId:'custom',name:`Anker M${diameter}`,material:'Befestigungsstahl',wall:0,lengthAxis:'z',notes:'Ankerlänge 100 mm; Bohrtiefe und Untergrund projektspezifisch festlegen.'},o);g.objects.push(o);}}
 }
 return g;
}
function cutCsv(objects){
 const quote=v=>'"'+String(v).replace(/[\r\n]/g,' ').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
 return '\ufeffPos;Menge;Profil;Länge;Bemerkung\n'+parts.rows(objects).filter(r=>r.length!==null&&!r.part.name.startsWith('Anker ')).map(r=>{const o=objects[r.indices[0]],p=r.part,cross=o.type==='circle'?[o.w*2,o.w*2]:p.lengthAxis==='x'?[o.h,o.depth]:[o.w,o.h],extra=end=>Math.abs(Math.tan((p[end==='start'?'miterStart':'miterEnd']||0)*Math.PI/180))*cross[(p[end==='start'?'miterAxisStart':'miterAxisEnd']||'width')==='height'?1:0]/2;
 return [r.position,r.quantity,`${p.material} | ${o.type==='circle'||p.section==='round'?'Rundprofil Ø ':'Rechteckprofil '}${cross.join(' x ')} | t ${p.wall} | ${p.finish}`,Math.ceil((r.length+extra('start')+extra('end'))*100)/100,`${p.name}: Mittellänge ${r.length.toFixed(2)} mm; Schnitt ${p.cutStart} / ${p.cutEnd} Grad`].map(quote).join(';');}).join('\n');
}
return {generate,cutCsv};});
