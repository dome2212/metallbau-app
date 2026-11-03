/* Straight railing generator. Dimensions are millimetres; Z is height. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'));else root.CadRailing=factory(root.CadParts);})(typeof globalThis!=='undefined'?globalThis:this,function(parts){
  'use strict';
  const profiles={
    '40x40x2':{size:40,wall:2},'50x50x2':{size:50,wall:2},'60x60x3':{size:60,wall:3},
    '30x30x2':{size:30,wall:2},'20x20x2':{size:20,wall:2},'16x16x0':{size:16,wall:0},'12x12x0':{size:12,wall:0}
  };
  function generateStraight(c){
    const numeric=['width','height','postSpacing','clearance','barGap','x','y'];
    if(numeric.some(k=>typeof c[k]!=='number'||!Number.isFinite(c[k])))throw Error('Bitte gültige Maße eingeben.');
    if(c.width<300||c.width>20000||c.height<400||c.height>3000||c.postSpacing<100||c.postSpacing>3000||c.clearance<0||c.clearance>1000||c.barGap<20||c.barGap>1000||Math.abs(c.x)>70000||Math.abs(c.y)>70000)throw Error('Bitte Maße innerhalb der angegebenen Grenzen eingeben.');
    if(!['S235JR','S355J2','Edelstahl 1.4301','Aluminium EN AW-6060'].includes(c.material)||!['Unbehandelt','Feuerverzinkt','Pulverbeschichtet','Geschliffen'].includes(c.finish)||!['bars','open'].includes(c.infill))throw Error('Ungültige Material- oder Füllungsauswahl.');
    const post=profiles[c.postProfile],rail=profiles[c.railProfile],bar=profiles[c.barProfile];if(!post||!rail||!bar)throw Error('Bitte gültige Profile auswählen.');
    if(c.width<=post.size*2||c.height<=rail.size*2+c.clearance)throw Error('Länge oder Höhe ist für diese Profile zu klein.');
    const spans=Math.ceil((c.width-post.size)/c.postSpacing),step=(c.width-post.size)/spans,clear=step-post.size;
    if(clear<=0)throw Error('Der Pfostenabstand ist für dieses Profil zu klein.');
    const n=c.infill==='bars'?Math.max(0,Math.ceil((clear-c.barGap)/(c.barGap+bar.size))):0;
    if(n*bar.size>clear)throw Error('Füllstäbe passen nicht zwischen die Pfosten.');
    if((spans+1)+spans*n+1+spans+(c.plates?spans+1:0)>1900)throw Error('Zu viele Bauteile. Bitte Länge oder Abstände anpassen.');
    const objects=[],round=n=>Math.round(n*1000)/1000;
    function add(name,x,y,z,w,h,depth,profile,axis,notes=''){
      const o={type:'rect',x:round(c.x+x),y:round(c.y+y),z:round(z),w:round(w),h:round(h),depth:round(depth)};
      o.part=parts.validatePart({catalogId:'custom',name,material:c.material,finish:c.finish,wall:profile.wall,lengthAxis:axis,notes},o);objects.push(o);
    }
    for(let i=0;i<=spans;i++){
      const x=round(i*step);add('Pfosten',x,0,0,post.size,post.size,c.height-rail.size,post,'z');
      if(c.plates)add('Fußplatte',x-(c.plateSize-post.size)/2,(post.size-c.plateSize)/2,-c.plateThickness,c.plateSize,c.plateSize,c.plateThickness,{wall:0},'plate','Bohrungen und Befestigung projektspezifisch festlegen.');
    }
    const railY=(post.size-rail.size)/2;
    add('Handlauf',0,railY,c.height-rail.size,c.width,rail.size,rail.size,rail,'x');
    for(let i=0;i<spans;i++)add('Untergurt',i*step+post.size,railY,c.clearance,clear,rail.size,rail.size,rail,'x');
    if(c.infill==='bars')for(let i=0;i<spans;i++)for(let j=1;j<=n;j++){
      const x=i*step+post.size+j*(clear-n*bar.size)/(n+1)+(j-1)*bar.size;
      add('Füllstab',x,(post.size-bar.size)/2,c.clearance+rail.size,bar.size,bar.size,c.height-2*rail.size-c.clearance,bar,'z');
    }
    return {objects,posts:spans+1,bars:spans*n,span:round(step),opening:round((clear-n*bar.size)/(n+1))};
  }
  function generate(c){
    const angle=c.angle??0,turn=c.turn??90,corner=c.corner??false;
    if(typeof angle!=='number'||!Number.isFinite(angle)||Math.abs(angle)>180)throw Error('Ausrichtungswinkel muss zwischen −180° und 180° liegen.');
    if(corner&&(typeof turn!=='number'||!Number.isFinite(turn)||Math.abs(turn)<10||Math.abs(turn)>170))throw Error('Eckwinkel muss zwischen 10° und 170° liegen (links oder rechts).');
    const first=generateStraight(c),size=profiles[c.postProfile].size;
    const rotate=(x,y,a)=>({x:x*Math.cos(a)-y*Math.sin(a),y:x*Math.sin(a)+y*Math.cos(a)});
    const toWorld=(o,origin,a)=>{const p=rotate(o.x-c.x,o.y-c.y,a);o.x=Math.round((origin.x+p.x)*1000)/1000;o.y=Math.round((origin.y+p.y)*1000)/1000;o.angle=Math.round((((a*180/Math.PI+180)%360+360)%360-180)*1000)/1000;};
    const a=angle*Math.PI/180, origin={x:c.x,y:c.y};first.objects.forEach(o=>toWorld(o,origin,a));
    const checkBounds=items=>{if(items.some(o=>Math.abs(o.x)>100000||Math.abs(o.y)>100000))throw Error('Geländer liegt außerhalb des Zeichenbereichs.');};
    if(!corner){checkBounds(first.objects);return first;}
    if(typeof c.width2!=='number'||!Number.isFinite(c.width2))throw Error('Länge des zweiten Abschnitts eingeben.');
    const second=generateStraight({...c,width:c.width2}), b=a+turn*Math.PI/180;
    const center=rotate(c.width-size/2,size/2,a), localCenter=rotate(size/2,size/2,b);
    const start={x:c.x+center.x-localCenter.x,y:c.y+center.y-localCenter.y};
    const removedPost=second.objects.findIndex(o=>o.part.name==='Pfosten');second.objects.splice(removedPost,1);
    if(c.plates){const plate=second.objects.findIndex(o=>o.part.name==='Fußplatte');second.objects.splice(plate,1);}
    second.objects.forEach(o=>toWorld(o,start,b));checkBounds([...first.objects,...second.objects]);
    const note='Eckverbindung: Zuschnitt und Anschluss vor Fertigung festlegen.';
    for(const o of [...first.objects,...second.objects])if(o.part.name==='Handlauf')o.part.notes=note;
    return {objects:[...first.objects,...second.objects],posts:first.posts+second.posts-1,bars:first.bars+second.bars,span:first.span,opening:Math.max(first.opening,second.opening),secondSpan:second.span};
  }
  return {profiles,generate};
});
