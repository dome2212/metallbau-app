(()=>{'use strict';
 const $=id=>document.getElementById('cad-'+id),editor=window.CadEditor,api=window.CadConstruction,member=$('member-form'),sheet=$('sheet-form'),dock=$('generator-dock');
 // Move existing controls, retaining their handlers, values and IDs.
 const production=document.querySelector('.cad-production');$('generator-content').append(production);
 // The existing print stylesheet expects this section directly under the app.
 window.addEventListener('beforeprint',()=>document.getElementById('cad-app').append(production));
 window.addEventListener('afterprint',()=>$('generator-content').append(production));
 document.querySelector('.cad-tools').prepend(document.querySelector('.cad-construction-dock'));
 const links=document.createElement('div');links.className='cad-generator-links';
 for(const [label,id] of [['Treppe','stairs-form'],['Balkon','structure-form']]){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{window.dispatchEvent(new CustomEvent('cad-open-design',{detail:id}));if(label==='Balkon'){$('structure-form').elements.type.value='balcony';$('structure-form').elements.type.dispatchEvent(new Event('change'));}};links.append(b);} $('generator-content').prepend(links);
 for(const el of document.querySelectorAll('[data-construction-material]'))for(const m of window.CadRailing.materials)el.add(new Option(m,m));
 for(const [key,p] of Object.entries(window.CadRailing.profiles))member.elements.profile.add(new Option((p.round?'Rundprofil ':key.startsWith('flat')?'Flachstahl ':'Rohr / Stab ')+key.replace('flat','').replace('round','').replaceAll('x',' × '),key));
 const data=form=>Object.fromEntries([...form.elements].filter(el=>el.name).map(el=>[el.name,el.type==='number'||el.name==='holes'?Number(el.disabled&&el.type==='number'?el.defaultValue:el.value):el.value]));
 const report=err=>editor.message(err.message||String(err));
 function add(objects,config){const groupId=crypto.randomUUID();objects.forEach(o=>o.groupId=groupId);objects[0].generator=config;editor.add(objects);document.querySelector('[data-view="3d"]').click();editor.message('Baugruppe mit Material und Fertigungsangaben eingefügt.');}
 member.onsubmit=e=>{e.preventDefault();try{const c=data(member);add(api.construct(c),{kind:'construction',config:c});$('member-dock').open=false;}catch(err){report(err);}};
 sheet.onsubmit=e=>{e.preventDefault();try{const c=data(sheet),s=api.sheet(c);add(s.objects,{kind:'sheet',config:c});$('sheet-dock').open=false;}catch(err){report(err);}};
 function laser(){try{const o=editor.document().objects[editor.selected()],content=api.laser(o),url=URL.createObjectURL(new Blob([content],{type:'application/dxf'})),a=document.createElement('a');a.href=url;a.download='Platte-Laser-mm.dxf';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);editor.message('Laser-DXF: CUT, BEND und MARK. Werkzeugkompensation im CAM festlegen.');}catch(err){report(err);}}
 $('laser-export').onclick=laser;
 document.querySelectorAll('[data-cad-action]').forEach(b=>b.onclick=()=>b.dataset.cadAction==='laser'?laser():$('workshop').click());
 document.querySelectorAll('[data-cad-panel]').forEach(b=>b.onclick=()=>$('tab-'+b.dataset.cadPanel).click());
 document.querySelectorAll('[data-cad-design]').forEach(b=>b.onclick=()=>window.dispatchEvent(new CustomEvent('cad-open-design',{detail:b.dataset.cadDesign})));
 for(const tab of document.querySelectorAll('.cad-production-tabs button'))tab.addEventListener('click',()=>{dock.open=true;});
 // Native disclosures work with Enter/Space. Escape closes a tool and returns focus.
 const disclosures=[...document.querySelectorAll('.cad-ribbon>details,.cad-construction-dock>details')];
 for(const d of disclosures){d.addEventListener('toggle',()=>{if(d.open){for(const other of disclosures)if(other!==d)other.open=false;}window.dispatchEvent(new Event('resize'));});d.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();d.open=false;d.querySelector('summary').focus();}});}
 for(const id of ['member-dock','sheet-dock']){const d=$(id),close=document.createElement('button');close.type='button';close.className='cad-dock-close';close.textContent='Schließen ×';close.onclick=()=>{d.open=false;d.querySelector('summary').focus();};d.querySelector('.cad-dock-form').prepend(close);}
 function sync(){for(const el of member.querySelectorAll('[data-member-fields]'))el.hidden=!el.dataset.memberFields.split(' ').includes(member.elements.kind.value);
  for(const el of sheet.querySelectorAll('[data-sheet-bend]'))el.hidden=sheet.elements.shape.value==='flat';for(const el of sheet.querySelectorAll('[data-sheet-hole]'))el.hidden=sheet.elements.holes.value==='0';
  for(const form of [member,sheet])for(const label of form.querySelectorAll('[data-member-fields],[data-sheet-bend],[data-sheet-hole]'))for(const el of label.querySelectorAll('input,select'))el.disabled=label.hidden;
  try{const s=api.sheet(data(sheet));$('sheet-summary').textContent=`Abwicklung: ${s.width.toLocaleString('de-DE',{maximumFractionDigits:2})} × ${s.length} mm · ${s.bends.length} Kantungen${s.bends.length?' · Biegezugabe '+s.allowance.toFixed(2)+' mm je Kantung' : ''}`;}catch(e){$('sheet-summary').textContent=e.message;}
 }
 const structure=$('structure-form');const syncBalcony=()=>{$('balcony-options').hidden=structure.elements.type.value!=='balcony';};structure.elements.type.addEventListener('change',syncBalcony);syncBalcony();
 for(const form of [member,sheet]){form.addEventListener('input',sync);form.addEventListener('change',sync);form.addEventListener('invalid',e=>{const d=e.target.closest('details');if(d)d.open=true;},true);}sync();
})();
