const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),{Pool}=require('pg'),crypto=require('crypto');
const socket=process.env.PR25_PG_SOCKET;
test('concurrent offer conversion uses PostgreSQL row locks and returns the same invoice', {skip:!socket},async()=>{
 process.env.JWT_SECRET='synthetic-pg-conversion-test';process.env.DATABASE_URL='postgresql://test-only';
 const schema='pr25_'+crypto.randomBytes(6).toString('hex'),options={host:socket,port:Number(process.env.PR25_PG_PORT||55432),database:'postgres',user:'postgres'};
 const admin=new Pool(options);await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new Pool({...options,options:`-c search_path=${schema}`});
 const sql=(text,args=[])=>{let n=0;return [text.replace(/\?/g,()=>'$'+(++n)),args];};
 const dbQuery=async(text,args)=>{const r=await pool.query(...sql(text,args));return {rows:r.rows,lastID:r.rows[0]?.id};};
 const withTransaction=async fn=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await fn({query:async(text,args)=>{const r=await client.query(...sql(text,args));return {rows:r.rows,lastID:null};}});await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}};
 require.cache[require.resolve('../utils/db')]={exports:{dbQuery,withTransaction}};require.cache[require.resolve('../utils/companySettings')]={exports:{getFirma:async()=>({invoice_prefix:'RECH',zahlungsfrist:'14'}),setFirmaValue:async()=>{}}};require.cache[require.resolve('../utils/notifier')]={exports:{sendEmail:async()=>{}}};
 let server;
 try{
  await pool.query(`CREATE TABLE customers(id SERIAL PRIMARY KEY,company_name TEXT,contact_person TEXT);
  CREATE TABLE projects(id SERIAL PRIMARY KEY,customer_id INTEGER,title TEXT,description TEXT,total_price NUMERIC,status TEXT,offer_id INTEGER,planned_hours NUMERIC,deleted_at TEXT);
  CREATE TABLE documents(id SERIAL PRIMARY KEY,doc_type TEXT,doc_number TEXT,customer_id INTEGER,status TEXT,tax_rate NUMERIC,subtotal NUMERIC,tax_amount NUMERIC,total_amount NUMERIC,due_date TEXT,discount_percent NUMERIC,discount_amount NUMERIC,related_document_id INTEGER);
  CREATE TABLE document_items(id SERIAL PRIMARY KEY,document_id INTEGER,description TEXT,quantity NUMERIC,unit TEXT,price NUMERIC,discount_percent NUMERIC);
  INSERT INTO customers VALUES(1,'Test',NULL);
  INSERT INTO documents(id,doc_type,customer_id,status,tax_rate,subtotal,tax_amount,total_amount,discount_percent,discount_amount) VALUES(100,'OFFER',1,'OFFEN',19,135,25.65,160.65,0,0);
  INSERT INTO document_items(document_id,description,quantity,unit,price,discount_percent) VALUES(100,'Profil',3,'m',50,10);
  CREATE FUNCTION delay_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.doc_type='INVOICE' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$;
  CREATE TRIGGER delay BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION delay_invoice();`);
  const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));app.use((req,res,next)=>{req.user={id:1,role:'CHEF'};next();});app.use('/documents',require('../routes/documentRoutes'));
  server=app.listen(0);await new Promise(r=>server.once('listening',r));const url='http://localhost:'+server.address().port+'/documents';
  const post=(path,body)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual',body:new URLSearchParams(body)});
  const projects=await Promise.all(Array.from({length:3},()=>post('/offers/convert-to-project',{offer_id:'100'})));assert.ok(projects.every(r=>r.status===302));assert.equal(new Set(projects.map(r=>r.headers.get('location'))).size,1);assert.equal((await pool.query('SELECT id FROM projects WHERE offer_id=100')).rows.length,1);assert.equal((await pool.query('SELECT status FROM documents WHERE id=100')).rows[0].status,'ANGENOMMEN');
  const responses=await Promise.all(Array.from({length:6},(_,i)=>i===5?post('/convert-to-invoice/100',{}):post('/offers/convert-to-invoice',{offer_id:'100'})));
  assert.ok(responses.every(r=>r.status===302));const rows=(await pool.query("SELECT * FROM documents WHERE doc_type='INVOICE' AND related_document_id=100")).rows;assert.equal(rows.length,1);const id=rows[0].id;assert.ok(responses.slice(0,5).every(r=>r.headers.get('location')==='/documents/invoices/'+id));assert.equal(responses[5].headers.get('location'),'/documents/invoices');
  const items=(await pool.query('SELECT * FROM document_items WHERE document_id=$1',[id])).rows;assert.equal(items.length,1);assert.equal(Number(items[0].discount_percent),10);assert.equal(Number(rows[0].total_amount),160.65);
  await pool.query('ALTER TABLE documents ADD COLUMN status_note TEXT, ADD COLUMN invoice_subtype TEXT');
  const input={type:'rechnung',customer_id:1,items:[{description:'Neubau',quantity:'2,5',unit:'m',price:120,discount_percent:10}],discount_percent_doc:5};
  const create=()=>fetch(url+'/belege',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const created=await Promise.all(Array.from({length:4},()=>create()));assert.ok(created.every(r=>r.status===200));const ids=await Promise.all(created.map(async r=>(await r.json()).id));assert.equal(new Set(ids).size,4);
  const saved=(await pool.query('SELECT * FROM documents WHERE id=ANY($1::int[])',[ids])).rows;assert.equal(new Set(saved.map(d=>d.doc_number)).size,4);assert.ok(saved.every(d=>Number(d.total_amount)===305.24));
  const update=await fetch(url+'/belege/'+ids[0],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,status_note:'PG updated'})});assert.equal(update.status,200);assert.equal((await pool.query('SELECT status_note FROM documents WHERE id=$1',[ids[0]])).rows[0].status_note,'PG updated');

  const flow=require('../utils/projectWorkflow');await flow.init();const projectId=(await pool.query('SELECT id FROM projects WHERE offer_id=100')).rows[0].id;
  const writes=await Promise.allSettled([flow.update(projectId,0,data=>({...data,plan:{hours:5}})),flow.update(projectId,0,data=>({...data,plan:{hours:10}}))]);
  assert.equal(writes.filter(v=>v.status==='fulfilled').length,1);assert.equal(writes.find(v=>v.status==='rejected').reason.status,409);assert.equal((await flow.load(projectId)).revision,1);
  await assert.rejects(flow.update(projectId,1,async(data,tx)=>{await tx.query('UPDATE projects SET planned_hours=99 WHERE id=?',[projectId]);throw Error('synthetic rollback');}),/synthetic rollback/);assert.equal((await pool.query('SELECT planned_hours FROM projects WHERE id=$1',[projectId])).rows[0].planned_hours,null);
  await pool.query('DELETE FROM projects WHERE id=$1',[projectId]);assert.equal((await pool.query('SELECT * FROM project_workflow WHERE project_id=$1',[projectId])).rows.length,0);
 }finally{if(server)await new Promise(r=>server.close(r));await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
