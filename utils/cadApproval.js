const crypto = require('crypto');
const { PassThrough } = require('stream');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const { dbQuery } = require('./db');
const { workshop } = require('./cadWorkshop');
let ready;
async function init(){
 if(!ready)ready=(async()=>{await dbQuery('CREATE TABLE IF NOT EXISTS cad_customer_approvals (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, pdf TEXT NOT NULL, pdf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, signer TEXT, signature TEXT, revoked_at TEXT)');
  try{await dbQuery('ALTER TABLE cad_customer_approvals ADD COLUMN password_hash TEXT');}catch(e){if(e.code!=='42701'&&!(e.code==='SQLITE_ERROR'&&/duplicate column name/i.test(e.message)))throw e;}
 })().catch(e=>{ready=null;throw e;});
 await ready;
}
function validPassword(value){return typeof value==='string'&&value.trim().length>=12&&value.length<=128&&Buffer.byteLength(value,'utf8')<=512;}
async function hashPassword(value){const salt=crypto.randomBytes(16);const key=await scrypt(value,salt,32);return salt.toString('hex')+':'+key.toString('hex');}
async function checkPassword(value,stored){if(!validPassword(value)||typeof stored!=='string'||!/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(stored))return false;const [salt,key]=stored.split(':');const actual=await scrypt(value,Buffer.from(salt,'hex'),32);return crypto.timingSafeEqual(actual,Buffer.from(key,'hex'));}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function validToken(token){return typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token);}
async function createPdf(document){
 const stream=new PassThrough(),chunks=[];stream.type=()=>stream;stream.setHeader=()=>{};
 const done=new Promise((resolve,reject)=>{stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>resolve(Buffer.concat(chunks)));stream.on('error',reject);});
 workshop(document,stream,{kind:'customer',scale:0});return done;
}
module.exports={init,hash,validToken,createPdf,validPassword,hashPassword,checkPassword};
