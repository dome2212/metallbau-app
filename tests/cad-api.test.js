const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),sqlite=require('sqlite3');
process.env.JWT_SECRET='synthetic-cad-api-test';
test('CAD persistence enforces permissions, ownership, revisions and PDF validation',async()=>{
 const db=new sqlite.Database(':memory:');const query=(sql,params=[])=>new Promise((resolve,reject)=>{if(/^\s*SELECT/i.test(sql))db.all(sql,params,(e,rows)=>e?reject(e):resolve({rows}));else db.run(sql,params,function(e){e?reject(e):resolve({rows:[],lastID:this.lastID});});});let lock=Promise.resolve();
 const withTransaction=fn=>{const run=lock.then(async()=>{await query('BEGIN');try{const r=await fn({query});await query('COMMIT');return r;}catch(e){await query('ROLLBACK');throw e;}});lock=run.catch(()=>{});return run;};
 require.cache[require.resolve('../utils/db')]={exports:{dbQuery:query,withTransaction}};
 require.cache[require.resolve('../utils/companySettings')]={exports:{getFirma:async()=>({})}};
 await query('CREATE TABLE projects(id INTEGER PRIMARY KEY,title TEXT,deleted_at TEXT)');await query("INSERT INTO projects VALUES(1,'Testauftrag',NULL)");
 const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.headers['x-user'])req.user={id:req.headers['x-user'],role:req.headers['x-role']||'CHEF'};next();});app.use('/cad/api',require('../routes/cadRoutes'));
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://localhost:'+server.address().port+'/cad/api';
 const call=async(path,body,user='alice',role='CHEF')=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-user':user,'x-role':role},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.arrayBuffer()};};
 try{const document={version:1,name:'Test',objects:[{type:'rect',x:0,y:0,w:40,h:40,depth:1000}]};assert.equal((await call('/documents',null,'staff','EMPLOYEE')).status,403);
 assert.equal((await fetch(base+'/documents')).status,403);assert.equal((await fetch(base+'/documents',{method:'POST',headers:{'x-user':'alice','Content-Type':'application/x-www-form-urlencoded'},body:'bad=value'})).status,415);
 const created=await call('/documents',{document,projectId:1});assert.equal(created.status,200);assert.equal(created.body.revision,1);const id=created.body.id;
 assert.equal((await call('/documents/'+id,null,'bob')).status,404);assert.deepEqual((await call('/documents',null,'bob')).body,[]);
 assert.equal((await call('/documents',{id,revision:1,document},'bob')).status,404);
 const edits=await Promise.all([call('/documents',{id,revision:1,document:{...document,name:'Edit 1'}}),call('/documents',{id,revision:1,document:{...document,name:'Edit 2'}})]);assert.deepEqual(edits.map(x=>x.status).sort(),[200,409]);
 assert.equal((await call('/documents',{document:{...document,objects:[{...document.objects[0],depth:-1}]}})).status,400);
 assert.equal((await call('/documents',{document,projectId:999})).status,400);
 const opened=await call('/documents/'+id);assert.equal(opened.body.revision,2);assert.equal(opened.body.document.version,1);
 const pdf=await call('/workshop',document);assert.equal(pdf.status,200);assert.equal(Buffer.from(pdf.body).subarray(0,4).toString(),'%PDF');assert.equal((await call('/workshop',{})).status,400);
 }finally{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));}
});
