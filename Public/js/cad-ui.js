/* Presentation helpers. Drawing data and generation stay in the CAD editor. */
(()=>{
 'use strict';
 const $=id=>document.getElementById('cad-'+id),f=$('railing-form');
 const viewPicker=document.createElement('select');viewPicker.id='cad-view-picker';viewPicker.setAttribute('aria-label','Ansicht wählen');for(const b of document.querySelectorAll('[data-view]')){viewPicker.add(new Option(b.textContent,b.dataset.view));b.addEventListener('click',()=>viewPicker.value=b.dataset.view);}viewPicker.onchange=()=>document.querySelector(`[data-view="${viewPicker.value}"]`).click();document.querySelector('.cad-modes').after(viewPicker);
 const go=panel=>{$('tab-'+panel).click();$('panel-'+panel).scrollIntoView({behavior:'smooth',block:'start'});};
 document.querySelectorAll('[data-start-panel]').forEach(b=>b.onclick=()=>go(b.dataset.startPanel));
 $('projects-toggle').onclick=()=>{const d=document.querySelector('.cad-cloud');d.open=!d.open;if(d.open){d.scrollIntoView({block:'start',behavior:'smooth'});if($('cloud-list').options.length===1)$('cloud-refresh').click();}};
 // Keep geometry visible; less frequent settings remain one click away.
 for(const [id,title,open] of [['properties','Maße & Position',true],['miter-form','Gehrung einstellen',false],['join-form','Profile verbinden',false],['part-form','Material & Fertigung',false]]){
  const form=$(id),details=document.createElement('details'),summary=document.createElement('summary');details.className='cad-inspector-group';details.open=open;summary.textContent=title;form.before(details);details.append(summary,form);
 }
 document.querySelector('.cad-cloud').addEventListener('toggle',e=>$('projects-toggle').setAttribute('aria-expanded',String(e.currentTarget.open)));
 const search=document.createElement('input');search.type='search';search.placeholder='Bauteile filtern …';search.setAttribute('aria-label','Zeichnungselemente filtern');search.className='cad-object-search';$('objects').before(search);
 const filter=()=>{const q=search.value.toLocaleLowerCase('de');for(const b of $('objects').children)b.hidden=!b.textContent.toLocaleLowerCase('de').includes(q);};search.oninput=filter;
 const toggle=$('inspector-toggle');toggle.onclick=()=>{const body=$('inspector-fields');body.hidden=!body.hidden;toggle.setAttribute('aria-expanded',String(!body.hidden));toggle.textContent=body.hidden?'Anzeigen':'Einklappen';};
 const summary=document.createElement('div');summary.className='cad-config-summary';summary.setAttribute('aria-live','polite');summary.setAttribute('aria-atomic','true');f.before(summary);
 const type=document.createElement('select');type.id='cad-railing-type';type.setAttribute('aria-label','Geländerform');for(const [v,t] of [['straight','Gerades Geländer'],['corner','Geländer über Eck'],['stair','Treppengeländer']])type.add(new Option(t,v));const typeLabel=document.createElement('label');typeLabel.className='cad-type-choice';typeLabel.append('Geländerform',type);summary.before(typeLabel);
 function fold(names,title){const details=document.createElement('details'),heading=document.createElement('summary'),body=document.createElement('div');details.className='cad-advanced-fields';heading.textContent=title;details.append(heading,body);const first=f.elements[names[0]].closest('label');first.parentElement.append(details);for(const name of names)body.append(f.elements[name].closest('label'));}
 fold(['x','y','angle'],'Position & Ausrichtung');fold(['materialPost','materialRail','materialBar'],'Abweichende Materialien je Bauteil');
 const fields=[...f.querySelectorAll('.railing-grid > fieldset')],nav=document.createElement('nav');nav.className='cad-config-steps';nav.setAttribute('aria-label','Geländer konfigurieren');typeLabel.after(nav);
 let step=0;
 const buttons=fields.map((fieldset,i)=>{fieldset.id='cad-railing-step-'+i;const b=document.createElement('button');b.type='button';b.textContent=['1 · Maße','2 · Profile','3 · Füllung & Montage'][i];b.setAttribute('aria-controls',fieldset.id);b.onclick=()=>show(i);nav.append(b);return b;});
 const paging=document.createElement('div');paging.className='cad-config-paging';const back=document.createElement('button'),next=document.createElement('button');back.type=next.type='button';back.textContent='← Zurück';next.textContent='Weiter →';back.onclick=()=>show(step-1);next.onclick=()=>show(step+1);paging.append(back,next);f.querySelector('.railing-grid').after(paging);
 function show(index){step=Math.max(0,Math.min(2,index));fields.forEach((el,i)=>el.hidden=i!==step);buttons.forEach((b,i)=>{b.classList.toggle('active',i===step);if(i===step)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});back.disabled=step===0;next.hidden=step===2;}
 f.addEventListener('invalid',e=>{const index=fields.indexOf(e.target.closest('fieldset'));if(index>=0)show(index);const detail=e.target.closest('details');if(detail)detail.open=true;},true);
 function visible(name,show){const el=f.elements.namedItem(name);if(el){el.closest('label').hidden=!show;el.disabled=!show;}}
 function sync(){
  const stair=Number(f.elements.rise.value)>0,corner=f.elements.corner.checked,glass=f.elements.infill.value==='glass',bars=f.elements.infill.value==='bars',plate=f.elements.plateMount.value!=='none';
  type.value=stair?'stair':corner?'corner':'straight';for(const note of f.querySelectorAll('small')){if(note.textContent.startsWith('Treppengeländer:'))note.hidden=!stair;if(note.textContent.startsWith('+90°'))note.hidden=!corner;}
  for(const name of ['rise','run','steps'])visible(name,stair);
  visible('width',!stair);visible('corner',false);visible('width2',corner&&!stair);visible('turn',corner&&!stair);visible('postRailJoint',!stair);
  for(const name of ['glassType','glassThickness','glassClamps'])visible(name,glass);
  for(const name of ['barProfile','barGap','materialBar'])visible(name,bars);
  for(const name of ['plateWidth','plateHeight','plateThickness'])visible(name,plate);
  visible('fasteners',f.elements.plateMount.value==='below');
  const length=stair?Number(f.elements.run.value)*Number(f.elements.steps.value):Number(f.elements.width.value)+(corner?Number(f.elements.width2.value):0)+[...document.querySelectorAll('#cad-extra-sections [data-section-field=width]')].reduce((n,el)=>n+(corner?Number(el.value):0),0);
  summary.textContent=`${type.selectedOptions[0].textContent} · ${(length/1000).toLocaleString('de-DE',{maximumFractionDigits:2})} m · Höhe ${f.elements.height.value} mm · ${f.elements.infill.selectedOptions[0].textContent}`;
  const editing=Boolean(f.dataset.editGroup);f.querySelector('button[type=submit]').textContent=editing?'Geländer aktualisieren':'＋ Geländer erstellen';
 }
 type.onchange=()=>{f.elements.corner.checked=type.value==='corner';f.elements.corner.dispatchEvent(new Event('change'));f.elements.rise.value=type.value==='stair'?(Number(f.elements.rise.value)||180):0;sync();};
 f.addEventListener('input',sync);f.addEventListener('change',e=>{if(e.target===f.elements.infill&&f.elements.infill.value!=='glass')f.elements.glassClamps.value='none';if(e.target===f.elements.plateMount&&f.elements.plateMount.value!=='below')f.elements.fasteners.value='none';sync();});
 for(const id of ['edit-railing','cancel-railing'])$(id).addEventListener('click',()=>{sync();show(0);});
 // Hidden optional fields retain generator defaults but must not block submission.
 for(const el of f.querySelectorAll('input[required]'))el.addEventListener('invalid',()=>{el.closest('label').hidden=false;});
 function refresh(){filter();sync();const selected=window.CadEditor.selected(),count=window.CadEditor.document().objects.length;document.querySelector('.cad-shortcuts').classList.toggle('cad-has-drawing',count>0);$('edit-railing').disabled=selected<0;}
 window.addEventListener('cad-refresh',refresh);
 // Move exports into a compact, keyboard accessible disclosure.
 const actions=$('export').closest('.cad-actions'),more=document.createElement('details'),moreSummary=document.createElement('summary'),menu=document.createElement('div');more.className='cad-more-actions';moreSummary.textContent='Export & Werkstatt';menu.className='cad-more-menu';more.append(moreSummary,menu);actions.append(more);for(const id of ['workshop','cut-transfer','export'])menu.append($(id));
 document.addEventListener('click',e=>{if(!more.contains(e.target))more.open=false;});more.addEventListener('keydown',e=>{if(e.key==='Escape'){more.open=false;moreSummary.focus();}});
 // Group related construction and workshop tools into short, discoverable categories.
 const designGrid=$('panel-design').querySelector('.cad-design-grid'),card=id=>$(id).closest('details');
 const groups=[{label:'Konstruieren',cards:['offset-form','gate-form','stairs-form']},{label:'Vorlagen & Aufmaß',cards:['structure-form','template-save','symbol-form','site-notes']},{label:'Fertigung & Montage',cards:['install-form','pdf-kind','material-summary']}];
 const categories=document.createElement('nav');categories.className='cad-design-categories';categories.setAttribute('aria-label','Konstruktion und Werkstatt');designGrid.before(categories);
 const categoryButtons=groups.map((group,i)=>{const b=document.createElement('button');b.type='button';b.textContent=group.label;b.addEventListener('click',()=>showCategory(i));categories.append(b);return b;});
 function showCategory(index){groups.forEach((group,i)=>{for(const n of group.cards)card(n).hidden=i!==index;categoryButtons[i].classList.toggle('active',i===index);if(i===index)categoryButtons[i].setAttribute('aria-current','true');else categoryButtons[i].removeAttribute('aria-current');});}
 showCategory(0);
 function openDesign(id){$('tab-design').click();const group=groups.findIndex(g=>g.cards.includes(id));if(group>=0)showCategory(group);const target=card(id);target.open=true;target.scrollIntoView({behavior:'smooth',block:'start'});}
 const shortcuts=document.querySelector('.cad-shortcuts');for(const [name,cardIndex] of [['Treppe','stairs-form'],['Tor','gate-form']]){const b=document.createElement('button');b.type='button';b.textContent=name;b.addEventListener('click',()=>openDesign(cardIndex));shortcuts.append(b);}
 // Keep the drawing options together without removing their existing controls.
 const options=document.querySelector('.cad-tool-options'),settings=document.createElement('details'),settingsTitle=document.createElement('summary'),settingsBody=document.createElement('div');settings.className='cad-view-settings';settingsTitle.textContent='Fang & Raster';settingsBody.className='cad-view-settings-body';settings.append(settingsTitle,settingsBody);options.insertBefore(settings,$('fit'));for(const id of ['direct-edit','object-snap','snap'])settingsBody.append($(id).closest('label'));settingsBody.append($('grid'));
 settings.addEventListener('keydown',e=>{if(e.key==='Escape'){settings.open=false;settingsTitle.focus();}});document.addEventListener('click',e=>{if(!settings.contains(e.target))settings.open=false;});
 // Group the long stair form; controls remain in the same form and retain their values.
 const stair=$('stairs-form'),stairGroups=[['Maße',['steps','run','rise','width','landing']],['Tragprofil & Stufen',['stairStructure','stringerProfile','stringerMaterial','treadType','treadMaterial','treadThickness']],['Geländer & Oberfläche',['railing','railMaterial','postProfile','railProfile','barProfile','finish']],['Befestigung',['bottomMount','topMount','mountMaterial','mountWidth','mountLength','mountThickness','anchorDiameter']]];
 const groupContainer=document.createElement('div');groupContainer.className='cad-stair-groups';stair.prepend(groupContainer);
 stairGroups.forEach(([title,names],index)=>{const details=document.createElement('details'),heading=document.createElement('summary'),body=document.createElement('div');details.className='cad-stair-group';details.open=index===0;heading.textContent=title;body.className='cad-stair-fields';details.append(heading,body);for(const name of names){const field=stair.elements.namedItem(name);if(field)body.append(field.closest('label'));}groupContainer.append(details);});
 stair.addEventListener('invalid',e=>{const detail=e.target.closest('.cad-stair-group');if(detail)detail.open=true;const outer=stair.closest('details');if(outer)outer.open=true;},true);
 function syncMountFields(){const none=stair.elements.bottomMount.value==='none'&&stair.elements.topMount.value==='none';for(const name of ['mountMaterial','mountWidth','mountLength','mountThickness','anchorDiameter']){const field=stair.elements.namedItem(name);field.closest('label').hidden=none;field.disabled=none;}}
 stair.elements.bottomMount.addEventListener('change',syncMountFields);stair.elements.topMount.addEventListener('change',syncMountFields);syncMountFields();
 // Tab navigation also works with a keyboard.
 const tabs=[...document.querySelectorAll('.cad-production-tabs [role=tab]')];tabs.forEach((tab,i)=>{tab.tabIndex=tab.getAttribute('aria-selected')==='true'?0:-1;tab.addEventListener('click',()=>tabs.forEach(t=>t.tabIndex=t===tab?0:-1));tab.addEventListener('keydown',e=>{let index;if(e.key==='ArrowRight')index=(i+1)%tabs.length;else if(e.key==='ArrowLeft')index=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')index=0;else if(e.key==='End')index=tabs.length-1;else return;e.preventDefault();tabs[index].click();tabs[index].focus();});});
 show(0);refresh();
})();
