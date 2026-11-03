const express=require('express'),crypto=require('crypto');
const {dbQuery,withTransaction}=require('../utils/db');
const {requirePerm}=require('../middleware/auth');
const {validate}=require('../Public/js/cad-document');
const {workshop}=require('../utils/cadWorkshop');
const router=express.Router();
router.use(requirePerm('cad',true,false,'CAD Studio'));
router.use((req,res,next)=>{if(req.method==='POST'&&!req.is('application/json'))return res.status(415).json({error:'JSON erforderlich.'});next();});
let ready;
async function init(){if(!ready)ready=dbQuery('CREATE TABLE IF NOT EXISTS cad_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, project_id TEXT, document TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)').catch(e=>{ready=null;throw e;});await ready;}
router.use(async(req,res,next)=>{try{await init();next();}catch(e){next(e);}});
router.get('/projects',async(req,res,next)=>{try{const r=await dbQuery('SELECT id, title FROM projects WHERE deleted_at IS NULL ORDER BY title');res.json(r.rows);}catch(e){next(e);}});
router.get('/documents',async(req,res,next)=>{try{res.json((await dbQuery('SELECT id,name,project_id,revision,updated_at FROM cad_documents WHERE owner_id = ? ORDER BY updated_at DESC',[String(req.user.id)])).rows);}catch(e){next(e);}});
router.get('/documents/:id',async(req,res,next)=>{try{const r=await dbQuery('SELECT * FROM cad_documents WHERE id = ? AND owner_id = ?',[req.params.id,String(req.user.id)]);if(!r.rows[0])return res.status(404).json({error:'Zeichnung nicht gefunden.'});const row=r.rows[0];res.json({...row,document:JSON.parse(row.document)});}catch(e){next(e);}});
router.post('/documents',async(req,res,next)=>{let doc;try{if(JSON.stringify(req.body).length>2000000)throw Error('Zeichnung zu groß.');doc=validate(req.body.document);}catch(e){return res.status(400).json({error:e.message});}
 try{const id=req.body.id||crypto.randomUUID(),owner=String(req.user.id),project=req.body.projectId?String(req.body.projectId):null,revision=req.body.revision,now=new Date().toISOString();
 if(typeof id!=='string'||id.length>80)return res.status(400).json({error:'Ungültige ID.'});
 if(project&&!(await dbQuery('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL',[project])).rows.length)return res.status(400).json({error:'Auftrag nicht gefunden.'});
 const result=await withTransaction(async tx=>{const r=await tx.query('SELECT revision FROM cad_documents WHERE id = ? AND owner_id = ?'+(process.env.DATABASE_URL?' FOR UPDATE':''),[id,owner]);if(req.body.id){if(!r.rows.length)return {status:404,error:'Zeichnung nicht gefunden.'};if(r.rows[0].revision!==revision)return {status:409,error:'Die Zeichnung wurde auf einem anderen Gerät geändert. Bitte neu öffnen oder als Kopie speichern.'};await tx.query('UPDATE cad_documents SET name = ?,project_id = ?,document = ?,revision = ?,updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?',[doc.name,project,JSON.stringify(doc),revision+1,now,id,owner,revision]);const current=await tx.query('SELECT revision,document FROM cad_documents WHERE id = ? AND owner_id = ?',[id,owner]);if(current.rows[0].document!==JSON.stringify(doc))return {status:409,error:'Zeichnung wurde gleichzeitig geändert.'};return {id,revision:revision+1};}
 await tx.query('INSERT INTO cad_documents (id,owner_id,name,project_id,document,revision,updated_at) VALUES (?,?,?,?,?,?,?)',[id,owner,doc.name,project,JSON.stringify(doc),1,now]);return {id,revision:1};});if(result.error)return res.status(result.status).json({error:result.error});res.json(result);
 }catch(e){next(e);}});
router.post('/workshop', (req,res)=>{try{const doc=validate(req.body);if(JSON.stringify(doc).length>2000000)throw Error('Zeichnung zu groß.');workshop(doc,res);}catch(e){if(!res.headersSent)res.status(400).json({error:e.message});else res.destroy();}});
module.exports=router;
