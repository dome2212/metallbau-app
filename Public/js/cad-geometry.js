/* Two-dimensional drafting geometry in millimetres. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.CadGeometry=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const EPS=1e-9;
const cross=(a,b)=>a.x*b.y-a.y*b.x;
function lineIntersection(a,b){
 if(a.type!=='line'||b.type!=='line')throw Error('Zwei Linien auswählen.');
 const v={x:a.w,y:a.h},w={x:b.w,y:b.h},l=Math.hypot(v.x,v.y),m=Math.hypot(w.x,w.y),den=cross(v,w);
 if(l<EPS||m<EPS||Math.abs(den)<EPS*l*m)throw Error('Linien sind parallel oder zu kurz.');
 const d={x:b.x-a.x,y:b.y-a.y},t=cross(d,w)/den,u=cross(d,v)/den;return {x:a.x+t*v.x,y:a.y+t*v.y,t,u};
}
function trim(a,b,end){
 if(!['start','end'].includes(end))throw Error('Linienende auswählen.');const p=lineIntersection(a,b);
 if(p.u<-EPS||p.u>1+EPS)throw Error('Der Schnittpunkt liegt außerhalb der Begrenzungslinie.');
 const opposite=end==='start'?{x:a.x+a.w,y:a.y+a.h}:{x:a.x,y:a.y};if(Math.hypot(p.x-opposite.x,p.y-opposite.y)<.01)throw Error('Die Linie würde zu kurz.');
 const result={...a};if(end==='start'){result.x=p.x;result.y=p.y;result.w=opposite.x-p.x;result.h=opposite.y-p.y;}else{result.w=p.x-a.x;result.h=p.y-a.y;}
 if(end==='start'&&p.t>=1-EPS||end==='end'&&p.t<=EPS)throw Error('Das Linienende würde über das andere Ende hinauslaufen.');return result;
}
function offset(o,d){
 if(!Number.isFinite(d)||Math.abs(d)<EPS)throw Error('Abstand ungleich null eingeben.');
 const copy=JSON.parse(JSON.stringify(o));for(const key of ['groupId','generator','memberKey','objectId'])delete copy[key];
 if(o.type==='line'){const l=Math.hypot(o.w,o.h);if(l<EPS)throw Error('Linie ist zu kurz.');copy.x-=o.h/l*d;copy.y+=o.w/l*d;}
 else if(o.type==='circle'&&!o.part){copy.w=o.w+d;copy.h=copy.w;if(copy.w<=0)throw Error('Abstand ergibt keinen positiven Radius.');}
 else throw Error('Eine Linie oder einen freien Kreis auswählen.');return copy;
}
function lineCircle(a,b,c){const dx=b.x-a.x,dy=b.y-a.y,A=dx*dx+dy*dy;if(A<EPS)return [];const x=a.x-c.x,y=a.y-c.y,B=2*(x*dx+y*dy),C=x*x+y*y-c.r*c.r,disc=B*B-4*A*C,tol=EPS*Math.max(1,B*B,Math.abs(4*A*C));if(disc < -tol)return [];const root=Math.sqrt(Math.max(0,disc)),ts=root<EPS?[-B/(2*A)]:[(-B-root)/(2*A),(-B+root)/(2*A)];return ts.filter(t=>t>=-EPS&&t<=1+EPS).map(t=>({x:a.x+t*dx,y:a.y+t*dy}));}
function circleCircle(a,b){const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);if(d<EPS||d>a.r+b.r+EPS||d<Math.abs(a.r-b.r)-EPS)return [];const x=(a.r*a.r-b.r*b.r+d*d)/(2*d),h2=a.r*a.r-x*x;if(h2 < -EPS*Math.max(1,a.r*a.r))return [];const h=Math.sqrt(Math.max(0,h2)),cx=a.x+x*dx/d,cy=a.y+x*dy/d;return h<EPS?[{x:cx,y:cy}]:[{x:cx-h*dy/d,y:cy+h*dx/d},{x:cx+h*dy/d,y:cy-h*dx/d}];}
function orthogonal(a,b){return Math.abs(b.x-a.x)>=Math.abs(b.y-a.y)?{x:b.x,y:a.y}:{x:a.x,y:b.y};}
return {lineIntersection,trim,offset,lineCircle,circleCircle,orthogonal};
});
