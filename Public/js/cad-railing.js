/* Straight railing generator. Dimensions are millimetres; Z is height. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-parts'),require('./cad-join'));else root.CadRailing=factory(root.CadParts,root.CadJoin);})(typeof globalThis!=='undefined'?globalThis:this,function(parts,joiner){
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
    if(c.postRailJoint!==undefined&&!['miter','butt'].includes(c.postRailJoint))throw Error('Ungültige Pfostenverbindung.');
    const mount=c.plateMount??(c.plates?'below':'none'),hasPlate=mount!=='none';
    if(!['none','below','front','back'].includes(mount))throw Error('Ungültige Plattenposition.');
    const plateWidth=c.plateWidth??c.plateSize,plateHeight=c.plateHeight??c.plateSize,plateThickness=c.plateThickness;
    if(hasPlate&&(![plateWidth,plateHeight,plateThickness].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1000)))throw Error('Bitte gültige Plattenmaße eingeben.');
    const post=profiles[c.postProfile],rail=profiles[c.railProfile],bar=profiles[c.barProfile];if(!post||!rail||!bar)throw Error('Bitte gültige Profile auswählen.');
    if(c.width<=post.size*2||c.height<=rail.h*2+c.clearance)throw Error('Länge oder Höhe ist für diese Profile zu klein.');
    const spans=Math.ceil((c.width-post.size)/c.postSpacing),step=(c.width-post.size)/spans,clear=step-post.size;
    if(clear<=0)throw Error('Der Pfostenabstand ist für dieses Profil zu klein.');
    if(c.infill==='glass'&&(!Number.isFinite(c.glassThickness)||c.glassThickness<4||c.glassThickness>30||!['VSG','ESG'].includes(c.glassType)))throw Error('Bitte Glastyp und Glasdicke zwischen 4 und 30 mm eingeben.');
    const n=c.infill==='bars'?Math.max(0,Math.ceil((clear-c.barGap)/(c.barGap+bar.size))):0;
    if(n*bar.size>clear)throw Error('Füllstäbe passen nicht zwischen die Pfosten.');
    if((spans+1)+spans*n+(c.infill==='glass'?spans:0)+1+spans+(hasPlate?spans+1:0)>1900)throw Error('Zu viele Bauteile. Bitte Länge oder Abstände anpassen.');
    const objects=[],round=n=>Math.round(n*1000)/1000;
    function add(name,x,y,z,w,h,depth,profile,axis,notes=''){
      const isRound=profile.round&&axis==='z', o={type:isRound?'circle':'rect',x:round(c.x+x+(isRound?w/2:0)),y:round(c.y+y+(isRound?h/2:0)),z:round(z),w:round(isRound?w/2:w),h:round(isRound?h/2:h),depth:round(depth)};
      const material=(name==='Pfosten'||name==='Fußplatte'||name==='Seitenplatte'?c.materialPost:name==='Handlauf'||name==='Untergurt'?c.materialRail:c.materialBar)||c.material;
      const data={catalogId:'custom',name,material,finish:c.finish,wall:profile.wall,lengthAxis:axis,notes};if(profile.round&&axis==='x')data.section='round';
      o.part=parts.validatePart(data,o);objects.push(o);
    }
    for(let i=0;i<=spans;i++){
      const x=round(i*step);add('Pfosten',x,0,0,post.b,post.h,c.height-rail.h,post,'z');
      if(mount==='below')add('Fußplatte',x-(plateWidth-post.b)/2,(post.h-plateHeight)/2,-plateThickness,plateWidth,plateHeight,plateThickness,{wall:0},'plate','Unter dem Pfosten. Bohrungen und Befestigung projektspezifisch festlegen.');
      if(mount==='front'||mount==='back')add('Seitenplatte',x-(plateWidth-post.b)/2,mount==='front'?-plateThickness:post.h,0,plateWidth,plateThickness,plateHeight,{wall:0},'plate',`Seitlich ${mount==='front'?'vorne':'hinten'} am Pfosten. Bohrungen und Befestigung projektspezifisch festlegen.`);
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
    if(c.sections!==undefined)return generatePath(c);
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
    function connectTerminal(items,atStart){if(c.postRailJoint!=='miter')return;const posts=items.map((o,i)=>({o,i})).filter(v=>v.o.part?.name==='Pfosten'),railIndex=items.findIndex(o=>o.part?.name==='Handlauf'),postIndex=atStart?posts[0].i:posts[posts.length-1].i;const joined=joiner.joinPostRail(items[postIndex],items[railIndex]);if(joined.endB!==(atStart?'start':'end'))throw Error('Endpfosten konnte nicht zugeordnet werden.');items[postIndex]=joined.first;items[railIndex]=joined.second;}
    if(!corner){connectTerminal(first.objects,true);connectTerminal(first.objects,false);addDimensions(first.objects,origin,a,c.width);checkBounds(first.objects);return first;}
    if(typeof c.width2!=='number'||!Number.isFinite(c.width2))throw Error('Länge des zweiten Abschnitts eingeben.');
    const second=generateStraight({...c,width:c.width2}), b=a+turn*Math.PI/180;
    const center=rotate(c.width-size/2,postDepth/2,a), localCenter=rotate(size/2,postDepth/2,b);
    const start={x:c.x+center.x-localCenter.x,y:c.y+center.y-localCenter.y};
    const removedPost=second.objects.findIndex(o=>o.part.name==='Pfosten');second.objects.splice(removedPost,1);
    if((c.plateMount??(c.plates?'below':'none'))!=='none'){const plate=second.objects.findIndex(o=>['Fußplatte','Seitenplatte'].includes(o.part.name));second.objects.splice(plate,1);}
    second.objects.forEach(o=>toWorld(o,start,b));checkBounds([...first.objects,...second.objects]);
    addDimensions(first.objects,origin,a,c.width);addDimensions(second.objects,start,b,c.width2);
    const i=first.objects.findIndex(o=>o.part?.name==='Handlauf'),j=second.objects.findIndex(o=>o.part?.name==='Handlauf');
    const joint=joiner.join(first.objects[i],second.objects[j]);first.objects[i]=joint.first;second.objects[j]=joint.second;connectTerminal(first.objects,true);connectTerminal(second.objects,false);
    return {objects:[...first.objects,...second.objects],posts:first.posts+second.posts-1,bars:first.bars+second.bars,span:first.span,opening:Math.max(first.opening,second.opening),secondSpan:second.span};
  }
  function generatePath(c){
    if(!Array.isArray(c.sections)||c.sections.length<1||c.sections.length>12)throw Error('1–12 Geländerabschnitte wählen.');
    let bearing=c.angle??0,origin={x:c.x,y:c.y},previous=null,posts=0,bars=0,opening=0,span=0;
    const objects=[],post=profiles[c.postProfile];if(!post)throw Error('Ungültiges Pfostenprofil.');
    for(let i=0;i<c.sections.length;i++){
      const section=c.sections[i];if(!section||!Number.isFinite(section.width)||!Number.isFinite(section.turn)||i&& (Math.abs(section.turn)<10||Math.abs(section.turn)>170))throw Error('Abschnittslänge und Richtungsänderung (±10–170°) prüfen.');
      if(i){bearing+=section.turn;const a=bearing*Math.PI/180;origin={x:previous.center.x-post.b/2*Math.cos(a)+post.h/2*Math.sin(a),y:previous.center.y-post.b/2*Math.sin(a)-post.h/2*Math.cos(a)};}
      const g=generate({...c,sections:undefined,corner:false,width:section.width,angle:((bearing+180)%360+360)%360-180,x:origin.x,y:origin.y,postRailJoint:'butt'});
      const counts={};g.objects.forEach(o=>{const role=o.part?.name||o.type;o.memberKey=`s${i}:${role}:${counts[role]||0}`;counts[role]=(counts[role]||0)+1;});
      const hand=g.objects.find(o=>o.part?.name==='Handlauf');
      if(i){const firstPost=g.objects.find(o=>o.part?.name==='Pfosten');g.objects.splice(g.objects.indexOf(firstPost),1);const plate=g.objects.find(o=>['Fußplatte','Seitenplatte'].includes(o.part?.name));if(plate)g.objects.splice(g.objects.indexOf(plate),1);
        const joint=joiner.join(previous.hand,hand);Object.assign(previous.hand,joint.first);Object.assign(hand,joint.second);}
      const a=bearing*Math.PI/180;previous={hand,center:{x:origin.x+(section.width-post.b/2)*Math.cos(a)-post.h/2*Math.sin(a),y:origin.y+(section.width-post.b/2)*Math.sin(a)+post.h/2*Math.cos(a)}};
      objects.push(...g.objects);posts+=g.posts-(i?1:0);bars+=g.bars;opening=Math.max(opening,g.opening);span=Math.max(span,g.span);
    }
    if(c.postRailJoint==='miter'){
      const ps=objects.filter(o=>o.part?.name==='Pfosten'),rs=objects.filter(o=>o.part?.name==='Handlauf');
      for(const [p,r] of [[ps[0],rs[0]],[ps.at(-1),rs.at(-1)]]){const j=joiner.joinPostRail(p,r);Object.assign(p,j.first);Object.assign(r,j.second);}
    }
    if(objects.length>1900)throw Error('Zu viele Bauteile. Abstände oder Abschnitte anpassen.');
    return {objects,posts,bars,opening,span};
  }
  return {profiles,materials,generate};
});
