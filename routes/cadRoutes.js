const express = require('express');
const crypto = require('crypto');
const {dbQuery, withTransaction} = require('../utils/db');
const {requirePerm, hasPerm, canSeeMoney} = require('../middleware/auth');
const {getFirma} = require('../utils/companySettings');
const {validate} = require('../Public/js/cad-document');
const {workshop} = require('../utils/cadWorkshop');
const approval = require('../utils/cadApproval');
const { isOffice } = require('../middleware/auth');
const router = express.Router();
router.use(requirePerm('cad', true, false, 'CAD Studio'));
router.use((req,res,next)=>req.method==='POST'&&!req.is('application/json')?res.status(415).json({error:'JSON erforderlich.'}):next());
let ready;
async function init(){
 if(!ready)ready=(async()=>{
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, project_id TEXT, document TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)');
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_document_access (document_id TEXT NOT NULL, user_id TEXT NOT NULL, can_edit INTEGER NOT NULL, PRIMARY KEY(document_id,user_id))');
  await dbQuery('CREATE TABLE IF NOT EXISTS cad_document_versions (document_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, updated_at TEXT NOT NULL, author_id TEXT NOT NULL, PRIMARY KEY(document_id,revision))');
  await approval.init();
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
router.get('/documents/:id/approval-offers',async(req,res,next)=>{try{
 const row=await accessible(req),firma=await getFirma();
 if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});
 if(!isOffice(req.user)||!hasPerm(req.user,'documents',firma,true,false)||!canSeeMoney(req.user,firma))return res.status(403).json({error:'Berechtigung für Angebote und Beträge erforderlich.'});
 if(!row.project_id)return res.status(400).json({error:'Zeichnung zuerst einem Auftrag zuordnen.'});
 const project=(await dbQuery('SELECT customer_id FROM projects WHERE id=? AND deleted_at IS NULL',[row.project_id])).rows[0];
 res.json(project?(await dbQuery("SELECT id,doc_number,status FROM documents WHERE doc_type='OFFER' AND customer_id=? ORDER BY id DESC",[project.customer_id])).rows:[]);
 }catch(e){next(e);}});
// Customer approvals refer to an immutable PDF generated from a saved revision.
router.post('/documents/:id/customer-approvals',async(req,res,next)=>{try{
 const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});
 if(row.revision!==req.body.revision)return res.status(409).json({error:'Die gespeicherte Revision hat sich geändert. Bitte erneut öffnen.'});
 if(!approval.validPassword(req.body.password))return res.status(400).json({error:'Passwort mit 12 bis 128 Zeichen eingeben.'});
 const doc=validate(req.body.document);if(JSON.stringify(doc)!==row.document)return res.status(409).json({error:'Bitte zuerst den aktuellen Zeichnungsstand auf dem Server speichern.'});
 let offer,offerItems,offerPdf,offerRevision;
 if(req.body.offerId){
  const firma=await getFirma();
  if(!isOffice(req.user)||!hasPerm(req.user,'documents',firma,true,false)||!canSeeMoney(req.user,firma))return res.status(403).json({error:'Berechtigung für Angebote und Beträge erforderlich.'});
  if(!row.project_id)return res.status(400).json({error:'Zeichnung zuerst einem Auftrag zuordnen.'});
  offer=(await dbQuery("SELECT d.*,c.company_name,c.contact_person,c.street,c.zip,c.city,c.email,c.phone FROM documents d JOIN customers c ON c.id=d.customer_id JOIN projects p ON p.customer_id=d.customer_id WHERE d.id=? AND d.doc_type='OFFER' AND p.id=? AND p.deleted_at IS NULL",[req.body.offerId,row.project_id])).rows[0];
  if(!offer)return res.status(400).json({error:'Angebot gehört nicht zum Auftrag oder Kunden.'});
  offerItems=(await dbQuery('SELECT * FROM document_items WHERE document_id=? ORDER BY id',[offer.id])).rows;
  offerRevision=require('../utils/billingService').revision(offer,offerItems);
  offerPdf=await require('../utils/pdfGenerator').generateDocumentPDFBuffer(offer,offerItems);
 }
 const passwordHash=await approval.hashPassword(req.body.password),token=crypto.randomBytes(32).toString('base64url'),id=crypto.randomUUID(),pdf=await approval.createPdf(doc),now=new Date(),expires=new Date(now.getTime()+7*86400000).toISOString(),digest=approval.hash(pdf);
 await withTransaction(async tx=>{
  const current=(await tx.query('SELECT * FROM cad_documents WHERE id=?'+(process.env.DATABASE_URL?' FOR UPDATE':''),[row.id])).rows[0];
  if(!current||current.revision!==row.revision||current.document!==row.document||current.project_id!==row.project_id)throw Object.assign(Error('Zeichnungsstand wurde geändert. Bitte neu laden.'),{status:409});
  if(offer){
   const latest=(await tx.query('SELECT * FROM documents WHERE id=?'+(process.env.DATABASE_URL?' FOR UPDATE':''),[offer.id])).rows[0],latestItems=(await tx.query('SELECT * FROM document_items WHERE document_id=? ORDER BY id',[offer.id])).rows;
   if(!latest||require('../utils/billingService').revision(latest,latestItems)!==offerRevision)throw Object.assign(Error('Angebotsstand wurde geändert. Bitte neu laden.'),{status:409});
  }
  await tx.query('INSERT INTO cad_customer_approvals(id,document_id,revision,token_hash,pdf,pdf_hash,created_at,expires_at,password_hash,offer_id,offer_revision,offer_number,offer_pdf,offer_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,row.id,row.revision,approval.hash(token),pdf.toString('base64'),digest,now.toISOString(),expires,passwordHash,offer?.id||null,offerRevision||null,offer?.doc_number||null,offerPdf?.toString('base64')||null,offerPdf?approval.hash(offerPdf):null]);
 });
 res.json({id,revision:row.revision,hash:digest,expires,path:'/cad-approval/'+token});
 }catch(e){next(e);}});
router.get('/documents/:id/customer-approvals',async(req,res,next)=>{try{const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});const rows=(await dbQuery('SELECT id,revision,pdf_hash,created_at,expires_at,approved_at,signer,signature,revoked_at,offer_id,offer_revision,offer_number,offer_hash,CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_password FROM cad_customer_approvals WHERE document_id = ? ORDER BY created_at DESC',[row.id])).rows;
 for(const a of rows)if(a.offer_id){const current=(await dbQuery('SELECT * FROM documents WHERE id=?',[a.offer_id])).rows[0];const items=(await dbQuery('SELECT * FROM document_items WHERE document_id=? ORDER BY id',[a.offer_id])).rows;a.offer_outdated=!current||require('../utils/billingService').revision(current,items)!==a.offer_revision;}
 res.json(rows);}catch(e){next(e);}});
router.get('/documents/:id/customer-approvals/:approvalId/pdf',async(req,res,next)=>{try{const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});const a=(await dbQuery('SELECT pdf FROM cad_customer_approvals WHERE id = ? AND document_id = ?',[req.params.approvalId,row.id])).rows[0];if(!a)return res.status(404).end();res.type('application/pdf').set('Cache-Control','no-store').set('Content-Disposition','attachment; filename="freigabe.pdf"').send(Buffer.from(a.pdf,'base64'));}catch(e){next(e);}});
router.get('/documents/:id/customer-approvals/:approvalId/offer.pdf',async(req,res,next)=>{try{
 const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).end();
 const firma=await getFirma();if(!isOffice(req.user)||!hasPerm(req.user,'documents',firma,true,false)||!canSeeMoney(req.user,firma))return res.status(403).end();
 const a=(await dbQuery('SELECT offer_pdf FROM cad_customer_approvals WHERE id=? AND document_id=?',[req.params.approvalId,row.id])).rows[0];if(!a?.offer_pdf)return res.status(404).end();
 res.type('application/pdf').set('Cache-Control','no-store').set('Content-Disposition','attachment; filename="freigabe-angebot.pdf"').send(Buffer.from(a.offer_pdf,'base64'));
 }catch(e){next(e);}});
router.post('/documents/:id/customer-approvals/:approvalId/revoke',async(req,res,next)=>{try{const row=await accessible(req);if(!row||row.owner_id!==user(req))return res.status(404).json({error:'Eigene Zeichnung erforderlich.'});await dbQuery('UPDATE cad_customer_approvals SET revoked_at = ? WHERE id = ? AND document_id = ?',[new Date().toISOString(),req.params.approvalId,row.id]);res.json({ok:true});}catch(e){next(e);}});
router.post('/workshop',(req,res)=>{try{const doc=validate(req.body);if(JSON.stringify(doc).length>2000000)throw Error('Zeichnung zu groß.');const options=req.body.output||{};if(!['workshop','customer','labels','installation','parts'].includes(options.kind||'workshop')||![0,1,2,5,10,20,50].includes(options.scale||0))throw Error('Ungültige PDF-Auswahl.');workshop(doc,res,options);}catch(e){if(!res.headersSent)res.status(400).json({error:e.message});else res.destroy();}});
router.initialize=init;
module.exports=router;
