/* Pick visible projected faces in the same order in which they are painted. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.CadPicking=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function distance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
  function inside(p,ring){let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;}
  function pick(p,faces,lines=[]){for(let i=lines.length-1;i>=0;i--)if(distance(p,lines[i].a,lines[i].b)<=5)return lines[i].index;
    for(let i=faces.length-1;i>=0;i--){const f=faces[i],poly=f.points;const edge=poly.some((a,j)=>distance(p,a,poly[(j+1)%poly.length])<=2);if((inside(p,poly)||edge)&&!(f.holes||[]).some(h=>inside(p,h)))return f.index;}return -1;
  }
  return {pick};
});
