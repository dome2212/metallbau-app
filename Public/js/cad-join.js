/* Join compatible horizontal profiles at the intersection of their centrelines. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'));else root.CadJoin=factory(root.CadParts);})(typeof globalThis!=='undefined'?globalThis:this,function(parts){
 'use strict';
 const cross=(a,b)=>a.x*b.y-a.y*b.x, dot=(a,b)=>a.x*b.x+a.y*b.y;
 function join(a,b){
  if(!a||!b||a===b||a.type!=='rect'||b.type!=='rect'||a.part?.lengthAxis!=='x'||b.part?.lengthAxis!=='x')throw Error('Bitte zwei waagerechte Profile auswählen.');
  if(Math.abs(a.h-b.h)>1e-6||Math.abs(a.depth-b.depth)>1e-6||Math.abs((a.z||0)-(b.z||0))>1e-6||Math.abs(a.part.wall-b.part.wall)>1e-6||(a.part.section||'rect')!==(b.part.section||'rect'))throw Error('Profile müssen gleiche Querschnitte, Wandstärke und Höhe haben.');
  const axis=o=>{const t=(o.angle||0)*Math.PI/180,u={x:Math.cos(t),y:Math.sin(t)},n={x:-u.y,y:u.x};return {u,n,p:{x:o.x+n.x*o.h/2,y:o.y+n.y*o.h/2}};};
  const aa=axis(a),bb=axis(b),det=cross(aa.u,bb.u);if(Math.abs(det)<1e-5)throw Error('Profile müssen sich in einem Winkel schneiden.');
  const delta={x:bb.p.x-aa.p.x,y:bb.p.y-aa.p.y},da=cross(delta,bb.u)/det,db=cross(delta,aa.u)/det;
  const endA=Math.abs(da)<=Math.abs(da-a.w)?'start':'end',endB=Math.abs(db)<=Math.abs(db-b.w)?'start':'end';
  const distA=Math.abs(da-(endA==='start'?0:a.w)),distB=Math.abs(db-(endB==='start'?0:b.w)),limit=Math.max(100,4*a.h);
  if(distA>limit||distB>limit)throw Error('Die Profilenden liegen zu weit vom Schnittpunkt entfernt.');
  const awayA={x:aa.u.x*(endA==='start'?1:-1),y:aa.u.y*(endA==='start'?1:-1)},awayB={x:bb.u.x*(endB==='start'?1:-1),y:bb.u.y*(endB==='start'?1:-1)};
  const tangent={x:awayA.x+awayB.x,y:awayA.y+awayB.y};if(Math.hypot(tangent.x,tangent.y)<.1)throw Error('Der Winkel ist für eine Eckverbindung zu klein.');
  function apply(o,ax,d,end){const denom=dot(tangent,ax.n);if(Math.abs(denom)<1e-5)throw Error('Gehrung kann bei diesem Winkel nicht erzeugt werden.');const angle=Math.atan(dot(tangent,ax.u)/denom)*180/Math.PI;if(Math.abs(angle)>89)throw Error('Gehrungswinkel ist zu groß.');const out={...o};if(end==='start'){out.x=o.x+ax.u.x*d;out.y=o.y+ax.u.y*d;out.w=o.w-d;}else out.w=d;if(out.w<=0||out.w>100000||Math.abs(out.x)>100000||Math.abs(out.y)>100000)throw Error('Verbindung ergibt eine ungültige Profillänge.');const key=end==='start'?'miterStart':'miterEnd',plane=end==='start'?'miterAxisStart':'miterAxisEnd',cut=end==='start'?'cutStart':'cutEnd';out.part=parts.validatePart({...o.part,[key]:angle,[plane]:'width',[cut]:Math.abs(angle)},out);return out;}
  const first=apply(a,aa,da,endA),second=apply(b,bb,db,endB);return {first,second,endA,endB};
 }
 return {join};
});
