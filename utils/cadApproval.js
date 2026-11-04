const crypto = require('crypto');
const { PassThrough } = require('stream');
const { dbQuery } = require('./db');
const { workshop } = require('./cadWorkshop');
let ready;
async function init(){
 if(!ready)ready=dbQuery('CREATE TABLE IF NOT EXISTS cad_customer_approvals (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, pdf TEXT NOT NULL, pdf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approved_at TEXT, signer TEXT, signature TEXT, revoked_at TEXT)').catch(e=>{ready=null;throw e;});
 await ready;
}
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function validToken(token){return typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token);}
async function createPdf(document){
 const stream=new PassThrough(),chunks=[];stream.type=()=>stream;stream.setHeader=()=>{};
 const done=new Promise((resolve,reject)=>{stream.on('data',chunk=>chunks.push(chunk));stream.on('end',()=>resolve(Buffer.concat(chunks)));stream.on('error',reject);});
 workshop(document,stream,{kind:'customer',scale:0});return done;
}
module.exports={init,hash,validToken,createPdf};
