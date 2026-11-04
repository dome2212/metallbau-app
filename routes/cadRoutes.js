const express = require('express');
const crypto = require('crypto');
const {dbQuery, withTransaction} = require('../utils/db');
const {requirePerm, hasPerm} = require('../middleware/auth');
const {getFirma} = require('../utils/companySettings');
const {validate} = require('../Public/js/cad-document');
const {workshop} = require('../utils/cadWorkshop');
const router = express.Router();
router.use(requirePerm('cad', true, false, 'CAD Studio'));
router.use((req,res,next)=>req.method==='POST'&&!req.is('application/json')?res.status(415).json({error:'JSON erforderlich.'}):next());
let ready;
async function init(){
 if(!ready)ready=(async()=>{
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, project_id TEXT, document TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)');
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_document_access (document_id TEXT NOT NULL, user_id TEXT NOT NULL, can_edit INTEGER NOT NULL, PRIMARY KEY(document_id,user_id))');
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_document_versions (document_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, updated_at TEXT NOT NULL, author_id TEXT NOT NULL, PRIMARY KEY(document_id,revision))');
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_templates (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, document TEXT NOT NULL)');
 })().catch(e=>{ready=null;throw e;});await ready;
}
router.use(async(req,res,next)=>{try{await init();next();}catch(e){next(e);}});
const user=req=>String(req.user.id);
const accessSQL='(d.owner_id = ? OR (d.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM cad_document_access a WHERE a.document_id = d.id AND a.user_id = ?)))';
async function accessible(req,query=dbQuery){return (await query('SELECT d.* FROM cad_documents d WHERE d.id = ? AND '+accessSQL,[req.params.id,user(req),user(req)])).rows[0];}
router.get('/projects',async(req,res,next)=>{try{res.json((await dbQuery('SELECT id,title FROM projects WHERE deleted_at IS NULL ORDER BY title')).rows);}catch(e){next(e);}});
router.get('/documents',async(req,res,next)=>{try{res.json((await dbQuery('SELECT d.id,d.name,d.project_id,d.owner_id,d.revision,d.updated_at FROM cad_documents d WHERE '+accessSQL+' ORDER BY d.updated_at DESC',[user(req),user(req)])).rows);}catch(e){next(e);}});
router.get('/documents/:id',async(req,res,next)=>{try{const row=await accessible(req);if(!row)return res.status(404).json({error:'Zeichnung nicht gefunden.'});const own=row.owner_id===user(req),grant=own?null:(await dbQuery('SELECT can_edit FROM cad_document_access WHERE document_id = ? AND user_id = ?',[row.id,user(req)])).rows[0];res.json({...row,document:JSON.parse(row.document),can_edit:own||Boolean(grant?.can_edit),is_owner:own});}catch(e){next(e);}});
router.post('/documents',async(req,res,next)=>{
 let doc;try{if(JSON.stringify(req.body).length>2000000)throw Error('Zeichnung zu groß.');doc=validate(req.body.document);}catch(e){return res.status(400).json({error:e.message});}
 try{
  const id=req.body.id||crypto.randomUUID(),owner=user(req),project=req.body.projectId?String(req.body.projectId):null,revision=req.body.revision,now=new Date().toISOString();
  if(typeof id!=='string'||id.length>80)return res.status(400).json({error:'Ungültige ID.'});
  if(project&&!(await dbQuery('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL',[project])).rows.length)return res.status(400).json({error:'Auftrag nicht gefunden.'});
  const result=await withTransaction(async tx=>{
   if(req.body.id){
    const row=(await tx.query('SELECT * FROM cad_documents WHERE id = ?'+(process.env.DATABASE_URL?' FOR UPDATE':''),[id])).rows[0];
    if(!row)return {status:404,error:'Zeichnung nicht gefunden.'};
    const own=row.owner_id===owner,grant=own?null:(await tx.query('SELECT can_edit FROM cad_document_access WHERE document_id = ? AND user_id = ?',[id,owner])).rows[0];
    if(!own&&(!row.project_id||!grant))return {status:404,error:'Zeichnung nicht gefunden.'};
    if(!own&&(!grant.can_edit||row.project_id!==project))return {status:403,error:'Keine Schreibberechtigung oder Auftragszuordnung darf nicht geändert werden.'};
    if(row.revision!==revision)return {status:409,error:'Die Zeichnung wurde inzwischen geändert. Neu öffnen oder als Kopie speichern.'};
    // Preserve the initial revision of documents created before version history existed.
    await tx.query('INSERT INTO cad_document_versions(document_id,revision,document,updated_at,author_id) VALUES(?,?,?,?,?) ON CONFLICT(document_id,revision) DO NOTHING',[id,row.revision,row.document,row.updated_at,row.owner_id]);
    if(row.project_id!==project)await tx.query('DELETE FROM cad_document_access WHERE document_id = ?',[id]);
    await tx.query('UPDATE cad_documents SET name = ?,project_id = ?,document = ?,revision = ?,updated_at = ? WHERE id = ? AND revision = ?',[doc.name,project,JSON.stringify(doc),revision+1,now,id,revision]);
    const current=(await tx.query('SELECT revision,document FROM cad_documents WHERE id = ?',[id])).rows[0];if(current.revision!==revision+1||current.document!==JSON.stringify(doc))return {status:409,error:'Zeichnung wurde gleichzeitig geändert.'};
    await tx.query('INSERT INTO cad_document_versions(document_id,revision,document,updated_at,author_id) VALUES(?,?,?,?,?)',[id,revision+1,JSON.stringify(doc),now,owner]);
    return {id,revision:revision+1};
   }
   await tx.query('INSERT INTO cad_documents(id,owner_id,name,project_id,document,revision,updated_at) VALUES(?,?,?,?,?,?,?)',[id,owner,doc.name,project,JSON.stringify(doc),1,now]);
   await tx.query('INSERT INTO cad_document_versions(document_id,revision,document,updated_at,author_id) VALUES(?,?,?,?,?)',[id,1,JSON.stringify(doc),now,owner]);return {id,revision:1};
  });if(result.error)return res.status(result.status).json({error:result.error});res.json(result);
 }catch(e){next(e);}
});
router.get('/documents/:id/versions',async(req,res,next)=>{try{if(!await accessible(req))return res.status(404).json({error:'Zeichnung nicht gefunden.'});res.json((await dbQuery('SELECT revision,updated_at,author_id FROM cad_document_versions WHERE document_id = ? ORDER BY revision DESC',[req.params.id])).rows);}catch(e){next(e);}});
router.get('/documents/:id/versions/:revision',async(req,res,next)=>{try{if(!await accessible(req))return res.status(404).json({error:'Zeichnung nicht gefunden.'});const row=(await dbQuery('SELECT document FROM cad_document_versions WHERE document_id = ? AND revision = ?',[req.params.id,Number(req.params.revision)])).rows[0];if(!row)return res.status(404).json({error:'Version nicht gefunden.'});res.json(JSON.parse(row.document));}catch(e){next(e);}});
router.get('/collaborators',async(req,res,next)=>{try{const firma=await getFirma();res.json((await dbQuery('SELECT id,username,role FROM users ORDER BY username')).rows.filter(u=>hasPerm(u,'cad',firma,true,false)).map(u=>({id:String(u.id),name:u.username})));}catch(e){next(e);}});
router.get('/documents/:id/access',async(req,res,next)=>{try{const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});res.json((await dbQuery('SELECT user_id,can_edit FROM cad_document_access WHERE document_id = ?',[row.id])).rows);}catch(e){next(e);}});
router.post('/documents/:id/access',async(req,res,next)=>{try{const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});if(!row.project_id)return res.status(400).json({error:'Zuerst einen Auftrag zuordnen und speichern.'});const id=String(req.body.userId),mode=req.body.mode;if(!['read','edit','remove'].includes(mode)||id===user(req))return res.status(400).json({error:'Ungültige Freigabe.'});const target=(await dbQuery('SELECT id,role FROM users WHERE id = ?',[id])).rows[0];if(!target||!hasPerm(target,'cad',await getFirma(),true,false))return res.status(400).json({error:'Benutzer benötigt CAD-Zugriff.'});
 await withTransaction(async tx=>{await tx.query('DELETE FROM cad_document_access WHERE document_id = ? AND user_id = ?',[row.id,id]);if(mode!=='remove')await tx.query('INSERT INTO cad_document_access(document_id,user_id,can_edit) VALUES(?,?,?)',[row.id,id,mode==='edit'?1:0]);});res.json({ok:true});}catch(e){next(e);}});
router.get('/templates',async(req,res,next)=>{try{res.json((await dbQuery('SELECT id,name FROM cad_templates WHERE owner_id = ? ORDER BY name',[user(req)])).rows);}catch(e){next(e);}});
router.get('/templates/:id',async(req,res,next)=>{try{const row=(await dbQuery('SELECT document FROM cad_templates WHERE id = ? AND owner_id = ?',[req.params.id,user(req)])).rows[0];if(!row)return res.status(404).json({error:'Vorlage nicht gefunden.'});res.json(JSON.parse(row.document));}catch(e){next(e);}});
router.post('/templates',async(req,res,next)=>{let doc;try{doc=validate(req.body.document);if(JSON.stringify(doc).length>2000000)throw Error('Vorlage zu groß.');}catch(e){return res.status(400).json({error:e.message});}try{const id=crypto.randomUUID();await dbQuery('INSERT INTO cad_templates(id,owner_id,name,document) VALUES(?,?,?,?)',[id,user(req),doc.name,JSON.stringify(doc)]);res.json({id});}catch(e){next(e);}});
router.post('/workshop',(req,res)=>{try{const doc=validate(req.body);if(JSON.stringify(doc).length>2000000)throw Error('Zeichnung zu groß.');const options=req.body.output||{};if(!['workshop','customer','labels','installation','parts'].includes(options.kind||'workshop')||![0,1,2,5,10,20,50].includes(options.scale||0))throw Error('Ungültige PDF-Auswahl.');workshop(doc,res,options);}catch(e){if(!res.headersSent)res.status(400).json({error:e.message});else res.destroy();}});
module.exports=router;
