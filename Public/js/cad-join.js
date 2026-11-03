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
 function joinPostRail(post,rail){
  if(!post||!rail||post.part?.lengthAxis!=='z'||rail.part?.lengthAxis!=='x'||rail.type!=='rect')throw Error('Bitte einen Pfosten und einen waagerechten Handlauf wählen.');
  const relative=((rail.angle||0)-(post.angle||0))*Math.PI/180;
  if(Math.abs(Math.cos(relative))<1e-5)return joinTiltedPostRail(post,rail);
  if(post.pitch)throw Error('Der Handlauf muss in Richtung des Pfostenknicks verlaufen.');
  const round=post.type==='circle',w=round?post.w*2:post.w,h=round?post.w*2:post.h;
  if(Math.abs(w-rail.depth)>1e-6||Math.abs(h-rail.h)>1e-6||Math.abs(post.part.wall-rail.part.wall)>1e-6||round!==(rail.part.section==='round'))throw Error('Pfosten und Handlauf benötigen gleiche Querschnitte und Wandstärken. Alternativ stumpf anschließen.');
  const pa=(post.angle||0)*Math.PI/180,ra=(rail.angle||0)*Math.PI/180,align=Math.cos(pa-ra);if(Math.abs(Math.sin(pa-ra))>1e-5)throw Error('Die Profilachsen passen für diese Verbindung nicht zusammen.');
  const u={x:Math.cos(ra),y:Math.sin(ra)},n={x:-u.y,y:u.x},center=round?{x:post.x,y:post.y}:parts.rotate(post,{x:post.x+post.w/2,y:post.y+post.h/2}),start={x:rail.x+n.x*rail.h/2,y:rail.y+n.y*rail.h/2},v={x:center.x-start.x,y:center.y-start.y},d=dot(v,u),side=Math.abs(dot(v,n));
  if(side>.01)throw Error('Pfosten und Handlauf müssen seitlich aufeinander ausgerichtet sein.');
  const railEnd=Math.abs(d)<=Math.abs(d-rail.w)?'start':'end',offset=Math.abs(d-(railEnd==='start'?0:rail.w)),height=(rail.z||0)+rail.depth/2-(post.z||0),limit=Math.max(100,4*rail.depth);
  if(offset>limit||Math.abs(height-post.depth)>limit)throw Error('Die Profilenden liegen zu weit auseinander.');
  const sign=railEnd==='start'?-1:1,vertical={...post,depth:height},horizontal={...rail};if(railEnd==='start'){horizontal.x+=u.x*d;horizontal.y+=u.y*d;horizontal.w-=d;}else horizontal.w=d;
  if(vertical.depth<=0||vertical.depth>100000||horizontal.w<=0||horizontal.w>100000)throw Error('Verbindung ergibt eine ungültige Profillänge.');
  vertical.part=parts.validatePart({...post.part,miterEnd:sign*45*Math.sign(align),miterAxisEnd:'width',cutEnd:45},vertical);
  const key=railEnd==='start'?'miterStart':'miterEnd',axis=railEnd==='start'?'miterAxisStart':'miterAxisEnd',cut=railEnd==='start'?'cutStart':'cutEnd';
  horizontal.part=parts.validatePart({...rail.part,[key]:sign*45,[axis]:'height',[cut]:45},horizontal);return {first:vertical,second:horizontal,endA:'end',endB:railEnd};
 }
 function joinTiltedPostRail(post,rail){
  const round=post.type==='circle',width=round?post.w*2:post.w,height=round?post.w*2:post.h;
  if(Math.abs(width-rail.h)>1e-6||Math.abs(height-rail.depth)>1e-6||Math.abs(post.part.wall-rail.part.wall)>1e-6||round!==(rail.part.section==='round'))throw Error('Pfosten und Handlauf benötigen gleiche Querschnitte und Wandstärken. Alternativ stumpf anschließen.');
  const pa=(post.angle||0)*Math.PI/180,ra=(rail.angle||0)*Math.PI/180,theta=(post.pitch||0)*Math.PI/180;
  const V={x:Math.cos(ra),y:Math.sin(ra)},N={x:-V.y,y:V.x},Y={x:-Math.sin(pa),y:Math.cos(pa)};
  if(Math.abs(cross(V,Y))>1e-5)throw Error('Der Handlauf muss in Richtung des Pfostenknicks verlaufen.');
  const center=round?{x:post.x,y:post.y}:parts.rotate(post,{x:post.x+post.w/2,y:post.y+post.h/2});
  const start={x:rail.x+N.x*rail.h/2,y:rail.y+N.y*rail.h/2},z=(rail.z||0)+rail.depth/2;
  const length=(z-(post.z||0))/Math.cos(theta),intersection={x:center.x+Y.x*Math.sin(theta)*length,y:center.y+Y.y*Math.sin(theta)*length},delta={x:intersection.x-start.x,y:intersection.y-start.y},d=dot(delta,V),side=Math.abs(dot(delta,N));
  if(side>.01)throw Error('Pfosten und Handlauf müssen seitlich aufeinander ausgerichtet sein.');
  const end=Math.abs(d)<=Math.abs(d-rail.w)?'start':'end',offset=Math.abs(d-(end==='start'?0:rail.w)),limit=Math.max(100,4*rail.depth);
  if(offset>limit||Math.abs(length-post.depth)>limit)throw Error('Die Profilenden liegen zu weit auseinander.');
  const away=end==='start'?1:-1,sy=dot(V,Y)*away;
  // The common cut plane follows the bisector of the two axes pointing away from the joint.
  const ty=sy-Math.sin(theta),tz=-Math.cos(theta),postAngle=Math.atan2(ty*Math.sin(theta)+tz*Math.cos(theta),ty*Math.cos(theta)-tz*Math.sin(theta))*180/Math.PI;
  const railAngle=Math.atan2(ty*dot(Y,V),tz)*180/Math.PI;
  const normalAngle=a=>Math.round((a>90?a-180:a<-90?a+180:a)*1e10)/1e10;
  const pAngle=normalAngle(postAngle),rAngle=normalAngle(railAngle),vertical={...post,depth:length},horizontal={...rail};
  if(end==='start'){horizontal.x+=V.x*d;horizontal.y+=V.y*d;horizontal.w-=d;}else horizontal.w=d;
  if(length<=0||length>100000||horizontal.w<=0||horizontal.w>100000||Math.abs(horizontal.x)>100000||Math.abs(horizontal.y)>100000)throw Error('Verbindung ergibt eine ungültige Profillänge.');
  vertical.part=parts.validatePart({...post.part,miterEnd:pAngle,miterAxisEnd:'height',cutEnd:Math.abs(pAngle)},vertical);
  const key=end==='start'?'miterStart':'miterEnd',axis=end==='start'?'miterAxisStart':'miterAxisEnd',cut=end==='start'?'cutStart':'cutEnd';
  horizontal.part=parts.validatePart({...rail.part,[key]:rAngle,[axis]:'height',[cut]:Math.abs(rAngle)},horizontal);
  return {first:vertical,second:horizontal,endA:'end',endB:end};
 }
 function joinAny(a,b){if(a?.part?.lengthAxis==='z'&&b?.part?.lengthAxis==='x')return joinPostRail(a,b);if(a?.part?.lengthAxis==='x'&&b?.part?.lengthAxis==='z'){const r=joinPostRail(b,a);return{first:r.second,second:r.first,endA:r.endB,endB:r.endA};}return join(a,b);}
 return {join,joinPostRail,joinAny};
});
