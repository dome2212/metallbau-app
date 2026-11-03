(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'),require('./cad-railing'));else root.CadPost=factory(root.CadParts,root.CadRailing);})(typeof globalThis!=='undefined'?globalThis:this,function(parts,railing){
 'use strict';
 function generate(c){
  const profile=railing.profiles[c.profile];if(!profile||!railing.materials.includes(c.material)||!['Unbehandelt','Feuerverzinkt','Pulverbeschichtet','Geschliffen'].includes(c.finish))throw Error('Bitte gültiges Profil und Material wählen.');
  if(!Array.isArray(c.segments)||c.segments.length<1||c.segments.length>3||c.segments.some(s=>!Number.isFinite(s.length)||s.length<20||s.length>10000||!Number.isFinite(s.angle)||Math.abs(s.angle)>80)||c.segments[0].angle!==0)throw Error('Erster Abschnitt senkrecht; weitere Winkel von −80° bis 80° und Längen ab 20 mm.');
  if(!Number.isFinite(c.x)||!Number.isFinite(c.y)||Math.abs(c.x)>70000||Math.abs(c.y)>70000||!Number.isFinite(c.yaw)||Math.abs(c.yaw)>180)throw Error('Ungültige Position oder Ausrichtung.');
  if(!['none','below','front','back'].includes(c.mount))throw Error('Ungültige Plattenposition.');
  if(c.mount!=='none'&&(![c.plateWidth,c.plateHeight,c.plateThickness].every(n=>Number.isFinite(n)&&n>0&&n<=1000)))throw Error('Ungültige Plattenmaße.');
  const objects=[],yaw=c.yaw*Math.PI/180,rotate=(x,y)=>({x:c.x+x*Math.cos(yaw)-y*Math.sin(yaw),y:c.y+x*Math.sin(yaw)+y*Math.cos(yaw)});let cy=profile.h/2,z=0;
  for(let i=0;i<c.segments.length;i++){
   const s=c.segments[i],isRound=!!profile.round,origin=rotate(isRound?profile.b/2:0,isRound?cy:cy-profile.h/2),o={type:isRound?'circle':'rect',x:origin.x,y:origin.y,z,w:isRound?profile.b/2:profile.b,h:isRound?profile.b/2:profile.h,depth:s.length,angle:c.yaw,pitch:s.angle};
   const data={catalogId:'custom',name:`Pfosten · Abschnitt ${i+1}`,material:c.material,finish:c.finish,lengthAxis:'z',wall:profile.wall,notes:'Zuschnittlänge entlang der Profilachse.'};
   if(i>0){const m=(s.angle-c.segments[i-1].angle)/2;data.miterStart=m;data.miterAxisStart='height';data.cutStart=Math.abs(m);}
   if(i<c.segments.length-1){const m=-(c.segments[i+1].angle-s.angle)/2;data.miterEnd=m;data.miterAxisEnd='height';data.cutEnd=Math.abs(m);}
   o.part=parts.validatePart(data,o);objects.push(o);const a=s.angle*Math.PI/180;cy+=s.length*Math.sin(a);z+=s.length*Math.cos(a);
  }
  if(c.mount!=='none'){
   const x=(profile.b-c.plateWidth)/2,y=c.mount==='below'?(profile.h-c.plateHeight)/2:c.mount==='front'?-c.plateThickness:profile.h,p=rotate(x,y),o={type:'rect',x:p.x,y:p.y,z:c.mount==='below'?-c.plateThickness:0,w:c.plateWidth,h:c.mount==='below'?c.plateHeight:c.plateThickness,depth:c.mount==='below'?c.plateThickness:c.plateHeight,angle:c.yaw};
   o.part=parts.validatePart({catalogId:'custom',name:c.mount==='below'?'Fußplatte':'Seitenplatte',material:c.material,finish:c.finish,lengthAxis:'plate',notes:'Bohrungen und Befestigung projektspezifisch festlegen.'},o);objects.push(o);
  }
  return objects;
 }
 return {generate};
});
