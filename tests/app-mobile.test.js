const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),jwt=require('jsonwebtoken'),sqlite=require('sqlite3');
process.env.JWT_SECRET='synthetic-mobile-test';
const db=new sqlite.Database(':memory:');let settings={};
const query=(sql,params=[])=>new Promise((resolve,reject)=>{if(/^\s*(SELECT|WITH)/i.test(sql))db.all(sql,params,(e,rows)=>e?reject(e):resolve({rows}));else db.run(sql,params,function(e){e?reject(e):resolve({rows:[],lastID:this.lastID});});});
require.cache[require.resolve('../utils/webpush')]={exports:{sendPush:async()=>{}}};
require.cache[require.resolve('../utils/notifier')]={exports:{sendWhatsApp:async()=>{}}};
require.cache[require.resolve('../utils/db')]={exports:{dbQuery:query,withTransaction:async()=>{throw Error('Unexpected transaction');}}};
require.cache[require.resolve('../utils/companySettings')]={exports:{getFirma:async()=>settings}};
const api=require('../routes/apiRoutes'),web=require('../routes/timetrackingRoutes'),projects=require('../routes/projectRoutes');
const token=(role)=>jwt.sign({id:1,username:'test',role},process.env.JWT_SECRET);
test('mobile permissions and private financial data, plus atomic switching on mobile and web',async()=>{
 for(const sql of [
 'CREATE TABLE customers(id INTEGER PRIMARY KEY,company_name TEXT,contact_person TEXT,city TEXT,phone TEXT,email TEXT,street TEXT,zip TEXT)',
 'CREATE TABLE projects(id INTEGER PRIMARY KEY,customer_id INTEGER,title TEXT,description TEXT,status TEXT,total_price REAL,site_lat REAL,site_lng REAL,site_radius INT,site_note TEXT,created_at TEXT,deleted_at TEXT)',
 'CREATE TABLE documents(id INTEGER PRIMARY KEY,doc_type TEXT,doc_number TEXT,customer_id INTEGER,total_amount REAL,status TEXT,due_date TEXT,subtotal REAL,secret_cost REAL)',
 'CREATE TABLE document_items(id INTEGER PRIMARY KEY,document_id INTEGER,description TEXT,quantity REAL,unit TEXT,price REAL)',
 'CREATE TABLE project_photos(id INTEGER PRIMARY KEY,project_id INTEGER,created_at TEXT)',
 'CREATE TABLE project_notes(id INTEGER PRIMARY KEY,project_id INTEGER,created_at TEXT)',
 'CREATE TABLE project_tasks(id INTEGER PRIMARY KEY,project_id INTEGER,status TEXT,created_at TEXT)',
 'CREATE TABLE project_measurements(id INTEGER PRIMARY KEY,project_id INTEGER,created_at TEXT)',
 'CREATE TABLE tickers(id INTEGER PRIMARY KEY,created_at TEXT)',
 'CREATE TABLE project_status_log(id INTEGER PRIMARY KEY,project_id INTEGER,old_status TEXT,new_status TEXT,changed_by TEXT)',
 'CREATE TABLE time_logs(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,note TEXT,project_id INTEGER,customer_id INTEGER,latitude REAL,longitude REAL,timestamp TEXT DEFAULT CURRENT_TIMESTAMP)'
 ])await query(sql);
 await query("INSERT INTO customers (id,company_name) VALUES (1,'Synthetic')");await query("INSERT INTO projects (id,customer_id,title,status,total_price) VALUES(1,1,'Test','Offen',1234)");await query("INSERT INTO documents (id,doc_type,doc_number,customer_id,total_amount,status,subtotal,secret_cost) VALUES(1,'OFFER','A',1,1000,'Offen',800,500)");await query("INSERT INTO document_items (id,document_id,description,quantity,unit,price) VALUES(1,1,'Item',2,'Stk',400)");
 const app=express();app.use(express.json());app.use(express.urlencoded({extended:false}));app.use('/api/v2',api);const browserUser=(req,res,next)=>{req.user={id:1,username:'test',role:req.headers['x-role']||'EMPLOYEE'};next();};app.use('/timetracking',browserUser,web);app.use('/projects',browserUser,projects);const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://localhost:'+server.address().port;
 const call=(path,role='EMPLOYEE',body,method=body?'POST':'GET')=>fetch(base+path,{method,redirect:'manual',headers:{Authorization:'Bearer '+token(role),'Content-Type':'application/json','x-role':role},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await call('/api/v2/customers')).status,403);assert.equal((await call('/api/v2/documents')).status,403);
  let r=await call('/api/v2/projects');let data=await r.json();assert.equal(data[0].title,'Test');assert.equal(data[0].total_price,undefined);
  data=await(await call('/api/v2/projects/1')).json();assert.equal(data.title,'Test');assert.equal(data.total_price,undefined);
  settings.perm_employee_projects='false';assert.equal((await call('/api/v2/projects')).status,403);assert.equal((await call('/api/v2/projects/1/notes','EMPLOYEE',{note_text:'x'})).status,403);delete settings.perm_employee_projects;
  settings.perm_admin_customers='false';assert.equal((await call('/api/v2/customers','ADMIN')).status,403);settings.perm_employee_customers='true';assert.equal((await call('/api/v2/customers')).status,200);
  settings.perm_admin_documents='false';assert.equal((await call('/api/v2/documents','ADMIN')).status,403);delete settings.perm_admin_documents;
  assert.equal((await call('/projects/1/edit','ADMIN',{title:'Changed',description:'x',status:'Offen',total_price:'999'})).status,302);assert.equal((await query('SELECT total_price FROM projects WHERE id=1')).rows[0].total_price,1234);
  assert.equal((await call('/projects/1/edit','CHEF',{title:'Changed',description:'x',status:'Offen',total_price:'1500'})).status,302);assert.equal((await query('SELECT total_price FROM projects WHERE id=1')).rows[0].total_price,1500);
  let created=await call('/api/v2/projects','ADMIN',{title:'No money',total_price:999});assert.equal(created.status,201);let createdId=(await created.json()).id;assert.equal((await query('SELECT total_price FROM projects WHERE id=?',[createdId])).rows[0].total_price,0);
  data=await(await call('/api/v2/documents/1','ADMIN')).json();assert.equal(data.doc_number,'A');assert.equal(data.total_amount,undefined);assert.equal(data.secret_cost,undefined);assert.equal(data.items[0].price,undefined);
  data=await(await call('/api/v2/documents/1','CHEF')).json();assert.equal(data.total_amount,1000);assert.equal(data.items[0].price,400);
  data=await(await call('/api/v2/dashboard','ADMIN')).json();assert.equal(data.openOffersSum,null);assert.equal(data.recentDocs[0].total_amount,null);
  data=await(await call('/api/v2/dashboard','CHEF')).json();assert.equal(data.openOffersSum,1000);assert.equal(data.role,'ADMIN');
  settings.perm_employee_timetracking='false';assert.equal((await call('/api/v2/timetracking/stamp','EMPLOYEE',{type:'OUT'})).status,403);assert.equal((await call('/timetracking/stamp','EMPLOYEE',{type:'OUT'})).status,403);delete settings.perm_employee_timetracking;
  for(const path of ['/api/v2/timetracking/stamp','/timetracking/stamp']){assert.equal((await call(path,'EMPLOYEE',{type:'SWITCH'})).status,400);assert.equal((await query('SELECT * FROM time_logs')).rows.length,0);}
  settings.stamp_require_gps='false';await query("CREATE TRIGGER reject_in BEFORE INSERT ON time_logs WHEN NEW.type='IN' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");for(const path of ['/api/v2/timetracking/stamp','/timetracking/stamp']){assert.equal((await call(path,'EMPLOYEE',{type:'SWITCH',project_id:1})).status,500);assert.equal((await query('SELECT * FROM time_logs')).rows.length,0);}
  await query('DROP TRIGGER reject_in');for(const path of ['/api/v2/timetracking/stamp','/timetracking/stamp']){const response=await call(path,'EMPLOYEE',{type:'SWITCH',project_id:1});assert.equal(response.status,path.startsWith('/api')?200:302);const rows=(await query('SELECT * FROM time_logs ORDER BY id')).rows;assert.deepEqual(rows.map(x=>x.type),['OUT','IN']);assert.equal(rows[1].project_id,1);await query('DELETE FROM time_logs');}
 }finally{await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));}
});
