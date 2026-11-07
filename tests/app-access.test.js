const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express');
process.env.JWT_SECRET='synthetic-app-access-test';
test('customer permissions cover every route before reading data, uploading or deleting',async()=>{
 let firma={},queries=[];const files=[{id:1,customer_id:10},{id:2,customer_id:20}];
 require.cache[require.resolve('../utils/companySettings')]={exports:{getFirma:async()=>firma}};
 require.cache[require.resolve('../utils/db')]={exports:{dbQuery:async(sql,args)=>{queries.push({sql,args});if(sql.startsWith('DELETE FROM customer_files')){const i=files.findIndex(f=>f.id===Number(args[0])&&f.customer_id===Number(args[1]));if(i>=0)files.splice(i,1);}return {rows:[]};}}};
 const app=express();app.use(express.urlencoded({extended:false}));app.use((req,res,next)=>{req.user={id:1,role:req.headers['x-role']||'EMPLOYEE'};next();});app.use('/customers',require('../routes/customerRoutes'));
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://localhost:'+server.address().port;
 const call=(path,method='GET',body='',role='EMPLOYEE')=>fetch(base+'/customers'+path,{method,redirect:'manual',headers:{'x-role':role,'Content-Type':'application/x-www-form-urlencoded'},...(method==='POST'?{body}:{})});
 try{for(const [path,method] of [['/','GET'],['/check-duplicate?email=test','GET'],['/10/projects','GET'],['/delete','POST'],['/10/upload','POST'],['/files/delete','POST'],['/import','POST']])assert.equal((await call(path,method)).status,403,path);assert.equal(queries.length,0);
 firma={perm_admin_customers:'false'};assert.equal((await call('/delete','POST','id=10','ADMIN')).status,403);assert.equal(queries.length,0);
 assert.equal((await call('/files/delete','POST','file_id=2&customer_id=10','CHEF')).status,302);assert.equal(files.length,2);
 assert.equal((await call('/files/delete','POST','file_id=1&customer_id=10','CHEF')).status,302);assert.deepEqual(files,[{id:2,customer_id:20}]);
 firma={perm_employee_customers:'true'};assert.equal((await call('/check-duplicate')).status,200);
 }finally{await new Promise(r=>server.close(r));}
});
