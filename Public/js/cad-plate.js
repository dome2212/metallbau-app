(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'));else root.CadPlate=factory(root.CadParts);})(typeof globalThis!=='undefined'?globalThis:this,function(parts){
 'use strict';
 function create(c){
  for(const k of ['w','h','depth','rows','cols','edgeX','edgeY','diameter','x','y'])if(typeof c[k]!=='number'||!Number.isFinite(c[k]))throw Error('Bitte gültige Maße eingeben.');
  if(c.w<10||c.w>10000||c.h<10||c.h>10000||c.depth<=0||c.depth>1000||Math.abs(c.x)>70000||Math.abs(c.y)>70000||!Number.isInteger(c.rows)||!Number.isInteger(c.cols)||c.rows<0||c.cols<0||c.rows>10||c.cols>10||(c.rows===0)!==(c.cols===0))throw Error('Bitte gültige Plattenmaße und Bohrungszahlen eingeben.');
  const holes=[];if(c.rows){if(c.diameter<=0||c.edgeX<=0||c.edgeY<=0)throw Error('Bohrdurchmesser und Randabstände müssen positiv sein.');for(let i=0;i<c.cols;i++)for(let j=0;j<c.rows;j++)holes.push({x:c.cols===1?c.w/2:c.edgeX+i*(c.w-2*c.edgeX)/(c.cols-1),y:c.rows===1?c.h/2:c.edgeY+j*(c.h-2*c.edgeY)/(c.rows-1),d:c.diameter});}
  const o={type:'rect',x:c.x,y:c.y,w:c.w,h:c.h,depth:c.depth,z:0};o.part=parts.validatePart({catalogId:'custom',name:'Platte',material:c.material,finish:c.finish,lengthAxis:'plate',drillCount:holes.length,drillDiameter:holes.length?c.diameter:0,holes},o);return o;
 }
 return {create};
});
