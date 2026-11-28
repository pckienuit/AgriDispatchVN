// Shared-shell browser regression: responsive reachability, navigation, toast and focus.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import console from 'node:console';
import { createApp } from '../../src/app.js';
import { open } from './cdp.mjs';

const customShots = Boolean(process.env.SHELL_SHOTS);
const shotsDir = process.env.SHELL_SHOTS || (await mkdtemp(join(tmpdir(), 'agri-shell-shots-')));
await mkdir(shotsDir, { recursive: true });
const server = createApp({ log: () => {} }).listen(0, '127.0.0.1');
let browser;

try {
  await once(server, 'listening');
  browser = await open({ width: 390, height: 740, mobile: true });
  await browser.go(`http://127.0.0.1:${server.address().port}/v2/`);
  await browser.waitFor("document.querySelector('link[href=\"css/adaptive.css\"]')?.sheet && document.querySelector('input[name=phone]')");
  await browser.ev(`(async()=>{
    const {ui}=await import('/v2/kit/ui.js');
    const app=document.querySelector('#app');
    const body=document.createElement('div');
    body.innerHTML='<h2>Thông tin dài</h2>'+Array.from({length:10},(_,i)=>'<section class="card"><label for="f'+i+'">Trường '+i+'</label><input id="f'+i+'" aria-label="Trường '+i+'" value="Giá trị dài để kiểm tra xuống dòng"></section>').join('');
    const action=document.createElement('div'); action.className='actionbar';
    action.innerHTML='<div class="actionbar__in"><span class="actionbar__info">Thông tin thao tác dài có thể xuống dòng tại màn nhỏ</span><div class="actionbar__actions"><button class="btn btn--primary">Xác nhận thao tác</button></div></div>';
    const nav=['Tổng quan','Lịch làm việc','Đơn dịch vụ','Máy móc','Hồ sơ','Thanh toán','Thông báo'].map((label,i)=>({label,href:'#/demo/'+i,icon:'house',current:i===6}));
    const who=document.createElement('div'); who.className='row'; who.innerHTML='<span>Nguyễn Thị Người Dùng Có Tên Rất Dài</span><span>HTX Dịch vụ Nông nghiệp Đồng Bằng Sông Cửu Long</span>';
    const frame=ui.deskFrame({size:'desk',brand:'AgriDispatch',nav,who,body,action,isRoot:true});
    app.replaceChildren(frame);
    ui.toast('Thông báo trạng thái dài để kiểm tra không che thanh tiêu đề hoặc hành động cuối trang');
    await new Promise(r=>setTimeout(r,100));
    window.__ui=ui;
  })()`);

  for (const width of [320, 390, 1024, 1440]) {
    await browser.viewport(width, 740, width < 761);
    await browser.sleep(300);
    const layout = await browser.ev(`(()=>{
      const w=innerWidth, main=document.querySelector('main'), tab=document.querySelector('.tabbar--narrow'), action=document.querySelector('.actionbar'), who=document.querySelector('.topbar__who'), toast=document.querySelector('.toast'), head=document.querySelector('.topbar');
      const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
      document.scrollingElement.scrollTop=document.scrollingElement.scrollHeight;
      const last=document.querySelector('#f9'), lr=rect(last), ar=rect(action), wr=rect(who);
      return {w,scrollWidth:document.documentElement.scrollWidth,mainWidth:main.getBoundingClientRect().width,action:rect(action),last:lr,tab:tab?getComputedStyle(tab).display:null,tabRect:tab?rect(tab):null,who:wr,whoScroll:who?who.scrollWidth:0,toast:toast?rect(toast):null,head:rect(head),lastReachable:lr.bottom<=ar.top-4};
    })()`);
    assert.equal(layout.scrollWidth <= width, true, `horizontal overflow at ${width}px: ${JSON.stringify(layout)}`);
    if (width <= 760) {
      assert.equal(layout.tab, 'flex', `narrow tabbar not visible at ${width}px`);
      assert.equal(layout.lastReachable, true, `final input covered at ${width}px: ${JSON.stringify(layout)}`);
      assert.equal(layout.whoScroll <= layout.who.width + 1, true, `account label clipped at ${width}px: ${JSON.stringify(layout)}`);
      assert.equal(layout.toast.top >= layout.head.bottom, true, `toast covers header at ${width}px`);
      assert.equal(layout.toast.bottom < layout.action.top, true, `toast overlaps fixed actions at ${width}px`);
    }
    await browser.shot(join(shotsDir, `shot-${width}.png`));
  }

  // Toast close button accessibility and aria-label
  const toastMeta = await browser.ev(`(()=>{
    const btn = document.querySelector('.toast__close');
    return {
      hasAriaLabel: btn ? btn.getAttribute('aria-label') : null,
      rawAriaLabelAttr: btn ? btn.getAttribute('arialabel') : null,
    };
  })()`);
  assert.equal(toastMeta.hasAriaLabel, 'Đóng thông báo', 'toast close button must have aria-label="Đóng thông báo"');
  assert.equal(toastMeta.rawAriaLabelAttr, null, 'toast close button must not have raw arialabel attribute');

  // Mobile toast placement: must not overlap first card at 390px
  await browser.viewport(390, 740, true);
  await browser.sleep(200);
  const toastCardOverlap = await browser.ev(`(()=>{
    document.scrollingElement.scrollTop = 0;
    const toast = document.querySelector('.toast');
    const firstCard = document.querySelector('.card');
    const head = document.querySelector('.topbar');
    const action = document.querySelector('.actionbar');
    const tr = toast.getBoundingClientRect();
    const cr = firstCard.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    const ar = action.getBoundingClientRect();
    return {
      toast: { top: tr.top, bottom: tr.bottom },
      card: { top: cr.top, bottom: cr.bottom },
      head: { bottom: hr.bottom },
      action: { top: ar.top },
      overlapsCard: !(tr.bottom <= cr.top || tr.top >= cr.bottom),
      overlapsHead: tr.top < hr.bottom,
      overlapsAction: tr.bottom > ar.top,
    };
  })()`);
  assert.equal(toastCardOverlap.overlapsCard, false, `toast overlaps first content card at 390px: ${JSON.stringify(toastCardOverlap)}`);
  assert.equal(toastCardOverlap.overlapsHead, false, `toast covers header at 390px: ${JSON.stringify(toastCardOverlap)}`);
  assert.equal(toastCardOverlap.overlapsAction, false, `toast overlaps actionbar at 390px: ${JSON.stringify(toastCardOverlap)}`);
  await browser.shot(join(shotsDir, 'shot-390-toast.png'));

  // td.r stacked label alignment at 390px
  const stackedTableAlign = await browser.ev(`(()=>{
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.id = 'test-stacked-wrap';
    wrap.innerHTML = '<table class="table table--stack"><tbody><tr><td class="r" data-label="Tổng tiền"><span>500.000 đ</span></td></tr></tbody></table>';
    const container = document.querySelector('main .stack') || document.querySelector('#app');
    container.prepend(wrap);
    const td = wrap.querySelector('td.r');
    const beforeAlign = getComputedStyle(td, '::before').textAlign;
    return beforeAlign;
  })()`);
  await browser.shot(join(shotsDir, 'shot-390-table-stack.png'));
  await browser.ev("document.querySelector('#test-stacked-wrap')?.remove()");
  assert.equal(stackedTableAlign, 'left', 'td.r stacked data-label ::before should be text-align: left at 390px');

  // Actionbar growth dynamically updates --bottom-reserve and --toast-bottom
  const reserveDynamic = await browser.ev(`(async()=>{
    const app = document.querySelector('.app');
    const initialReserve = parseInt(getComputedStyle(app).getPropertyValue('--bottom-reserve') || '0', 10);
    const initialToastBottom = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--toast-bottom') || '0', 10);
    const actionIn = document.querySelector('.actionbar__in');
    const extra = document.createElement('div');
    extra.style.height = '64px';
    extra.textContent = 'Extra line';
    actionIn.appendChild(extra);
    await new Promise(r => setTimeout(r, 200));
    const grownReserve = parseInt(getComputedStyle(app).getPropertyValue('--bottom-reserve') || '0', 10);
    const grownToastBottom = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--toast-bottom') || '0', 10);
    actionIn.removeChild(extra);
    return { initialReserve, grownReserve, initialToastBottom, grownToastBottom };
  })()`);
  assert.ok(reserveDynamic.grownReserve > reserveDynamic.initialReserve, `bottom reserve did not grow: ${JSON.stringify(reserveDynamic)}`);
  assert.ok(reserveDynamic.grownToastBottom > reserveDynamic.initialToastBottom, `toast-bottom did not grow: ${JSON.stringify(reserveDynamic)}`);

  // actions.js busy state and error msg focus
  const actionsCheck = await browser.ev(`(async()=>{
    const { apiButton } = await import('/v2/app/actions.js');
    let release;
    const hold = new Promise(r => { release = r; });
    const wrapper = apiButton({
      label: 'Kiểm tra thao tác',
      run: async () => { await hold; throw new Error('Có lỗi xảy ra'); }
    });
    document.body.appendChild(wrapper);
    const btn = wrapper.querySelector('button');
    const msg = wrapper.querySelector('.msg');

    btn.click();
    await new Promise(r => setTimeout(r, 30));
    const busyState = {
      disabled: btn.disabled,
      ariaDisabled: btn.getAttribute('aria-disabled'),
      ariaBusy: btn.getAttribute('aria-busy'),
      activeIsBody: document.activeElement === document.body,
    };

    release();
    await new Promise(r => setTimeout(r, 60));
    const errorState = {
      msgTabIndex: msg.getAttribute('tabindex'),
      msgHidden: msg.hidden,
      activeIsMsg: document.activeElement === msg,
      btnDisabled: btn.disabled,
      btnAriaDisabled: btn.getAttribute('aria-disabled'),
    };
    wrapper.remove();
    return { busyState, errorState };
  })()`);
  assert.equal(actionsCheck.busyState.disabled, false, 'apiButton must not set disabled=true during busy');
  assert.equal(actionsCheck.busyState.ariaDisabled, 'true', 'apiButton must set aria-disabled="true" during busy');
  assert.equal(actionsCheck.errorState.msgTabIndex, '-1', 'error msg must have tabindex="-1"');
  assert.equal(actionsCheck.errorState.activeIsMsg, true, 'error msg must receive focus on error');

  await browser.viewport(390, 740, true);
  await browser.click('.tabbar__more');
  assert.equal(await browser.ev("document.querySelector('.tabbar__more').getAttribute('aria-expanded')"), 'true');
  const activeInSheet = await browser.ev("document.querySelector('.sheet-scrim:not([hidden])').contains(document.activeElement)");
  assert.equal(activeInSheet, true, 'More sheet did not take focus');
  await browser.ev(`(()=>{document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); return true})()`);
  await browser.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await browser.ev("document.querySelector('.tabbar__more').getAttribute('aria-expanded')"), 'false');
  assert.equal(await browser.ev("document.activeElement===document.querySelector('.tabbar__more')"), true, 'Escape did not return focus to More');

  await browser.ev(`(()=>{const trigger=document.querySelector('#f9');trigger.focus();window.__dialog=window.__ui.modal({title:'Xác nhận',body:document.createElement('p')});return true})()`);
  assert.equal(await browser.ev("document.querySelector('.modal').contains(document.activeElement)"), true, 'modal did not take focus');
  await browser.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await browser.ev("document.activeElement.id==='f9'"), true, 'Escape did not restore modal trigger focus');

  // Use real operator tab labels: all five destinations must fit without horizontal swipe or ellipses.
  await browser.ev(`(async()=>{
    window.__ui.dispose();
    const {navFor}=await import('/v2/app/routes.js');
    const tabs=navFor('tho-lai','O-07',new Set(['O-01','O-03','O-06','O-08','C-02']));
    document.querySelector('#app').replaceChildren(window.__ui.mobileFrame({title:'Tiền công',tabs,body:document.createElement('p')}));
    await document.fonts.ready;
  })()`);
  for (const width of [390, 320]) {
    await browser.viewport(width, 740, true);
    const tabs = await browser.ev(`(()=>{
      const bar=document.querySelector('.tabbar__in');
      return {sw:bar.scrollWidth,cw:bar.clientWidth,labels:[...bar.querySelectorAll('a')].map(a=>{
        const label=a.querySelector('.tabbar__label'), rect=a.getBoundingClientRect();
        return {text:label.textContent,clipped:label.scrollWidth>label.clientWidth+1,w:rect.width,h:rect.height};
      })};
    })()`);
    assert.equal(tabs.labels.length, 5);
    assert.deepEqual(tabs.labels.filter((l) => l.clipped).map((l) => l.text), [], `clipped operator labels at ${width}px`);
    assert.ok(tabs.sw <= tabs.cw + 1, `tabs require a horizontal swipe at ${width}px`);
    assert.ok(tabs.labels.every((l) => l.w >= 44 && l.h >= 44), `operator tap targets too small at ${width}px`);
  }

  // htx-member button min-height must be 32px
  const memberBtnMinH = await browser.ev(`(()=>{
    const el = document.createElement('div');
    el.className = 'htx-member';
    el.innerHTML = '<span>Tên</span><button class="btn btn--secondary btn--sm">Gỡ</button>';
    document.body.appendChild(el);
    const btn = el.querySelector('.btn');
    const minH = getComputedStyle(btn).minHeight;
    el.remove();
    return minH;
  })()`);
  assert.equal(memberBtnMinH, '32px', 'htx-member button min-height should be 32px');

  // Same-route rerender restores structural focus, and cross-route navigation does not leak focus
  await browser.ev(`(async()=>{ window.location.hash = '#/chung/C-01'; const { render } = await import('/v2/app/main.js'); await render(false); })()`);
  await browser.waitFor("document.querySelector('input[name=phone]')");
  const focusRestoreCheck = await browser.ev(`(async()=>{
    const { render } = await import('/v2/app/main.js');
    const phoneInput = document.querySelector('input[name=phone]');
    phoneInput.focus();
    const beforeRerender = document.activeElement === phoneInput;

    // Same-route rerender with keepFocus=true
    await render(true);
    const afterSameRoute = document.activeElement === document.querySelector('input[name=phone]');

    // Navigate to another route (cross-route)
    window.location.hash = '#/chung/C-04';
    return { beforeRerender, afterSameRoute };
  })()`);
  assert.equal(focusRestoreCheck.beforeRerender, true, 'phone input was not focused before rerender');
  assert.equal(focusRestoreCheck.afterSameRoute, true, 'focus was not restored on same-route rerender');

  await browser.waitFor("document.querySelector('h1')");
  const crossRouteCheck = await browser.ev(`(()=>{
    const active = document.activeElement;
    return {
      activeTag: active ? active.tagName : null,
      activeName: active ? active.getAttribute('name') : null,
      isMainOrH1: active ? (active.tagName === 'H1' || active.id === 'main') : false,
    };
  })()`);
  assert.equal(crossRouteCheck.activeName, null, 'focus leaked from C-01 phone input across to C-04');

  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.consoleErrors, []);
  console.log('shared-shell responsive/focus regression passed: 320, 390, 1024, 1440px');
} finally {
  try {
    await browser?.close();
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    if (!customShots) await rm(shotsDir, { recursive: true, force: true });
  }
}
