const {test}=require('node:test'),assert=require('node:assert/strict'),sqlite=require('sqlite3'),fs=require('fs'),os=require('os'),path=require('path'),{execFile}=require('child_process'),{promisify}=require('util');
const exec=promisify(execFile);
test('server database startup preserves administrator and chef roles across restarts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'app-roles-'));fs.mkdirSync(path.join(dir,'config'));fs.copyFileSync(path.join(__dirname,'../config/database.js'),path.join(dir,'config/database.js'));fs.symlinkSync(path.join(__dirname,'../node_modules'),path.join(dir,'node_modules'),'dir');
 const db=new sqlite.Database(path.join(dir,'database.sqlite'));const run=(s,p=[])=>new Promise((a,b)=>db.run(s,p,e=>e?b(e):a()));
 try{await run('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, created_at DATETIME)');await run("INSERT INTO users(id,username,password_hash,role) VALUES (1,'existing-chef','x','CHEF'),(2,'existing-admin','x','ADMIN')");await new Promise(r=>db.close(r));
 for(let i=0;i<2;i++)await exec(process.execPath,['-e',"const db=require('./config/database');setTimeout(()=>db.close(err=>{if(err)process.exitCode=1}),500);"],{cwd:dir,env:{...process.env,DATABASE_URL:''},timeout:10000});
 const resultDb=new sqlite.Database(path.join(dir,'database.sqlite'));const rows=await new Promise((a,b)=>resultDb.all('SELECT username,role FROM users ORDER BY id',(e,r)=>e?b(e):a(r)));await new Promise(r=>resultDb.close(r));assert.deepEqual(rows,[{username:'existing-chef',role:'CHEF'},{username:'existing-admin',role:'ADMIN'}]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
