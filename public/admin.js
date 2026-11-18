const $=s=>document.querySelector(s);
const loginSection=$('#adminLogin'),workspace=$('#adminWorkspace'),message=$('#adminMessage');
const list=$('#receiptList'),detail=$('#receiptDetail'),history=$('#reviewHistory');
const fieldsBox=$('#reviewFields'),image=$('#receiptImage');
let cursor=null,selected=null,imageUrl=null;
const fieldDefs=[
  ['operationType','Tipo de operación','select',['BANK_TRANSFER','CASH_DEPOSIT','CHECK_DEPOSIT','UNKNOWN']],
  ['bank','Banco'],['reference','Referencia'],['amount','Monto','number'],
  ['currency','Moneda','select',['GTQ','USD']],
  ['transactionDate','Fecha','date'],['transactionTime','Hora'],
  ['destinationAccount','Cuenta destino'],['recipientName','Beneficiario'],['senderName','Remitente'],
];
function notice(text,error=false){message.className=error?'error':'ok';message.textContent=text;}
async function api(path,options={}){
  const r=await fetch('/api/admin'+path,{...options,credentials:'same-origin',cache:'no-store'});
  if(r.status===401){loginSection.hidden=false;workspace.hidden=true;throw new Error('Sesión administrativa expirada');}
  if(!r.ok){const data=await r.json().catch(()=>({}));throw new Error(data.message || 'Solicitud fallida');}
  return r.json();
}
async function load(reset=true){
  if(reset){cursor=null;list.replaceChildren();}
  let url='/receipts?status='+encodeURIComponent($('#statusFilter').value);
  if(cursor)url+='&before='+encodeURIComponent(cursor);
  const data=await api(url);
  for(const r of data.items){
    const b=document.createElement('button');
    b.type='button';b.className='receipt-item';
    const top=document.createElement('strong');top.textContent=r.status+' · '+(r.bank||'Banco sin identificar');
    const info=document.createElement('span');
    info.textContent=[r.created_at,r.reference||'Sin referencia',r.amount===null?'':'Monto '+r.amount].filter(Boolean).join(' · ');
    b.append(top,info);b.addEventListener('click',()=>openReceipt(r.id).catch(e=>notice(e.message,true)));
    list.append(b);
  }
  cursor=data.nextCursor;$('#moreBtn').hidden=!cursor;
  if(!list.children.length)list.textContent='No hay comprobantes en esta categoría.';
}
function addField(name,label,type='text',values=[] ,extracted={}){
  const wrapper=document.createElement('label');wrapper.textContent=label;
  let input;
  if(type==='select'){
    input=document.createElement('select');
    const choices=[...values];
    if(name==='currency')choices.unshift('');
    for(const value of choices){const option=document.createElement('option');option.value=value;option.textContent=value||'Sin identificar';input.append(option);}
  }else{
    input=document.createElement('input');input.type=type;
    if(type==='number')input.step='any';
  }
  input.name=name;input.value=extracted[name]??'';
  wrapper.append(input);fieldsBox.append(wrapper);
}
async function openReceipt(id){
  selected=null;$('#emptyDetail').hidden=true;detail.hidden=false;fieldsBox.replaceChildren();history.replaceChildren();
  if(imageUrl){URL.revokeObjectURL(imageUrl);imageUrl=null;}
  image.hidden=true;image.removeAttribute('src');
  const data=await api('/receipts/'+encodeURIComponent(id));
  selected=data.receipt;
  const summary=$('#detailSummary');summary.replaceChildren();
  for(const [key,value] of Object.entries({
    ID:selected.id,Estado:selected.status,Motivo:selected.reason,Fecha:selected.created_at,
    'Reprocesamientos':selected.retry_count,
    'Anomalías':(selected.extracted?.anomalies||[]).join('; ')||'Ninguna reportada'
  })){
    const line=document.createElement('div');line.textContent=key+': '+(value??'—');summary.append(line);
  }
  for(const [name,label,type,options] of fieldDefs) addField(name,label,type,options,selected.extracted||{});
  $('#reviewForm').hidden=selected.status!=='REVIEW_REQUIRED';
  $('#reviewNote').value='';
  if(data.reviews.length){
    for(const review of data.reviews){const p=document.createElement('p');p.textContent=`${review.created_at} · ${review.action} · ${review.note}`;history.append(p);}
  }else history.textContent='Sin decisiones manuales.';
  const response=await fetch('/api/admin/receipts/'+encodeURIComponent(id)+'/image',{credentials:'same-origin',cache:'no-store'});
  if(response.ok){
    const blob=await response.blob();imageUrl=URL.createObjectURL(blob);image.src=imageUrl;image.hidden=false;
  }else notice('No se pudo cargar la imagen original.',true);
}
async function decide(action){
  if(!selected)return;
  const note=$('#reviewNote').value.trim();
  if(note.length<5){notice('Escribe una justificación de al menos 5 caracteres.',true);return;}
  const fields={};
  for(const input of fieldsBox.querySelectorAll('input,select')){
    fields[input.name]=input.name==='amount' ? (input.value===''?null:Number(input.value)) : (input.value||null);
  }
  if(!confirm(action==='APPROVED'?'¿Aprobar documentalmente este comprobante?':'¿Rechazar este comprobante?'))return;
  try{
    $('#approveBtn').disabled=$('#rejectBtn').disabled=true;
    const result=await api('/receipts/'+encodeURIComponent(selected.id)+'/review',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,note,fields})
    });
    notice('Decisión registrada: '+result.status);
    await Promise.all([openReceipt(selected.id),load()]);
  }catch(e){notice(e.message,true);}
  finally{$('#approveBtn').disabled=$('#rejectBtn').disabled=false;}
}
$('#adminLoginForm').addEventListener('submit',async e=>{
  e.preventDefault();const token=$('#adminToken').value;
  try{
    const response=await fetch('/api/admin/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token}),credentials:'same-origin'
    });
    if(!response.ok)throw new Error('Credencial inválida');
    $('#adminToken').value='';loginSection.hidden=true;workspace.hidden=false;
    notice('Sesión administrativa iniciada');await load();
  }catch(err){notice(err.message,true);}
});
$('#logoutBtn').addEventListener('click',async()=>{
  try{await api('/logout',{method:'POST'});}catch{}
  loginSection.hidden=false;workspace.hidden=true;
  if(imageUrl)URL.revokeObjectURL(imageUrl);image.removeAttribute('src');imageUrl=null;
  notice('Sesión cerrada');
});
$('#statusFilter').addEventListener('change',()=>load().catch(e=>notice(e.message,true)));
$('#refreshBtn').addEventListener('click',()=>load().catch(e=>notice(e.message,true)));
$('#moreBtn').addEventListener('click',()=>load(false).catch(e=>notice(e.message,true)));
$('#approveBtn').addEventListener('click',()=>decide('APPROVED'));
$('#rejectBtn').addEventListener('click',()=>decide('REJECTED'));
api('/session').then(r=>{
  if(r.authenticated){loginSection.hidden=true;workspace.hidden=false;return load();}
}).catch(()=>{});
