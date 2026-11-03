/* Straight railing generator. Dimensions are millimetres; Z is height. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'));else root.CadRailing=factory(root.CadParts);})(typeof globalThis!=='undefined'?globalThis:this,function(parts){
  'use strict';
  // Querschnitt in mm: bei Pfosten/Befüllung X × Y, beim Gurt Y × Z.
  const profiles={
    '40x40x2':{size:40,b:40,h:40,wall:2},'50x50x2':{size:50,b:50,h:50,wall:2},'60x60x3':{size:60,b:60,h:60,wall:3},
    '30x30x2':{size:30,b:30,h:30,wall:2},'20x20x2':{size:20,b:20,h:20,wall:2},'16x16x0':{size:16,b:16,h:16,wall:0},'12x12x0':{size:12,b:12,h:12,wall:0},
    '60x40x2':{size:60,b:60,h:40,wall:2},'80x40x3':{size:80,b:80,h:40,wall:3},'100x50x3':{size:100,b:100,h:50,wall:3},
    '40x20x2':{size:40,b:40,h:20,wall:2},'50x30x2':{size:50,b:50,h:30,wall:2},
    'flat40x8':{size:40,b:40,h:8,wall:0},'flat50x10':{size:50,b:50,h:10,wall:0},'flat60x6':{size:60,b:60,h:6,wall:0},
    'round42.4x2.6':{size:42.4,b:42.4,h:42.4,wall:2.6,round:true},'round48.3x2.6':{size:48.3,b:48.3,h:48.3,wall:2.6,round:true},
    'round33.7x2':{size:33.7,b:33.7,h:33.7,wall:2,round:true},'round20':{size:20,b:20,h:20,wall:0,round:true},'round12':{size:12,b:12,h:12,wall:0,round:true}
  };
  const materials=['S235JR','S275JR','S355J2','S355J2+N','S235J2','Edelstahl 1.4301','Edelstahl 1.4307','Edelstahl 1.4404','Edelstahl 1.4571','Aluminium EN AW-6060','Aluminium EN AW-6063','Aluminium EN AW-6082'];
  function generateStraight(c){
    const numeric=['width','height','postSpacing','clearance','barGap','x','y'];
    if(numeric.some(k=>typeof c[k]!=='number'||!Number.isFinite(c[k])))throw Error('Bitte gültige Maße eingeben.');
    if(c.width<300||c.width>20000||c.height<400||c.height>3000||c.postSpacing<100||c.postSpacing>3000||c.clearance<0||c.clearance>1000||c.barGap<20||c.barGap>1000||Math.abs(c.x)>70000||Math.abs(c.y)>70000)throw Error('Bitte Maße innerhalb der angegebenen Grenzen eingeben.');
    if(!materials.includes(c.material)||['materialPost','materialRail','materialBar'].some(k=>c[k]&&!materials.includes(c[k]))||!['Unbehandelt','Feuerverzinkt','Pulverbeschichtet','Geschliffen'].includes(c.finish)||!['bars','open','glass'].includes(c.infill))throw Error('Ungültige Material- oder Füllungsauswahl.');
    const post=profiles[c.postProfile],rail=profiles[c.railProfile],bar=profiles[c.barProfile];if(!post||!rail||!bar)throw Error('Bitte gültige Profile auswählen.');
    if(c.width<=post.size*2||c.height<=rail.h*2+c.clearance)throw Error('Länge oder Höhe ist für diese Profile zu klein.');
    const spans=Math.ceil((c.width-post.size)/c.postSpacing),step=(c.width-post.size)/spans,clear=step-post.size;
    if(clear<=0)throw Error('Der Pfostenabstand ist für dieses Profil zu klein.');
    if(c.infill==='glass'&&(!Number.isFinite(c.glassThickness)||c.glassThickness<4||c.glassThickness>30||!['VSG','ESG'].includes(c.glassType)))throw Error('Bitte Glastyp und Glasdicke zwischen 4 und 30 mm eingeben.');
    const n=c.infill==='bars'?Math.max(0,Math.ceil((clear-c.barGap)/(c.barGap+bar.size))):0;
    if(n*bar.size>clear)throw Error('Füllstäbe passen nicht zwischen die Pfosten.');
    if((spans+1)+spans*n+(c.infill==='glass'?spans:0)+1+spans+(c.plates?spans+1:0)>1900)throw Error('Zu viele Bauteile. Bitte Länge oder Abstände anpassen.');
    const objects=[],round=n=>Math.round(n*1000)/1000;
    function add(name,x,y,z,w,h,depth,profile,axis,notes=''){
      const isRound=profile.round&&axis==='z', o={type:isRound?'circle':'rect',x:round(c.x+x+(isRound?w/2:0)),y:round(c.y+y+(isRound?h/2:0)),z:round(z),w:round(isRound?w/2:w),h:round(isRound?h/2:h),depth:round(depth)};
      const material=(name==='Pfosten'||name==='Fußplatte'?c.materialPost:name==='Handlauf'||name==='Untergurt'?c.materialRail:c.materialBar)||c.material;
      const data={catalogId:'custom',name,material,finish:c.finish,wall:profile.wall,lengthAxis:axis,notes};if(profile.round&&axis==='x')data.section='round';
      o.part=parts.validatePart(data,o);objects.push(o);
    }
    for(let i=0;i<=spans;i++){
      const x=round(i*step);add('Pfosten',x,0,0,post.b,post.h,c.height-rail.h,post,'z');
      if(c.plates)add('Fußplatte',x-(c.plateSize-post.b)/2,(post.h-c.plateSize)/2,-c.plateThickness,c.plateSize,c.plateSize,c.plateThickness,{wall:0},'plate','Bohrungen und Befestigung projektspezifisch festlegen.');
    }
    const railY=(post.h-rail.b)/2;
    add('Handlauf',0,railY,c.height-rail.h,c.width,rail.b,rail.h,rail,'x');
    for(let i=0;i<spans;i++)add('Untergurt',i*step+post.size,railY,c.clearance,clear,rail.b,rail.h,rail,'x');
    if(c.infill==='bars')for(let i=0;i<spans;i++)for(let j=1;j<=n;j++){
      const x=i*step+post.size+j*(clear-n*bar.size)/(n+1)+(j-1)*bar.size;
      add('Füllstab',x,(post.h-bar.h)/2,c.clearance+rail.h,bar.b,bar.h,c.height-2*rail.h-c.clearance,bar,'z');
    }
    if(c.infill==='glass')for(let i=0;i<spans;i++){
      const gap=5, width=clear-2*gap, height=c.height-2*rail.h-c.clearance-2*gap;
      if(width<=0||height<=0)throw Error('Glasfüllung passt nicht in das Feld.');
      const o={type:'rect',x:round(c.x+i*step+post.size+gap),y:round(c.y+(post.h-c.glassThickness)/2),z:round(c.clearance+rail.h+gap),w:round(width),h:c.glassThickness,depth:round(height)};
      o.part=parts.validatePart({catalogId:'custom',name:'Glasfüllung',material:`Glas ${c.glassType}`,finish:'Kanten bearbeiten',lengthAxis:'plate',notes:'Glashalterung, Glasaufbau und erforderliche Abstände projektspezifisch festlegen.'},o);objects.push(o);
    }
    return {objects,posts:spans+1,bars:spans*n,span:round(step),opening:round((clear-n*bar.size)/(n+1))};
  }
  function generate(c){
    const angle=c.angle??0,turn=c.turn??90,corner=c.corner??false;
    if(typeof angle!=='number'||!Number.isFinite(angle)||Math.abs(angle)>180)throw Error('Ausrichtungswinkel muss zwischen −180° und 180° liegen.');
    if(corner&&(typeof turn!=='number'||!Number.isFinite(turn)||Math.abs(turn)<10||Math.abs(turn)>170))throw Error('Eckwinkel muss zwischen 10° und 170° liegen (links oder rechts).');
    const first=generateStraight(c),size=profiles[c.postProfile].size,postDepth=profiles[c.postProfile].h;
    const rotate=(x,y,a)=>({x:x*Math.cos(a)-y*Math.sin(a),y:x*Math.sin(a)+y*Math.cos(a)});
    const toWorld=(o,origin,a)=>{const p=rotate(o.x-c.x,o.y-c.y,a);o.x=Math.round((origin.x+p.x)*1000)/1000;o.y=Math.round((origin.y+p.y)*1000)/1000;o.angle=Math.round((((a*180/Math.PI+180)%360+360)%360-180)*1000)/1000;};
    const a=angle*Math.PI/180, origin={x:c.x,y:c.y};first.objects.forEach(o=>toWorld(o,origin,a));
    const checkBounds=items=>{if(items.some(o=>Math.abs(o.x)>100000||Math.abs(o.y)>100000))throw Error('Geländer liegt außerhalb des Zeichenbereichs.');};
    const dim=(x,y,dx,dy,z,dz)=>({type:'dim',x:Math.round(x*1000)/1000,y:Math.round(y*1000)/1000,w:Math.round(dx*1000)/1000,h:Math.round(dy*1000)/1000,z,dz,depth:0});
    const addDimensions=(items,start,bearing,width)=>{const d=rotate(width,0,bearing),offset=rotate(0,-120,bearing),heightOffset=rotate(-100,0,bearing);items.push(dim(start.x+offset.x,start.y+offset.y,d.x,d.y,0,0),dim(start.x+heightOffset.x,start.y+heightOffset.y,0,0,0,c.height));};
    if(!corner){addDimensions(first.objects,origin,a,c.width);checkBounds(first.objects);return first;}
    if(typeof c.width2!=='number'||!Number.isFinite(c.width2))throw Error('Länge des zweiten Abschnitts eingeben.');
    const second=generateStraight({...c,width:c.width2}), b=a+turn*Math.PI/180;
    const center=rotate(c.width-size/2,postDepth/2,a), localCenter=rotate(size/2,postDepth/2,b);
    const start={x:c.x+center.x-localCenter.x,y:c.y+center.y-localCenter.y};
    const removedPost=second.objects.findIndex(o=>o.part.name==='Pfosten');second.objects.splice(removedPost,1);
    if(c.plates){const plate=second.objects.findIndex(o=>o.part.name==='Fußplatte');second.objects.splice(plate,1);}
    second.objects.forEach(o=>toWorld(o,start,b));checkBounds([...first.objects,...second.objects]);
    addDimensions(first.objects,origin,a,c.width);addDimensions(second.objects,start,b,c.width2);
    const note='Eckverbindung: Zuschnitt und Anschluss vor Fertigung festlegen.';
    for(const o of [...first.objects,...second.objects])if(o.part?.name==='Handlauf')o.part.notes=note;
    return {objects:[...first.objects,...second.objects],posts:first.posts+second.posts-1,bars:first.bars+second.bars,span:first.span,opening:Math.max(first.opening,second.opening),secondSpan:second.span};
  }
  return {profiles,materials,generate};
});
