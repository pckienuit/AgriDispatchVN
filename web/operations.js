/* global location */
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export function operationsRoute(hash) {
  if (hash === '#shifts') return { name:'shifts' };
  const match = new RegExp(`^#shift/(${uuid})$`, 'i').exec(hash);
  return match ? { name:'shift', id:match[1].toLowerCase() } : null;
}
export function shiftActions(status, canOperate) {
  if (!canOperate) return [];
  return status === 'RUNNING' ? ['pause','complete'] : status === 'PAUSED' ? ['resume'] : [];
}
export function completeInput(area, note) {
  if (!/^[0-9]+$/.test(area)) return null;
  const areaM2 = Number(area), trimmed = note.trim();
  if (!Number.isSafeInteger(areaM2) || areaM2 < 1 || areaM2 > 2147483647 || [...trimmed].length > 500) return null;
  return { areaM2, ...(trimmed ? { note:trimmed } : {}) };
}
const labels = { RUNNING:'Đang làm',PAUSED:'Tạm dừng',COMPLETED:'Đã kết thúc' };
const events = { SHIFT_STARTED:'Bắt đầu ca',SHIFT_PAUSED:'Tạm dừng',SHIFT_RESUMED:'Tiếp tục',SHIFT_COMPLETED:'Kết thúc ca' };
const errors = { READINESS_INCOMPLETE:'Chưa đủ xác nhận sẵn sàng từ các chủ ruộng.',SHIFT_ALREADY_STARTED:'Ca đã được bắt đầu. Tải lại danh sách.',INVALID_TRANSITION:'Trạng thái ca đã đổi. Tải lại trước khi thao tác.',AREA_EXCEEDS_BOOKINGS:'Diện tích vượt tổng diện tích các đơn trong gói.',SHIFT_ALREADY_COMPLETED:'Ca đã kết thúc với số liệu khác.',FORBIDDEN:'Bạn không có quyền thao tác.',NOT_FOUND:'Không tìm thấy ca hoặc bạn không có quyền xem.' };
export async function renderOperations({main,api,session,announce,route,signIn}) {
  const doc=globalThis.document, hash=location.hash;
  if (!session.token) { signIn(hash); return; }
  const active=()=>location.hash===hash;
  const el=(tag,props={},children=[])=>{
    const node=doc.createElement(tag);
    for(const [key,value] of Object.entries(props)){
      if(value===false||value===undefined)continue;
      if(key==='text')node.textContent=value;
      else if(key==='click')node.addEventListener('click',value);
      else node.setAttribute(key,value===true?'':String(value));
    }
    for(const child of children)if(child)node.append(child);return node;
  };
  const roles=session.user.roles;
  const heading=el('h1',{tabindex:'-1',text:route.name==='shifts'?'Ca làm việc':'Chi tiết ca'});
  const content=el('section',{'aria-live':'polite',class:'page'});
  main.replaceChildren(heading,el('p',{text:'Kết thúc ca chỉ ghi công việc đã làm. Chưa phải nghiệm thu hoặc xác nhận đã nhận tiền.'}),el('a',{href:'#shifts',text:'Danh sách ca'}),content);
  heading.focus();
  if(!roles.some(role=>['operator','provider','coop'].includes(role))){content.textContent='Tài khoản này không có quyền xem ca.';return;}
  const error=(err)=>el('p',{class:'alert error',role:'alert',text:errors[err.code]??(err.status===401?'Phiên hết hạn. Đăng nhập lại.':'Không tải hoặc lưu được. Kiểm tra kết nối rồi thử lại; chưa coi thao tác là hoàn tất.')});
  async function post(path,body,button,feedback,onSuccess=load){
    if(button.disabled)return;button.disabled=true;feedback.replaceChildren();
    try{const {data}=await api.request('POST',path,{auth:true,body});if(!active())return;announce('Máy chủ đã ghi nhận thao tác.');await onSuccess(data);}
    catch(err){if(active()){feedback.replaceChildren(error(err));feedback.querySelector('[role=alert]')?.setAttribute('tabindex','-1');feedback.firstChild?.focus();}}
    finally{button.disabled=false;}
  }
  function formAction(action,id){
    const form=el('form',{class:'form',novalidate:true}),feedback=el('div',{'aria-live':'polite'});
    const field=(key,label,type='text')=>{
      const input=el('input',{id:key,name:key,type,...(key==='shift-area'?{min:1,max:2147483647,step:1}:{maxlength:500})});
      form.append(el('div',{class:'field'},[el('label',{for:key,text:label}),input]));return input;
    };
    const area=action==='complete'?field('shift-area','Diện tích thực hiện (m²)','number'):null;
    const note=field(action==='pause'?'shift-reason':'shift-note',action==='pause'?'Lý do tạm dừng':'Ghi chú (không bắt buộc)');
    const submit=el('button',{type:'submit',class:'btn primary',text:action==='pause'?'Tạm dừng ca':'Ghi kết thúc ca'});
    form.append(feedback,submit);
    form.addEventListener('submit',event=>{
      event.preventDefault();const body=action==='complete'?completeInput(area.value,note.value):note.value.trim()&&[...note.value.trim()].length<=500?{reason:note.value.trim()}:null;
      if(!body){feedback.replaceChildren(error({code:'VALIDATION_FAILED'}));feedback.firstChild.textContent=action==='pause'?'Nhập lý do từ 1 đến 500 ký tự.':'Nhập diện tích nguyên dương và ghi chú tối đa 500 ký tự.';(area??note).focus();return;}
      post(`/api/shifts/${id}/${action}`,body,submit,feedback);
    });return form;
  }
  async function load(){
    if(!active())return;content.replaceChildren(el('p',{role:'status',text:'Đang tải ca…'}));
    try{
      if(route.name==='shifts'){
        const [existing,pending]=await Promise.all([api.request('GET','/api/shifts?limit=100',{auth:true}),roles.includes('operator')?api.request('GET','/api/shift-packages?limit=100',{auth:true}):Promise.resolve({data:{packages:[]}})]);
        if(!active())return;content.replaceChildren();
        if(roles.includes('operator')){
          content.append(el('h2',{text:'Gói được phân công, chưa bắt đầu'}));
          const list=el('ul',{class:'cards'});
          for(const pkg of pending.data.packages){
            const feedback=el('div'),button=el('button',{type:'button',class:'btn primary',text:'Bắt đầu ca',disabled:!pkg.ready});
            button.addEventListener('click',()=>post(`/api/packages/${pkg.id}/shifts/start`,{},button,feedback,data=>{location.hash=`#shift/${data.shift.id}`;}));
            list.append(el('li',{class:'card'},[el('h2',{text:pkg.locality}),el('p',{text:`${pkg.bookingCount} đơn. ${new Date(pkg.startAt).toLocaleString('vi-VN')} đến ${new Date(pkg.endAt).toLocaleString('vi-VN')}`}),el('p',{text:pkg.ready?'Các chủ ruộng đã xác nhận sẵn sàng.':'Chờ chủ ruộng xác nhận sẵn sàng. Không tự xác nhận thay.'}),button,feedback]));
          }
          content.append(pending.data.packages.length?list:el('p',{text:'Chưa có gói được phân công chờ bắt đầu.'}));
        }
        content.append(el('h2',{text:'Ca đã bắt đầu'}));
        const list=el('ul',{class:'cards'});
        for(const shift of existing.data.shifts)list.append(el('li',{class:'card'},[el('h2',{},[el('a',{href:`#shift/${shift.id}`,text:labels[shift.status]??shift.status})]),el('p',{text:new Date(shift.startedAt).toLocaleString('vi-VN')}),shift.areaM2?el('p',{text:`${shift.areaM2} m² đã ghi nhận`}):null]));
        content.append(existing.data.shifts.length?list:el('p',{text:'Chưa có ca đã bắt đầu.'}));
      }else{
        const {data}=await api.request('GET',`/api/shifts/${route.id}`,{auth:true});if(!active())return;
        const shift=data.shift;content.replaceChildren(el('h2',{text:labels[shift.status]??shift.status}));
        if(shift.areaM2)content.append(el('p',{text:`Diện tích đã ghi: ${shift.areaM2} m²`}));
        if(shift.note)content.append(el('p',{text:shift.note}));
        for(const action of shiftActions(shift.status,shift.canOperate&&roles.includes('operator'))){
          if(action==='resume'){
            const feedback=el('div'),button=el('button',{type:'button',class:'btn primary',text:'Tiếp tục ca'});button.addEventListener('click',()=>post(`/api/shifts/${shift.id}/resume`,{},button,feedback));content.append(button,feedback);
          }else content.append(el('section',{},[el('h2',{text:action==='pause'?'Tạm dừng':'Kết thúc công việc'}),formAction(action,shift.id)]));
        }
        content.append(el('h2',{text:'Lịch sử ca'}),el('ol',{class:'timeline'},shift.events.map(event=>el('li',{text:`${events[event.eventType]??event.eventType}: ${new Date(event.createdAt).toLocaleString('vi-VN')}${event.reason?'. '+event.reason:''}${event.areaM2?'. '+event.areaM2+' m²':''}`}))));
      }
    }catch(err){if(active())content.replaceChildren(error(err),el('button',{type:'button',class:'btn secondary',text:'Tải lại',click:load}));}
  }
  await load();
}
