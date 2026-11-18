/* global location */
const detail = /^#(booking|job|shift|dispute)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readActivity(data) {
  if (!data || !Array.isArray(data.items) || !Number.isInteger(data.limit) || data.limit<1 || data.limit>100 || !Number.isInteger(data.offset) || data.offset<0 || data.offset>10000) return null;
  if (!data.items.every(item => item && typeof item.id==='string' && typeof item.type==='string' && typeof item.text==='string' && item.text.length>0 && detail.test(item.href) && typeof item.createdAt==='string' && Number.isFinite(Date.parse(item.createdAt)))) return null;
  return data;
}
export async function renderActivity({main,api,session,signIn}) {
  const hash=location.hash;
  if(!session.token){signIn(hash);return;}
  const doc=globalThis.document;
  const el=(tag,text,props={})=>{const node=doc.createElement(tag);if(text)node.textContent=text;for(const [key,value] of Object.entries(props))node.setAttribute(key,String(value));return node;};
  const heading=el('h1','Hoạt động gần đây',{tabindex:-1});
  const content=el('section','',{'aria-live':'polite',class:'page'});
  main.replaceChildren(heading,el('p','Lịch sử lấy từ sự kiện đã lưu. Đây không phải thông báo đã gửi qua Zalo, email hoặc xác nhận bạn đã đọc.'),content);heading.focus();
  const active=()=>location.hash===hash && content.isConnected;
  let offset=0;
  async function load(next=offset){
    if(!active())return;
    offset=next;content.replaceChildren(el('p','Đang tải hoạt động…',{role:'status'}));
    try{
      const {data}=await api.request('GET',`/api/activity?limit=20&offset=${offset}`,{auth:true});
      if(!active())return;
      const page=readActivity(data);if(!page)throw new Error('BAD_RESPONSE');
      const list=el('ol','',{class:'timeline'});
      for(const item of page.items){const row=el('li');row.append(el('a',item.text,{href:item.href}),el('p',new Date(item.createdAt).toLocaleString('vi-VN')));list.append(row);}
      const controls=el('div','',{class:'actions'});
      for(const [label,nextPage,disabled] of [['Trang trước',Math.max(0,offset-20),offset===0],['Trang sau',offset+20,page.items.length<20||offset+20>10000],['Tải lại',offset,false]]){
        const button=el('button',label,{type:'button',class:'btn secondary'});button.disabled=disabled;button.addEventListener('click',()=>load(nextPage));controls.append(button);
      }
      content.replaceChildren(page.items.length?list:el('p',offset?'Không còn hoạt động ở trang này.':'Chưa có hoạt động liên quan đến tài khoản này.'),controls);
    }catch{
      if(!active())return;
      const retry=el('button','Thử lại',{type:'button',class:'btn secondary'});retry.addEventListener('click',()=>load());
      content.replaceChildren(el('p','Không tải được hoạt động. Dữ liệu cũ không được thay bằng kết quả giả.',{class:'alert error',role:'alert'}),retry);
    }
  }
  await load();
}
