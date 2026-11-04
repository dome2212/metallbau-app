/* Construct triangulated CAD solids from the same profile/miter definitions as the 2D editor. */
export function buildGeometry(o, THREE, parts) {
 if(!['rect','circle'].includes(o.type))return null;
 const isX=o.part?.lengthAxis==='x',wall=o.part?.wall||0,base=o.z||0,round=isX?o.part?.section==='round':o.type==='circle';
 const W=isX?o.h:o.type==='circle'?2*o.w:o.w,H=isX?o.depth:o.type==='circle'?2*o.w:o.h;
 const ring=(inset=0)=>round?Array.from({length:48},(_,i)=>{const a=-i*2*Math.PI/48;return new THREE.Vector2(W/2+Math.cos(a)*(W/2-inset),H/2+Math.sin(a)*(H/2-inset));}):[new THREE.Vector2(inset,inset),new THREE.Vector2(inset,H-inset),new THREE.Vector2(W-inset,H-inset),new THREE.Vector2(W-inset,inset)];
 const outer=ring(),holes=[];
 if(wall)holes.push(ring(wall).reverse());
 if(!isX&&!wall&&o.type==='rect')for(const h of o.part?.holes||[])holes.push(Array.from({length:32},(_,i)=>{const a=i*2*Math.PI/32;return new THREE.Vector2(h.x+Math.cos(a)*h.d/2,h.y+Math.sin(a)*h.d/2);}));
 const to3=(p,end)=>{const which=end?'end':'start';if(isX){const y=o.y+p.x,z=base+p.y,x=o.x+(end?o.w:0)+parts.miterOffset(o,which,p.x-W/2,p.y-H/2),q=parts.rotate(o,{x,y});return [q.x,q.y,z];}
 const local={x:o.type==='circle'?o.x-o.w+p.x:o.x+p.x,y:o.type==='circle'?o.y-o.w+p.y:o.y+p.y},world=parts.rotate(o,local),d=(end?o.depth:0)+parts.miterOffset(o,which,p.x-W/2,p.y-H/2),q=parts.profilePoint(o,world,d);return [q.x,q.y,q.z];};
 const triangles=THREE.ShapeUtils.triangulateShape(outer,holes),points=[outer,...holes].flat(),positions=[];
 const triangle=(a,b,c)=>positions.push(...a,...c,...b);
 for(const [a,b,c] of triangles){triangle(to3(points[a],false),to3(points[b],false),to3(points[c],false));triangle(to3(points[c],true),to3(points[b],true),to3(points[a],true));}
 for(const ring of [outer,...holes])for(let i=0;i<ring.length;i++){const j=(i+1)%ring.length,a=to3(ring[i],false),b=to3(ring[j],false),c=to3(ring[j],true),d=to3(ring[i],true);triangle(a,b,c);triangle(a,c,d);}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();geometry.computeBoundingBox();return geometry;
}
