/* SHEIN BI V2 preview client. Runtime data source: cloud BI section API. */
(function clientApp(){const CFG=window.__SHEIN_STORE_CONFIG__||{stores:[],ownerGroups:[]};
const TABS=[['home','总控驾驶舱','home'],['orders','订单中心','order'],['returns','退货退款','return'],['products','商品列表','product'],['inventory','库存管理','stock'],['traffic','流量数据','traffic'],['reviews','商品评价','review'],['marketing','营销中心','mkt'],['ops','自动化运营','ops'],['system','系统健康','sys']];
const SL={homeRankings:'首页销售/排行',homeProfit:'首页利润',rankings:'完整排行',profit:'利润明细',actions:'动作池',linksData:'链接/覆盖',productTrafficDaily:'货号级每日流量',inventoryTrend:'库存趋势',comments:'评价',orders:'订单',afterSales:'售后',financeData:'财务'};
const NEED={home:['homeRankings','afterSales','homeProfit','actions','financeData'],orders:['orders','homeRankings'],returns:['afterSales','orders'],products:['linksData','homeRankings'],inventory:['inventoryTrend','linksData'],traffic:['productTrafficDaily','linksData'],reviews:['comments'],marketing:['linksData','actions','financeData'],ops:['actions','linksData'],system:[]};
const S={tab:'home',q:'',scope:'ALL',start:'',end:'',metric:'sales',core:'idle',err:''},D={},SS={},P={};
const $=id=>document.getElementById(id);
const H=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const N=v=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
const M=v=>N(v).toLocaleString('zh-CN',{maximumFractionDigits:0});
const M2=v=>N(v).toLocaleString('zh-CN',{maximumFractionDigits:2});
const PCT=v=>Number.isFinite(Number(v))?(Number(v)*100).toFixed(1)+'%':'—';
const A=v=>Array.isArray(v)?v:[];
const ISO=v=>String(v||'').slice(0,10);
const stores=A(CFG.stores).filter(s=>s&&s.enabled!==false&&s.storeKey).map(s=>String(s.storeKey).toUpperCase());
const smeta=new Map(A(CFG.stores).map(s=>[String(s.storeKey||'').toUpperCase(),s]));
const owners=A(CFG.ownerGroups).map(g=>({...g,key:String(g.key||g.name||'').toUpperCase(),stores:A(g.stores).map(x=>String(x).toUpperCase())}));
const ownByStore=new Map();owners.forEach(g=>g.stores.forEach(s=>ownByStore.set(s,g)));
function arrp(p){return p.split('.').reduce((o,k)=>o?.[k],D)||[]}

function prod(r){return String(r?.product_display_name||r?.standard_goods_sn||r?.goods_sn||r?.raw_goods_sn||r?.goods_title||'-')}

function pkey(r){return String(r?.standard_goods_sn||r?.goods_sn||r?.raw_goods_sn||prod(r)||'').trim()}

function sk(r){return String(r?.store_key||r?.storeKey||'').trim().toUpperCase()}

function dt(r){return ISO(r?.date||r?.stat_date||r?.created_date||r?.order_created_date||r?.link_date||r?.snapshot_date||r?.comment_date||r?.request_time||r?.order_create_time||r?.order_time||r?.created_at)}

function scopeStores(){const s=String(S.scope||'ALL');if(s==='ALL')return new Set(stores);if(s.startsWith('OWNER:'))return new Set((owners.find(g=>g.key===s.slice(6).toUpperCase())?.stores)||[]);return new Set([s.toUpperCase()])}

function scopeName(){const s=String(S.scope||'ALL');if(s==='ALL')return'全部店铺';if(s.startsWith('OWNER:'))return owners.find(g=>g.key===s.slice(6).toUpperCase())?.name||s;return `${s} · ${(smeta.get(s)?.companyName)||''}`}

function ok(r){const d=dt(r);if(d&&S.start&&d<S.start)return false;if(d&&S.end&&d>S.end)return false;
const st=sk(r);if(st&&!scopeStores().has(st))return false;if(!st&&S.scope!=='ALL')return false;
const q=String(S.q||'').trim().toLowerCase();if(q){const short=/^[a-z0-9-]{1,4}$/i.test(q);
const fields=short?[pkey(r),prod(r),r?.goods_title]:[pkey(r),prod(r),r?.goods_title,r?.skc,r?.sku,r?.bill_no,r?.order_no,r?.return_order_no,r?.aftersales_order_no];
const hay=fields.map(x=>String(x||'').toLowerCase()).join('|');if(!hay.includes(q))return false}return true}

function F(rows){return A(rows).filter(ok)}

function sum(rows,fs){return rows.reduce((a,r)=>a+fs.reduce((x,f)=>x+N(r?.[f]),0),0)}

function firstNum(r,fs){for(const f of fs){if(Object.prototype.hasOwnProperty.call(r||{},f)&&r?.[f]!=null&&r?.[f]!=='')return N(r[f])}return 0}

function sumFirst(rows,fs){return rows.reduce((a,r)=>a+firstNum(r,fs),0)}

function grp(rows,fn){const m=new Map();for(const r of A(rows)){const k=fn(r);if(!k)continue;if(!m.has(k))m.set(k,[]);m.get(k).push(r)}return m}

function uniq(xs){return Array.from(new Set(xs.filter(Boolean)))}

function avg(rows){const rev=sumFirst(rows,['sales_sar','net_revenue_sar']),q=sum(rows,['quantity']);return q?rev/q:0}

function merge(x){if(!x||typeof x!=='object')return;Object.assign(D,x.data&&typeof x.data==='object'?x.data:x);if(x.generatedAt&&!D.__latestSectionGeneratedAt)D.__latestSectionGeneratedAt=x.generatedAt}

function genAt(){return D.__sections?.generatedAt||D.generatedAt||D.__latestSectionGeneratedAt||''}

function surl(n){return (location.protocol==='http:'||location.protocol==='https:')?'/api/bi/section/'+encodeURIComponent(n):'../sections/'+encodeURIComponent(n)+'.json'}async function core(){S.core='loading';render();try{const r=await fetch('../data.json?ts='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error('core HTTP '+r.status);merge(await r.json());S.core='ok';S.err='';dates();render();ensure(S.tab,true)}catch(e){S.core='error';S.err=e?.message||String(e);render()}}async function load(n,silent=false,force=false){if(SS[n]?.status==='ok'&&!force)return true;if(SS[n]?.status==='error'&&!force)return false;if(P[n])return P[n];SS[n]={status:'loading',error:''};if(!silent)render();P[n]=fetch(surl(n),{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('HTTP '+r.status);
const j=await r.json();if(j&&j.ok===false)throw Error(j.error||'section failed');merge(j);SS[n]={status:'ok',error:'',generatedAt:j.generatedAt||''};delete P[n];render();return true}).catch(e=>{SS[n]={status:'error',error:e?.message||String(e)};delete P[n];render();return false});return P[n]}

function ensure(tab=S.tab,silent=false){(NEED[tab]||[]).forEach(n=>load(n,silent))}

function chips(ns){return'<div class="sects">'+(ns||[]).map(n=>{const s=SS[n]?.status||'idle',c=s==='ok'?'ok':s==='loading'?'loading-chip':s==='error'?'bad':'';return`<span class="${c}" title="${H(SS[n]?.error||'')}">${H(SL[n]||n)} · ${s==='ok'?'已就绪':s==='loading'?'加载中':s==='error'?'失败':'待加载'}</span>`}).join('')+'</div>'}

function wait(n,t='正在从云端 section API 加载数据…'){const s=SS[n]||{};if(s.status==='error')return`<div class="error"><b>${H(SL[n]||n)} 加载失败</b><br>${H(s.error)}<p><button class="btn" data-load="${H(n)}">重试</button></p></div>`;load(n,true);return`<div class="loading"><span class="spin"></span><span>${H(t)}</span></div>`}

function dates(){if(S.start&&S.end)return;
const ds=[];[...A(D.rankings?.dailyStoreProducts),...A(D.profit?.dailyStoreProducts),...A(D.afterSales),...A(D.orders),...A(D.productTrafficDaily),...A(D.inventoryTrend)].forEach(r=>{const d=dt(r);if(d)ds.push(d)});ds.sort();S.end=S.end||ds.at(-1)||ISO(new Date().toISOString());if(!S.start){const e=new Date(S.end);e.setDate(e.getDate()-6);S.start=ISO(e.toISOString())}}

function preset(days){const e=S.end||ISO(new Date().toISOString()),d=new Date(e);d.setDate(d.getDate()-Number(days)+1);S.start=ISO(d.toISOString());S.end=e;sync(false);render();ensure(S.tab,true)}

function sales(){return F(D.rankings?.dailyStoreProducts||D.rankings?.dailyProducts||[])}

function psales(){return F(D.rankings?.dailyProducts||D.rankings?.dailyStoreProducts||[])}

function profits(){return F(D.profit?.dailyStoreProducts||[])}

function orders(){return F(D.orders||[])}

function returns(){return F(D.afterSales||[])}

function actions(){return F(D.actions||[])}

function links(){return F([...A(D.storeLinks),...A(D.links)])}

function matrix(){return F(D.matrix||[])}

function traffic(){return F(D.productTrafficDaily||[])}

function invTrend(){return F(D.inventoryTrend||D.inventoryDepletion?.visibleTrend||[])}

function invProducts(){return A(D.inventoryDepletion?.products).filter(r=>{const q=String(S.q||'').trim().toLowerCase();return !q||[pkey(r),prod(r),r.goods_title].join('|').toLowerCase().includes(q)})}

function hprofit(){const rows=A(D.homeProfitSummary?.dailyScopes);if(!rows.length)return[];
const set=scopeStores(),all=S.scope==='ALL',owner=String(S.scope).startsWith('OWNER:');return rows.filter(r=>{const d=ISO(r.date);if(S.start&&d<S.start)return false;if(S.end&&d>S.end)return false;
const sv=String(r.scope_value||'').toUpperCase();if(all)return sv==='';if(owner)return set.has(sv);return sv===String(S.scope).toUpperCase()})}

function profSum(){const hp=hprofit();if(hp.length)return{profit:sumFirst(hp,['profit_after_storage_sar','profit_if_rtv_received_resellable_after_storage_sar','profit_before_storage_sar']),revenue:sumFirst(hp,['net_revenue_sar','known_net_revenue_sar']),src:'homeProfit'};
const r=profits();return{profit:sumFirst(r,['profit_if_rtv_received_resellable_after_storage_sar','profit_if_rtv_received_resellable_sar','profit_after_storage_sar','profit_before_storage_sar']),revenue:sumFirst(r,['net_revenue_sar','known_net_revenue_sar']),src:'profit'}}

function salesSum(){const r=sales();return{net:sumFirst(r,['sales_sar','net_revenue_sar']),gross:sumFirst(r,['gross_sales_sar','gross_revenue_sar']),ord:sum(r,['orders']),gord:sum(r,['gross_orders']),qty:sum(r,['quantity']),avg:avg(r),rows:r}}

function retSum(){const r=returns();return{amt:sumFirst(r,['amount_sar','price_amount_total']),qty:sum(r,['quantity']),orders:uniq(r.map(x=>x.order_no)).length,rows:r}}

function intro(t,c){return`<section class="intro"><div><span class="eyebrow"><i></i>${H(t)}</span><h2>${H(t)}</h2><p>${H(c)}</p></div><div class="badge">${H(S.start||'—')} ~ ${H(S.end||'—')} · ${H(scopeName())}${S.q?' · '+H(S.q):''}</div></section>`}

function head(t,c,e=''){return`<div class="head"><div><h3>${H(t)}</h3><p>${H(c)}</p></div>${e}</div>`}

function table(headers,rows){return`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${H(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map((c,i)=>`<td class="${i>2?'num':''}">${String(c).includes('<span')?c:H(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}

function panel(t,sub,heads,rows){return`<section class="panel"><h4>${H(t)}</h4><p class="sub">${H(sub)}</p>${rows.length?table(heads,rows):'<div class="empty">当前筛选没有明细。</div>'}</section>`}

function trend(rows,field){const m=new Map();for(const r of rows){const d=dt(r);if(d)m.set(d,(m.get(d)||0)+N(r[field]))}return Array.from(m,([date,value])=>({date,value})).sort((a,b)=>a.date.localeCompare(b.date))}

function trendFirst(rows,fields){const m=new Map();for(const r of rows){const d=dt(r);if(d)m.set(d,(m.get(d)||0)+firstNum(r,fields))}return Array.from(m,([date,value])=>({date,value})).sort((a,b)=>a.date.localeCompare(b.date))}

function chart(rows){const top=Math.max(...rows.map(r=>Math.abs(N(r.value))),1);return`<div class="chart">${rows.slice(-60).map(r=>`<div class="vbar" title="${H(r.date+' · '+M2(r.value))}" style="height:${Math.max(2,Math.abs(N(r.value))/top*100)}%"></div>`).join('')}</div>`}

function rank(items,kind=''){if(!items.length)return'<div class="empty">当前筛选没有排行数据。</div>';return`<div class="rank">${items.slice(0,18).map((it,i)=>{const o=kind==='store'?ownByStore.get(it.key):null;return`<div class="rank-row"><span class="muted">${i+1}</span><div><b>${H(it.label||it.key)}</b><small>${H(it.sub||'')}</small></div><div class="num"><b>${M(it.value)}</b><br>${o?`<span class="owner"><i class="dot" style="background:${H(o.color||'#7357ff')}"></i>${H(o.name)}</span>`:`<span class="tiny">${H(it.note||'')}</span>`}</div></div>`}).join('')}</div>`}

function storeRanks(){return Array.from(grp(sales(),r=>sk(r)),([key,rs])=>({key,label:key,value:sum(rs,['sales_sar']),sub:`订单 ${M(sum(rs,['orders']))} · 均价 ${M2(avg(rs))} SAR`})).sort((a,b)=>b.value-a.value)}

function productRanks(){return Array.from(grp(psales(),r=>pkey(r)),([key,rs])=>({key,label:prod(rs[0]),value:sum(rs,['sales_sar']),sub:`销量 ${M(sum(rs,['quantity']))} · 均价 ${M2(avg(rs))} SAR`})).sort((a,b)=>b.value-a.value)}
function kpis(){const s=salesSum(),p=profSum(),r=retSum(),mg=p.revenue?p.profit/p.revenue:null;return[['净成交额',M(s.net)+' SAR',`总成交额 ${M(s.gross)} SAR · 均价 ${M2(s.avg)} SAR`],['净订单',M(s.ord),`总订单 ${M(s.gord)} · 净销量 ${M(s.qty)}`],['净利润',M(p.profit)+' SAR',`${p.src==='homeProfit'?'轻量利润 section':'利润明细'} · 利润率 ${PCT(mg)}`],['售后金额',M(r.amt)+' SAR',`${M(r.orders)} 单 · ${M(r.qty)} 件`]].map(x=>`<div class="stat"><div class="stat-label"><span>${x[0]}</span><span>当前筛选</span></div><div class="stat-value">${x[1]}</div><div class="stat-note">${x[2]}</div></div>`).join('')}

function home(){ensure('home',true);
const s=salesSum();
const met=S.metric==='profit'?{rows:hprofit().map(r=>({date:r.date,profit:N(r.profit_after_storage_sar||r.profit_before_storage_sar)})),f:'profit'}:S.metric==='orders'?{rows:s.rows,f:'orders'}:S.metric==='returns'?{rows:returns(),f:'amount_sar'}:{rows:s.rows,f:'sales_sar'};
const tr=trend(met.rows,met.f);return`<section class="hero"><div class="hero-main"><span class="eyebrow"><i></i>SHEIN BI V2</span><h2 class="hero-title">从经营看板升级为运营工作台。</h2><p class="copy">首页保留全局激励和经营大盘；子页面按 SHEIN 官方后台的真实业务域重组：订单、售后、商品、库存、流量、评价、营销和自动化运营。</p><div class="hero-actions"><button class="btn primary" data-jump="products">商品上架矩阵</button><button class="btn" data-jump="traffic">货号级每日流量</button><button class="btn" data-jump="ops">自动化运营</button></div></div><div class="hero-side"><div class="decision"><b>权限先不挡利润</b><span>普通员工可以看到利润；后续再按负责人匹配操作权限。</span></div><div class="decision"><b>数据按需加载</b><span>首页只拉核心 section，大表进入页面后再拉。</span></div><div class="decision"><b>筛选必须联动</b><span>日期、负责人/店铺、货号搜索贯穿 KPI、趋势、排行和明细。</span></div><div class="decision"><b>写操作先受控</b><span>自动上下架等真实动作保持 dry-run、确认、执行、回读。</span></div></div></section><section class="kpis">${kpis()}</section>${head('趋势','一个日图保留核心走势，切换指标不新增图堆叠。',`<div class="quick"><button data-metric="sales" class="${S.metric==='sales'?'active':''}">销售额</button><button data-metric="orders" class="${S.metric==='orders'?'active':''}">订单</button><button data-metric="profit" class="${S.metric==='profit'?'active':''}">利润</button><button data-metric="returns" class="${S.metric==='returns'?'active':''}">售后</button></div>`)}<section class="panel">${tr.length?chart(tr):'<div class="empty">当前筛选下没有趋势数据；如果 section 正在加载，请稍后或重试。</div>'}</section>${head('排行榜','店铺排行按负责人颜色标注；产品排行显示选定周期成交均价。',chips(NEED.home))}<section class="grid two"><div class="panel"><h4>店铺成交额排行</h4><p class="sub">按当前筛选净成交额排序。</p>${rank(storeRanks(),'store')}</div><div class="panel"><h4>产品净成交额排行</h4><p class="sub">按标准货号归并，展示成交均价。</p>${rank(productRanks(),'product')}</div></section>`}

function ordersPage(){ensure('orders',true);if(!A(D.orders).length&&SS.orders?.status!=='ok')return intro('订单中心','按订单创建时间查看成交、取消、履约和 COD/payment 标记。')+wait('orders');
const rs=orders().slice().sort((a,b)=>String(dt(b)).localeCompare(dt(a))).slice(0,300);return intro('订单中心','以订单创建时间为主口径，后续承接 COD、履约和异常订单钻取。')+`<section class="kpis"><div class="stat"><div class="stat-label">订单数</div><div class="stat-value">${M(uniq(orders().map(r=>r.order_no||r.bill_no)).length)}</div><div class="stat-note">当前筛选订单</div></div><div class="stat"><div class="stat-label">销售额</div><div class="stat-value">${M(sum(orders(),['sales_sar']))} SAR</div><div class="stat-note">订单明细金额</div></div><div class="stat"><div class="stat-label">件数</div><div class="stat-value">${M(sum(orders(),['quantity']))}</div><div class="stat-note">订单商品件数</div></div><div class="stat"><div class="stat-label">COD 标记</div><div class="stat-value">${M(orders().filter(r=>r.is_cod===true||r.is_cod===1||/COD/i.test(String(r.payment_method||r.tags||''))).length)}</div><div class="stat-note">严格分母走云端 payment flag</div></div></section>`+panel('订单明细','默认展示最近 300 行，后续接服务端分页。',['日期','店铺','订单','货号','金额','件数','状态'],rs.map(r=>[dt(r),sk(r),r.order_no||r.bill_no,prod(r),M2(r.sales_sar),M(r.quantity),r.goods_performance_status_desc||r.order_status||'']))}

function returnsPage(){ensure('returns',true);if(!A(D.afterSales).length&&SS.afterSales?.status!=='ok')return intro('退货退款中心','按售后申请时间和订单创建时间双口径拆解售后。')+wait('afterSales');
const rs=returns().slice().sort((a,b)=>String(dt(b)).localeCompare(dt(a))).slice(0,300);
const by=Array.from(grp(returns(),r=>String(r.reason_names||r.reason||'未标注')),([key,x])=>({key,label:key,value:sum(x,['amount_sar','price_amount_total']),sub:`${M(x.length)} 条 · ${M(sum(x,['quantity']))} 件`})).sort((a,b)=>b.value-a.value);return intro('退货退款中心','售后申请时间用于异常发现；订单创建时间用于成熟窗口比例复盘。')+`<section class="kpis"><div class="stat"><div class="stat-label">售后金额</div><div class="stat-value">${M(sum(returns(),['amount_sar','price_amount_total']))} SAR</div><div class="stat-note">当前筛选</div></div><div class="stat"><div class="stat-label">售后单</div><div class="stat-value">${M(returns().length)}</div><div class="stat-note">申请记录</div></div><div class="stat"><div class="stat-label">COD未妥投</div><div class="stat-value">${M(returns().filter(r=>/COD未妥投/.test(String(r.reason_names||''))).length)}</div><div class="stat-note">比例分母走云端订单标记</div></div><div class="stat"><div class="stat-label">涉及货号</div><div class="stat-value">${M(uniq(returns().map(pkey)).length)}</div><div class="stat-note">标准货号</div></div></section><section class="grid two"><div class="panel"><h4>原因排行</h4>${rank(by,'reason')}</div><div>${panel('售后明细','默认展示最近 300 行。',['申请时间','店铺','订单','货号','金额','原因'],rs.map(r=>[r.request_time||dt(r),sk(r),r.order_no,prod(r),M2(r.amount_sar||r.price_amount_total),r.reason_names||r.resolution_plan_name||'']))}</div></section>`}

function pmatrix(){const map=new Map();
const en=(k,n)=>{k=k||n||'-';if(!map.has(k))map.set(k,{key:k,name:n||k,stores:new Map(),tot:{wait:0,on:0,sold:0,off:0}});return map.get(k)};for(const r of matrix()){const p=en(pkey(r),prod(r)),s=sk(r);if(!s)continue;
const c=p.stores.get(s)||{wait:0,on:0,sold:0,off:0};c.wait+=N(r.wait_shelf_count);c.on+=N(r.on_shelf_count);c.sold+=N(r.sold_out_count);c.off+=N(r.out_shelf_count||r.off_shelf_count);p.stores.set(s,c)}for(const r of links()){const p=en(pkey(r),prod(r)),s=sk(r);if(!s)continue;
const c=p.stores.get(s)||{wait:0,on:0,sold:0,off:0},st=String(r.shelf_status_name||r.health_bucket||'').toLowerCase();if(r.is_wait_shelf||/待上架/.test(st))c.wait++;else if(r.is_on_shelf||/已上架|上架/.test(st))c.on++;else if(/售罄/.test(st))c.sold++;else if(/下架|淘汰|退役/.test(st))c.off++;p.stores.set(s,c)}for(const p of map.values())for(const c of p.stores.values()){p.tot.wait+=c.wait;p.tot.on+=c.on;p.tot.sold+=c.sold;p.tot.off+=c.off}return Array.from(map.values()).filter(p=>p.tot.wait+p.tot.on+p.tot.sold+p.tot.off>0).sort((a,b)=>(b.tot.on+b.tot.wait)-(a.tot.on+a.tot.wait)).slice(0,120)}

function productsPage(){ensure('products',true);if(!A(D.matrix).length&&!A(D.storeLinks).length&&SS.linksData?.status!=='ok')return intro('商品列表','标准货号 × 店铺，上架状态矩阵。')+wait('linksData');
const rs=pmatrix(),st=stores.filter(x=>S.scope==='ALL'?true:scopeStores().has(x));
const body=rs.length?`<div class="table-wrap"><div class="status-grid" style="--cols:${st.length}"><div class="cell headcell">标准货号</div>${st.map(s=>`<div class="cell headcell">${H(s)}</div>`).join('')}${rs.map(p=>`<div class="cell product">${H(p.name)}<div class="tiny">待 ${p.tot.wait} · 上 ${p.tot.on} · 售罄 ${p.tot.sold} · 下 ${p.tot.off}</div></div>${st.map(s=>{const c=p.stores.get(s)||{wait:0,on:0,sold:0,off:0};return`<div class="cell"><div class="counts"><span class="wait" title="待上架">${c.wait}</span><span class="on" title="已上架">${c.on}</span><span class="sold" title="已售罄">${c.sold}</span><span class="off" title="已下架">${c.off}</span></div></div>`}).join('')}`).join('')}</div></div>`:'<div class="empty">当前筛选没有商品链接状态。</div>';return intro('商品列表','参考 SHEIN 商品列表：按标准货号归并，横向看每个店待上架、已上架、已售罄、已下架数量。')+head('上架状态矩阵','每格四个数依次为：待上架 / 已上架 / 已售罄 / 已下架。',chips(['linksData']))+`<section class="panel">${body}</section>`}

function inventoryPage(){ensure('inventory',true);
const ps=invProducts().slice().sort((a,b)=>N(a.days_of_supply_with_incoming)-N(b.days_of_supply_with_incoming));
const tr=trendFirst(invTrend(),['platform_display_stock','usable_inventory','inventory_quantity']);return intro('库存管理','分清三套口径：前台展示库存趋势、ET 可售、成本表供给与去化周期。')+`<section class="kpis"><div class="stat"><div class="stat-label">ET可售</div><div class="stat-value">${M(sum(ps,['et_estimated_available_qty']))}</div><div class="stat-note">ET 货代仓可售估算</div></div><div class="stat"><div class="stat-label">成本表在库</div><div class="stat-value">${M(sum(ps,['estimated_on_hand_quantity']))}</div><div class="stat-note">到仓批次 - 已售</div></div><div class="stat"><div class="stat-label">成本表在途</div><div class="stat-value">${M(sum(ps,['incoming_quantity']))}</div><div class="stat-note">已发未到/待确认</div></div><div class="stat"><div class="stat-label">成本表供给</div><div class="stat-value">${M(sum(ps,['estimated_total_supply_quantity']))}</div><div class="stat-note note">成本表供给 = 到仓 + 在途 - 已售；不等于 ET可售 + 在途。</div></div></section>${head('库存趋势','来自前台展示库存快照；进入库存页才按需加载。',chips(['inventoryTrend']))}<section class="panel">${invTrend().length?chart(tr):wait('inventoryTrend','正在加载云端库存趋势 section…')}</section>`+panel('去化周期','按成本表供给和近 7/30 天速度估算。备注保持小字号。',['货号','ET可售','成本表在库','在途','成本表供给','近30天销量','去化周期','说明'],ps.slice(0,200).map(r=>[prod(r),M(r.et_estimated_available_qty),M(r.estimated_on_hand_quantity),M(r.incoming_quantity),M(r.estimated_total_supply_quantity),M(r.gross_sold_30d),M2(r.days_of_supply_with_incoming||r.days_of_supply_on_hand),`<span class="note">${H(r.stock_status||r.risk_level||'')}</span>`]))}

function trafficPage(){ensure('traffic',true);if(!A(D.productTrafficDaily).length&&SS.productTrafficDaily?.status!=='ok')return intro('流量数据','目标粒度：日期 × 店铺 × 标准货号。')+wait('productTrafficDaily','正在加载云端货号级每日流量 section…');
const rs=traffic(),by=Array.from(grp(rs,r=>pkey(r)),([key,x])=>({key,label:prod(x[0]),value:sumFirst(x,['eps_uv','exposure_uv','exposure_cnt']),sub:`访客 ${M(sumFirst(x,['goods_uv','uv','visitor_cnt']))} · 成交 ${M(sumFirst(x,['sale_cnt','pay_order_cnt','quantity']))}`})).sort((a,b)=>b.value-a.value);
const exp=sumFirst(rs,['eps_uv','exposure_uv','exposure_cnt']),uv=sumFirst(rs,['goods_uv','uv','visitor_cnt']),pay=sumFirst(rs,['sale_cnt','pay_order_cnt','quantity']);return intro('流量数据','货号级每日流量必须精确到日期 × 店铺 × 标准货号，并在当前筛选下重算曝光、访客、成交和转化。')+`<section class="kpis"><div class="stat"><div class="stat-label">曝光</div><div class="stat-value">${M(exp)}</div><div class="stat-note">当前筛选汇总</div></div><div class="stat"><div class="stat-label">访客</div><div class="stat-value">${M(uv)}</div><div class="stat-note">点击率 ${exp?PCT(uv/exp):'—'}</div></div><div class="stat"><div class="stat-label">成交件数</div><div class="stat-value">${M(pay)}</div><div class="stat-note">支付率 ${uv?PCT(pay/uv):'—'}</div></div><div class="stat"><div class="stat-label">明细粒度</div><div class="stat-value">${M(rs.length)}</div><div class="stat-note note">每行应对应日期 × 店铺 × 标准货号；大表按需加载，不拖慢首页。</div></div></section>${head('每日曝光趋势','只保留一个图，绝对量趋势和比例指标分开看。',chips(['productTrafficDaily']))}<section class="panel">${chart(trendFirst(rs,['eps_uv','exposure_uv','exposure_cnt']))}</section><section class="grid two"><div class="panel"><h4>货号流量排行</h4>${rank(by,'product')}</div><div>${panel('流量明细','默认展示 300 行。',['日期','店铺','货号','曝光','访客','成交','点击率','支付率'],rs.slice(0,300).map(r=>[dt(r),sk(r),prod(r),M(firstNum(r,['eps_uv','exposure_uv','exposure_cnt'])),M(firstNum(r,['goods_uv','uv','visitor_cnt'])),M(firstNum(r,['sale_cnt','pay_order_cnt','quantity'])),PCT(N(r.click_rate)||(N(r.goods_uv)/Math.max(1,N(r.eps_uv)))),PCT(N(r.pay_rate)||(N(r.sale_cnt)/Math.max(1,N(r.goods_uv))))]))}</div></section>`}
function reviewsPage(){ensure('reviews',true);if(!A(D.comments).length&&SS.comments?.status!=='ok')return intro('商品评价','低星、质量投诉、中文译文。')+wait('comments');
const rs=F(D.comments||[]).slice().sort((a,b)=>String(dt(b)).localeCompare(dt(a))).slice(0,300);return intro('商品评价','按货号和店铺定位差评、质量投诉和说明书/物流问题。')+panel('评价明细','优先展示平台中文译文。',['日期','店铺','货号','星级','中文译文','原文'],rs.map(r=>[dt(r),sk(r),prod(r),r.goods_comment_star_name||r.goods_comment_star,r.goods_comment_content_zh||'',r.goods_comment_content||'']))}

function actionCard(a){return`<div class="action"><div class="tags"><span class="tag ${/高|high/i.test(String(a.priority))?'danger':''}">${H(a.priority||'优先级')}</span><span class="tag">${H(sk(a)||'-')}</span><span class="tag">${H(a.action_domain||a.category||'动作')}</span></div><h4>${H(a.title||prod(a))}</h4><p class="note">${H(a.reason||a.evidence||'')}</p><div class="tiny">${H(prod(a))} · ${H(a.next_step||'')}</div></div>`}

function marketingPage(){ensure('marketing',true);
const rs=links().filter(r=>r.activity_label||r.performance_activity_names||r.performance_activity_tag).slice(0,300);
const as=actions().filter(r=>/marketing|营销|活动|coupon|价格|价/i.test([r.action_domain,r.category,r.title,r.reason].join(' ')));return intro('营销中心','把活动报名、优惠券、限时折扣、价格栈和利润率放到一个复核中心。')+`<section class="grid two"><div class="panel"><h4>当前营销承接</h4><p class="sub">来自链接/表现标签，后续扩展为活动报名矩阵和最终利润率。</p>${rs.length?table(['店铺','货号','SKC','活动标签','活动名称','质量层级'],rs.map(r=>[sk(r),prod(r),r.skc,r.activity_label||r.performance_activity_tag||'',r.performance_activity_names||'',r.quality_grade||r.performance_total_quality_level||''])):'<div class="empty">当前筛选没有营销标签。</div>'}</div><div class="panel"><h4>营销动作</h4><p class="sub">真实报名/改价仍需 dry-run、复核、授权执行、live 回读。</p>${as.length?as.slice(0,24).map(actionCard).join(''):'<div class="empty">当前筛选没有营销动作。</div>'}</div></section>`}

function opsPage(){ensure('ops',true);
const as=actions().slice().sort((a,b)=>N(b.score)-N(a.score));return intro('自动化运营','合并链接管理中台和动作池：一个会话、一个任务、一个动作状态。')+`<section class="grid three"><div class="stat"><div class="stat-label">待处理动作</div><div class="stat-value">${M(as.length)}</div><div class="stat-note">当前筛选</div></div><div class="stat"><div class="stat-label">高优先级</div><div class="stat-value">${M(as.filter(a=>/高|high/i.test(String(a.priority))).length)}</div><div class="stat-note">需要优先复核</div></div><div class="stat"><div class="stat-label">执行边界</div><div class="stat-value">Dry-run</div><div class="stat-note note">真实上下架/改价/报名不静默提交。</div></div></section>${head('统一动作工作台','后续自动运营系统从这里进入；当前第一版先重组信息和状态。',chips(['actions','linksData']))}<section class="grid two"><div class="panel"><h4>动作队列</h4>${as.length?as.slice(0,60).map(actionCard).join(''):'<div class="empty">当前筛选没有动作。</div>'}</div><div class="panel"><h4>动作生命周期</h4><p class="note">1. 建议：由 BI/规则发现机会或风险。<br>2. 预检：读取链接、库存、价格、证据。<br>3. 用户确认：展示影响范围和回滚方式。<br>4. 执行：调用受控接口。<br>5. 回读：确认 SHEIN 后台真实状态并写审计。</p><div class="empty">这里后续承接自然语言任务、素材、执行步骤和审计日志。</div></div></section>`}

function systemPage(){const secs=Object.keys(SL);return intro('系统健康','展示云端运行态、section 加载状态和数据新鲜度边界。')+`<section class="grid three"><div class="stat"><div class="stat-label">Core generatedAt</div><div class="stat-value" style="font-size:18px">${H(genAt()||'—')}</div><div class="stat-note">来自云端运行态 core</div></div><div class="stat"><div class="stat-label">Core 加载</div><div class="stat-value">${H(S.core)}</div><div class="stat-note">${H(S.err||'正常')}</div></div><div class="stat"><div class="stat-label">Section</div><div class="stat-value">${M(secs.filter(s=>SS[s]?.status==='ok').length)}/${secs.length}</div><div class="stat-note">按需加载状态</div></div></section><section class="panel"><h4>Section 状态</h4>${chips(secs)}<p class="foot">数据判断只认云端运行态；仓库快照仅作页面启动兼容。</p></section>`}

function shell(){document.getElementById('nav').innerHTML=TABS.map(t=>`<button class="${S.tab===t[0]?'active':''}" data-tab="${t[0]}"><span>${t[1]}</span><small>${t[2]}</small></button>`).join('');$('scope').innerHTML=`<option value="ALL">全部店铺</option>`+owners.map(g=>`<option value="OWNER:${H(g.key)}">负责人 · ${H(g.name)}</option>`).join('')+stores.map(s=>`<option value="${H(s)}">${H(s)} · ${H(smeta.get(s)?.companyName||'')}</option>`).join('');sync(false);$('crumb').textContent=`${(TABS.find(t=>t[0]===S.tab)||TABS[0])[1]} · ${scopeName()} · ${S.start||'—'} ~ ${S.end||'—'}`}

function sync(read=true){if(read){S.q=$('q')?.value||'';S.scope=$('scope')?.value||'ALL';S.start=$('start')?.value||'';S.end=$('end')?.value||''}if($('q'))$('q').value=S.q;if($('scope'))$('scope').value=S.scope;if($('start'))$('start').value=S.start;if($('end'))$('end').value=S.end}

function render(){shell();if(S.core==='loading'){$('view').innerHTML='<div class="loading"><span class="spin"></span><span>正在连接云端 BI runtime…</span></div>';return}if(S.core==='error'){$('view').innerHTML=`<div class="error"><b>云端 BI runtime 连接失败</b><br>${H(S.err)}<p><button class="btn" id="retryCore">重试</button></p></div>`;$('retryCore')?.addEventListener('click',core);return}const map={home,orders:ordersPage,returns:returnsPage,products:productsPage,inventory:inventoryPage,traffic:trafficPage,reviews:reviewsPage,marketing:marketingPage,ops:opsPage,system:systemPage};$('view').innerHTML=(map[S.tab]||home)()}

document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.tab){S.tab=b.dataset.tab;render();ensure(S.tab,true)}if(b.dataset.jump){S.tab=b.dataset.jump;render();ensure(S.tab,true)}if(b.dataset.metric){S.metric=b.dataset.metric;render()}if(b.dataset.preset)preset(Number(b.dataset.preset));if(b.dataset.load)load(b.dataset.load,false,true);if(b.id==='clearFilters'){S.q='';S.scope='ALL';dates();sync(false);render();ensure(S.tab,true)}});['q','scope','start','end'].forEach(id=>$(id)?.addEventListener(id==='q'?'input':'change',()=>{sync(true);render();ensure(S.tab,true)}));core();})();
