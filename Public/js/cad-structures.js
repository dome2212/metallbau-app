(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'),require('./cad-railing'));else root.CadStructures=factory(root.CadParts,root.CadRailing);})(typeof globalThis!=='undefined'?globalThis:this,function(parts,railing){'use strict';
function generate(c){
 const width=Number(c.width),depth=Number(c.depth),height=Number(c.height),material=c.material||'S235JR';
 if(!['canopy','carport','fence','balcony','spiral'].includes(c.type)||![width,depth,height].every(Number.isFinite)||width<600||width>10000||depth<600||depth>10000||height<800||height>6000)throw Error('Maße prüfen: Breite und Tiefe 600–10.000 mm, Höhe 800–6.000 mm.');
 const result=[],part=(o,name,axis,wall=0)=>{o.part=parts.validatePart({catalogId:'custom',name,material,finish:'Unbehandelt',lengthAxis:axis,wall,notes:'Vorlage schematisch; Anschlüsse, Querschnitte und Bemessung projektspezifisch festlegen.'},o);result.push(o);};
 const post=(x,y,z,h,name='Pfosten')=>part({type:'rect',x:x-30,y:y-30,z,w:60,h:60,depth:h},name,'z',3);
 const beam=(x1,y1,x2,y2,z,name='Rahmenprofil')=>{const w=40,len=Math.hypot(x2-x1,y2-y1),a=Math.atan2(y2-y1,x2-x1);part({type:'rect',x:x1+Math.sin(a)*w/2,y:y1-Math.cos(a)*w/2,z,w:len,h:w,depth:40,angle:a*180/Math.PI},name,'x',2);};
 const plate=(x,y,z,w,h,d,name)=>part({type:'rect',x,y,z,w,h,depth:d},name,'plate');
 if(c.type==='fence'){for(const x of [30,width-30])post(x,0,0,height);for(const z of [100,height-40])beam(30,0,width-30,0,z,'Zaunriegel');const n=Math.max(1,Math.ceil((width-60)/110)-1);for(let i=1;i<=n;i++)part({type:'rect',x:30+(width-60)*i/(n+1)-6,y:-6,z:140,w:12,h:12,depth:height-180},'Füllstab','z');}
 if(c.type==='canopy'||c.type==='carport'){if(c.type==='carport')for(const x of [30,width-30])for(const y of [30,depth-30])post(x,y,0,height);else for(const x of [30,width-30])post(x,depth-30,0,height);for(const y of [30,depth-30])beam(30,y,width-30,y,height,'Dachträger');for(const x of [30,width-30])beam(x,30,x,depth-30,height,'Dachträger');plate(0,0,height+40,width,depth,8,'Dachfläche');}
 if(c.type==='balcony'){
  const railHeight=c.railHeight??1000,deckThickness=c.deckThickness??40,profile=c.balconyProfile??'40x40x2',infill=c.balconyInfill??'bars';
  if(!Number.isFinite(railHeight)||railHeight<400||railHeight>2000||!Number.isFinite(deckThickness)||deckThickness<3||deckThickness>100||!railing.profiles[profile]||!['bars','glass','open'].includes(infill))throw Error('Balkon: Geländerhöhe, Profil, Füllung und Bodenstärke prüfen.');
  plate(0,0,height,width,depth,deckThickness,'Balkonboden');
  for(const x of [30,width-30])for(const y of [30,depth-30])post(x,y,0,height,'Balkonstütze');
  const p=railing.profiles[profile],g=railing.generate({sections:[{width:depth,turn:0},{width:width,turn:-90},{width:depth,turn:-90}],angle:90,x:p.h,y:0,width:depth,height:railHeight,postSpacing:1000,clearance:100,barGap:100,postProfile:profile,railProfile:profile,barProfile:'12x12x0',material,finish:'Unbehandelt',infill,glassType:'VSG',glassThickness:10,plateMount:'none',postRailJoint:'butt'});
  for(const o of g.objects){o.z=(o.z||0)+height+deckThickness;result.push(o);}
 }
 if(c.type==='spiral'){const radius=Math.min(width,depth)/2,steps=Math.max(6,Math.min(36,Math.ceil(height/180))),centerX=width/2,centerY=depth/2;part({type:'circle',x:centerX,y:centerY,z:0,w:50,h:50,depth:height},'Spindel','z',4);for(let i=0;i<steps;i++){const a=2*Math.PI*i/(steps-1),len=radius-55,w=Math.max(80,Math.min(250,2*Math.PI*radius/steps*.7)),x=centerX+Math.cos(a)*55+Math.sin(a)*w/2,y=centerY+Math.sin(a)*55-Math.cos(a)*w/2;part({type:'rect',x,y,z:(i+1)*height/steps-8,w:len,h:w,depth:8,angle:(a*180/Math.PI+180)%360-180},'Spindelstufe · schematisch','plate');}}
 result.push({type:'dim',x:0,y:-120,z:0,w:width,h:0,depth:0},{type:'dim',x:-120,y:0,z:0,w:0,h:depth,depth:0});return result;
}
return {generate};});
