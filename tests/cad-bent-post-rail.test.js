const {test}=require('node:test'),assert=require('node:assert/strict');
const parts=require('../Public/js/cad-parts'),posts=require('../Public/js/cad-post'),joiner=require('../Public/js/cad-join');
const base={profile:'40x40x2',material:'S235JR',finish:'Unbehandelt',x:0,y:0,yaw:0,mount:'none'};
function handrail(post,end,reverse=1){
 const t=(post.angle||0)*Math.PI/180,angle=(post.angle||0)+90+(reverse<0?180:0),r=angle*Math.PI/180,u={x:Math.cos(r),y:Math.sin(r)},n={x:-u.y,y:u.x},c=post.type==='circle'?{x:post.x,y:post.y}:parts.rotate(post,{x:post.x+post.w/2,y:post.y+post.h/2}),p=post.pitch*Math.PI/180,z=post.z+post.depth*Math.cos(p),intersection={x:c.x-Math.sin(t)*post.depth*Math.sin(p),y:c.y+Math.cos(t)*post.depth*Math.sin(p)},l=end==='start'?0:500,w=post.type==='circle'?post.w*2:post.w,h=post.type==='circle'?post.w*2:post.h;
 const rail={type:'rect',x:intersection.x-u.x*l-n.x*w/2,y:intersection.y-u.y*l-n.y*w/2,z:z-h/2,w:500,h:w,depth:h,angle};
 rail.part=parts.validatePart({catalogId:'custom',name:'Handlauf',wall:post.part.wall,lengthAxis:'x',...(post.type==='circle'?{section:'round'}:{})},rail);return rail;
}
function check(post,rail,end){
 const angle=rail.angle*Math.PI/180,u={x:Math.cos(angle),y:Math.sin(angle)},n={x:-u.y,y:u.x},origin={x:rail.x+n.x*rail.h/2,y:rail.y+n.y*rail.h/2};
 for(const point of parts.rings(post).outer){const l=parts.rotate(post,point,true),cx=post.type==='circle'?post.x:post.x+post.w/2,cy=post.type==='circle'?post.y:post.y+post.h/2,p=parts.profilePoint(post,point,post.depth+parts.miterOffset(post,'end',l.x-cx,l.y-cy)),x=(p.x-origin.x)*u.x+(p.y-origin.y)*u.y,expected=(end==='start'?0:rail.w)+parts.miterOffset(rail,end,0,p.z-(rail.z+rail.depth/2));assert.ok(Math.abs(x-expected)<1e-6,JSON.stringify({p,x,expected}));}
}
test('bent posts with one or two bends meet horizontal handrail along the complete cut plane',()=>{
 for(const angles of [[0,30],[0,-35,20],[0,40,0]])for(const yaw of [0,37])for(const end of ['start','end'])for(const reverse of [1,-1])for(const profile of ['40x40x2','round42.4x2.6']){
  const sections=posts.generate({...base,yaw,profile,segments:angles.map((angle,i)=>({length:i?300:1000,angle}))}),last=sections.at(-1),firstCut=last.part.miterStart,rail=handrail(last,end,reverse),result=joiner.joinPostRail(last,rail);
  assert.equal(result.endB,end);assert.equal(result.first.part.miterStart,firstCut);assert.equal(result.first.part.miterAxisEnd,'height');check(result.first,result.second,end);
 }
});
test('incorrect direction, cross sections and lateral displacement are rejected without mutation',()=>{
 const p=posts.generate({...base,segments:[{length:1000,angle:0},{length:300,angle:30}]}).at(-1),r=handrail(p,'start'),snapshot=JSON.stringify([p,r]);
 assert.throws(()=>joiner.joinPostRail(p,{...r,angle:0}),/Richtung/);
 assert.throws(()=>joiner.joinPostRail(p,{...r,h:50}),/Querschnitte/);
 assert.throws(()=>joiner.joinPostRail(p,{...r,x:r.x+30}),/seitlich/);
 assert.equal(JSON.stringify([p,r]),snapshot);
});
