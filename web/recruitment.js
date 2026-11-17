/* global location */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function recruitmentRoute(hash) {
  if (['#jobs','#my-jobs','#offers','#applications'].includes(hash)) return { name:hash.slice(1) };
  const match = /^#job\/([^/]+)$/.exec(hash);
  return match && uuid.test(match[1]) ? {name:'job',id:match[1].toLowerCase()} : null;
}
function instant(value) {
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value??'');
  if(!match)return null;
  const [y,m,d,h,min]=match.slice(1).map(Number),date=new Date(y,m-1,d,h,min);
  if(date.getFullYear()!==y||date.getMonth()!==m-1||date.getDate()!==d||date.getHours()!==h||date.getMinutes()!==min)return null;
  return date.toISOString();
}
export function validateJobForm(data) {
  const errors={};const title=data.title?.trim(),locality=data.locality?.trim();
  const capacity=/^\d+$/.test(data.capacity??'')?Number(data.capacity):NaN;
  const startAt=instant(data.startLocal),endAt=instant(data.endLocal);
  if(!title||[...title].length>120)errors.title='Nhập tên việc, tối đa 120 ký tự.';
  if(!locality||[...locality].length>200)errors.locality='Nhập địa phương, tối đa 200 ký tự.';
  if(!Number.isInteger(capacity)||capacity<1||capacity>100)errors.capacity='Số chỗ từ 1 đến 100 cho bản thử nghiệm.';
  if(!startAt)errors.startLocal='Nhập ngày giờ bắt đầu hợp lệ.';
  if(!endAt||endAt<=startAt)errors.endLocal='Kết thúc phải sau bắt đầu.';
  return {errors,payload:Object.keys(errors).length?null:{title,locality,capacity,startAt,endAt}};
}
export function recruitmentStatus(state) {
  return ({OPEN:'Đang tuyển',CLOSED:'Đã đóng',APPLIED:'Đã ứng tuyển',OFFERED:'Đã gửi đề nghị',ACCEPTED:'Đã nhận đề nghị',DECLINED:'Đã từ chối',WITHDRAWN:'Đã rút'})[state]??state;
}
const messages={CAPACITY_FULL:'Tin đã đủ người nhận. Bạn chưa được nhận vào chỗ này.',DUPLICATE_APPLICATION:'Bạn đã ứng tuyển tin này. Xem mục Đơn ứng tuyển.',JOB_CLOSED:'Tin tuyển đã đóng.',OFFER_ACCEPTED:'Đề nghị đã nhận không thể rút bằng thao tác này.',FORBIDDEN:'Tài khoản không có quyền thực hiện.',NOT_FOUND:'Không tìm thấy dữ liệu hoặc bạn không có quyền xem.',APPLICATION_WITHDRAWN:'Ứng tuyển đã rút.',OFFER_WITHDRAWN:'Đề nghị đã rút.',OFFER_DECLINED:'Đề nghị đã bị từ chối.',RATE_LIMITED:'Thao tác quá nhiều lần. Đợi rồi thử lại.'};

export async function renderRecruitment({main,api,session,announce,route,signIn}) {
  const doc=globalThis.document,hash=location.hash;
  const active=()=>location.hash===hash;
  const el=(tag,props={},children=[])=>{
    const node=doc.createElement(tag);
    for(const [key,value] of Object.entries(props)){if(value===undefined||value===false)continue;if(key==='text')node.textContent=value;else if(key==='class')node.className=value;else if(key==='click')node.addEventListener('click',value);else node.setAttribute(key,value===true?'':String(value));}
    for(const child of children)if(child)node.append(child);return node;
  };
  const link=(text,href)=>el('a',{href,text,class:'btn secondary',...(href===hash?{'aria-current':'page'}:{})});
  const roles=session.user?.roles??[],provider=roles.includes('provider'),operator=roles.includes('operator');
  const heading=el('h1',{tabindex:'-1',text:({jobs:'Tuyển thợ',job:'Chi tiết tin tuyển','my-jobs':'Tin tuyển của tôi',offers:'Đề nghị dành cho tôi',applications:'Đơn ứng tuyển của tôi'})[route.name]});
  const content=el('section',{'aria-live':'polite'});
  const links=[link('Tất cả tin','#jobs')];
  if(provider)links.push(link('Tin của tôi','#my-jobs'));
  if(operator)links.push(link('Đơn ứng tuyển','#applications'),link('Đề nghị','#offers'));
  main.replaceChildren(heading,el('p',{text:'Ứng tuyển chưa phải được tuyển. Chỉ khi thợ tự nhận đề nghị, một chỗ mới được tính đã nhận.'}),el('div',{class:'actions'},links),content);
  heading.focus();
  const error=(err)=>el('div',{class:'alert error',role:'alert',text:messages[err.code]??(err.status===401?'Phiên hết hạn. Đăng nhập lại.':'Không thực hiện được. Kiểm tra kết nối rồi thử lại.')});
  const action=(label,path,body={},after=load)=>{
    const button=el('button',{type:'button',class:'btn secondary',text:label});
    button.addEventListener('click',async()=>{
      if(button.disabled)return;button.disabled=true;
      try{await api.request('POST',path,{auth:true,body});announce('Máy chủ đã ghi nhận thao tác.');if(active())await after();}
      catch(err){if(active())button.parentElement.append(error(err));}
      finally{button.disabled=false;}
    });return button;
  };
  const jobCard=(job)=>el('li',{class:'card'},[
    el('h2',{},[el('a',{href:`#job/${job.id}`,text:job.title})]),el('p',{text:job.locality}),
    el('p',{text:`${recruitmentStatus(job.status)}. ${job.acceptedCount}/${job.capacity} chỗ đã nhận, ${job.applicationCount} ứng tuyển.`}),
    el('p',{text:`${new Date(job.startAt).toLocaleString('vi-VN')} đến ${new Date(job.endAt).toLocaleString('vi-VN')}`}),
  ]);
  function jobForm(){
    const form=el('form',{class:'form',novalidate:true,'aria-label':'Đăng tin tuyển'}),inputs={},feedback=el('div',{'aria-live':'polite'});
    for(const [key,label,type] of [['title','Tên việc','text'],['locality','Địa phương','text'],['capacity','Số chỗ','number'],['startLocal','Bắt đầu theo giờ địa phương','datetime-local'],['endLocal','Kết thúc theo giờ địa phương','datetime-local']]){
      const input=el('input',{id:`job-${key}`,name:key,type,required:true,...(key==='capacity'?{min:1,max:100,step:1}:{})});inputs[key]=input;
      form.append(el('div',{class:'field'},[el('label',{for:`job-${key}`,text:label}),input]));
    }
    const submit=el('button',{type:'submit',class:'btn primary',text:'Đăng tin tuyển'});form.append(feedback,submit);
    form.addEventListener('submit',async(event)=>{
      event.preventDefault();if(submit.disabled)return;
      const {errors,payload}=validateJobForm(Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value])));
      feedback.replaceChildren();for(const node of Object.values(inputs))node.removeAttribute('aria-invalid');
      if(!payload){for(const [key,message] of Object.entries(errors)){inputs[key].setAttribute('aria-invalid','true');feedback.append(el('p',{text:message}));}inputs[Object.keys(errors)[0]].focus();return;}
      submit.disabled=true;
      try{await api.request('POST','/api/jobs',{auth:true,body:payload});announce('Đã đăng tin tuyển.');if(active())await load();}
      catch(err){feedback.replaceChildren(error(err));}finally{submit.disabled=false;}
    });return el('section',{},[el('h2',{text:'Đăng tin tuyển'}),form]);
  }
  async function load(){
    if(!active())return;
    if(route.name!=='jobs'&&route.name!=='job'&&!session.token){signIn(hash);return;}
    if((route.name==='my-jobs'&&!provider)||(['offers','applications'].includes(route.name)&&!operator)){content.replaceChildren(error({code:'FORBIDDEN'}));return;}
    content.replaceChildren(el('p',{role:'status',text:'Đang tải…'}));
    try{
      if(route.name==='jobs'||route.name==='my-jobs'){
        const path=route.name==='jobs'?'/api/jobs':'/api/jobs/mine';
        const {data}=await api.request('GET',`${path}?limit=100`,{auth:route.name==='my-jobs'});if(!active())return;
        content.replaceChildren(data.items.length?el('ul',{class:'cards'},data.items.map(jobCard)):el('p',{text:'Chưa có tin tuyển.'}));
        if(route.name==='my-jobs')content.append(jobForm());
      }else if(route.name==='job'){
        const {data}=await api.request('GET',`/api/jobs/${route.id}`);if(!active())return;
        const job=data.job;heading.textContent=job.title;content.replaceChildren(jobCard(job));
        if(!session.token)content.append(link('Đăng nhập để thao tác','#login'));
        if(operator&&job.status==='OPEN'){
          const note=el('input',{id:'application-note',maxlength:500}),section=el('div',{class:'field'},[el('label',{for:'application-note',text:'Lời nhắn ứng tuyển (không bắt buộc)'}),note]);
          const apply=el('button',{type:'button',class:'btn primary',text:'Ứng tuyển'});
          apply.addEventListener('click',async()=>{if(apply.disabled)return;apply.disabled=true;try{await api.request('POST',`/api/jobs/${job.id}/applications`,{auth:true,body:{note:note.value}});announce('Đã ứng tuyển, chưa phải đã được tuyển.');if(active())location.hash='#applications';}catch(err){section.append(error(err));}finally{apply.disabled=false;}});section.append(apply);content.append(section);
        }
        if(provider){
          let applications;
          try{applications=(await api.request('GET',`/api/jobs/${job.id}/applications?limit=100`,{auth:true})).data.items;}
          catch(err){if(err.status===404)return;throw err;}
          if(!active())return;
          if(job.status==='OPEN')content.append(action('Đóng tin tuyển',`/api/jobs/${job.id}/close`));
          content.append(el('h2',{text:'Ứng tuyển cho tin của bạn'}));
          const list=el('ul',{class:'cards'});
          for(const application of applications){
            const card=el('li',{class:'card'},[el('p',{text:`Ứng tuyển ${application.id}`}),el('p',{text:recruitmentStatus(application.status)}),el('p',{text:application.note??'Không có lời nhắn.'})]);
            if(job.status==='OPEN'&&application.status!=='WITHDRAWN'&&!application.activeOffer)card.append(action('Gửi đề nghị',`/api/applications/${application.id}/offers`));
            if(application.activeOffer)card.append(el('p',{text:recruitmentStatus(application.activeOffer.status)}));list.append(card);
          }
          content.append(applications.length?list:el('p',{text:'Chưa có ứng tuyển.'}));
        }
      }else{
        const path=route.name==='offers'?'/api/offers':'/api/applications/mine';
        const {data}=await api.request('GET',`${path}?limit=100`,{auth:true});if(!active())return;
        const list=el('ul',{class:'cards'});
        for(const item of data.items){
          const card=el('li',{class:'card'},[el('h2',{},[el('a',{href:`#job/${item.jobId}`,text:item.job.title})]),el('p',{text:recruitmentStatus(item.status)})]);
          if(route.name==='offers'&&item.status==='OFFERED')card.append(el('div',{class:'actions'},[action('Nhận đề nghị',`/api/offers/${item.id}/accept`),action('Từ chối',`/api/offers/${item.id}/decline`)]));
          if(route.name==='applications'&&item.status!=='WITHDRAWN')card.append(action('Rút ứng tuyển',`/api/applications/${item.id}/withdraw`));
          list.append(card);
        }
        content.replaceChildren(data.items.length?list:el('p',{text:route.name==='offers'?'Chưa có đề nghị.':'Bạn chưa ứng tuyển tin nào.'}));
      }
    }catch(err){if(active())content.replaceChildren(error(err),el('button',{type:'button',class:'btn secondary',text:'Thử lại',click:load}));}
  }
  await load();
}
