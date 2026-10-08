/* All values come from the local API; nothing on this page is a placeholder number. */
const C = () => state.svc.cfg || {};   // every window / limit shown in the lab comes from the server (service.py config)
let DELTA_SCALE = 5;
const state = {tab: 'service', data: {}, job: null, window: 300,
  svc: {run: 'period', mode: 'drift', day: null, start: null, end: null, cooldownDays: null, cfg: null, pace: 0.05, promotion: 'shadow', startModel: '', notes: null, resultTab: 'summary', shock: {on: false, start: null, days: null, pct: null, wave_pct: null, wave_days: null}, live: null, windowWeeks: null, evalWeeks: null, force: false, timeline: null, timelineKey: null, index: null, resultId: null, result: null}};
const WINDOWS = {300:'5분', 3600:'1시간', 21600:'6시간', 86400:'24시간'};
const ago = ts => { const s = Math.max(0, Date.now()/1000-ts); return s < 60 ? `${Math.round(s)}초 전` : s < 3600 ? `${Math.round(s/60)}분 전` : `${Math.round(s/3600)}시간 전`; };
const $ = id => document.getElementById(id);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v, d=1) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('ko-KR', {maximumFractionDigits:d});
// Prices: USD/lb (~1.3) needs 3 decimals, EUR/100kg (~430) needs 1.
const price = v => num(v, Math.abs(Number(v)) < 10 ? 3 : 1);
const pct = (v, d=2) => v === null || v === undefined ? '—' : `${num(v, d)}%`;
const day = v => v ? String(v).slice(0, 10) : '—';
const badge = (text, color='') => `<span class="badge ${color}">${escape(text)}</span>`;
const empty = (title, detail='') => `<div class="empty"><strong>${escape(title)}</strong>${escape(detail)}</div>`;
const panel = (title, body, right='') => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${right ? `<div class="panel-actions">${right}</div>` : ''}</div>${body}</section>`;
const table = (headers, rows) => `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const definition = (name, value) => `<div class="definition"><span>${escape(name)}</span><strong>${value}</strong></div>`;
const JOB = {queued:['대기','amber'], running:['실행 중','amber'], succeeded:['완료','green'], failed:['실패','red'], cancelled:['취소','']};
const LEVEL = [['0단계 (일반)', 'green'], ['1단계 (감시)', 'amber'], ['2단계 (파인튜닝)', 'red']];

async function api(path, options={}) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail));
  return body;
}
const post = (path, body={}) => api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6000); }

/* Inline SVG line chart. Non-finite values are gaps; `marks` draws dashed verticals at indexes. */
function chart(series, {height=220, labels=[], marks=[], markName='재학습', bands=[]}={}) {
  const all = series.flatMap(s => s.values).filter(Number.isFinite);
  if (!all.length) return empty('표시할 값이 없습니다');
  const width = 760, left = 54, right = 14, top = 12, bottom = 28, n = Math.max(...series.map(s => s.values.length));
  const min = Math.min(...all), max = Math.max(...all), span = max-min || Math.abs(max)*.05 || 1;
  const low = min >= 0 ? Math.max(0, min-span*.1) : min-span*.1, high = max+span*.1;
  const x = i => left+i*(width-left-right)/Math.max(n-1, 1), y = v => top+(high-v)/(high-low)*(height-top-bottom);
  let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(series.map(s=>s.name).join(', '))}">`;
  for (let i = 0; i < 4; i++) { const v = low+(high-low)*i/3; svg += `<line x1="${left}" y1="${y(v)}" x2="${width-right}" y2="${y(v)}" stroke="var(--grid)"/><text x="${left-8}" y="${y(v)+4}" text-anchor="end">${num(v, span < 10 ? 2 : 0)}</text>`; }
  bands.forEach(b => { const x0 = x(b.from), x1 = x(Math.min(b.to, n-1)); svg += `<rect x="${x0}" y="${top}" width="${Math.max(2, x1-x0)}" height="${height-top-bottom}" fill="#f59e0b" opacity=".16"/>`; });
  // Event marks (fine-tune moments) are solid purple verticals so they never read as a threshold line.
  marks.forEach(i => { svg += `<line x1="${x(i)}" y1="${top}" x2="${x(i)}" y2="${height-bottom}" stroke="#4f46e5" stroke-width="2" opacity=".8"/>`; });
  series.forEach(s => {
    const points = s.values.map((v, i) => Number.isFinite(v) ? `${x(i)},${y(v)}` : null).filter(Boolean);
    svg += `<polyline points="${points.join(' ')}" fill="none" stroke="${s.color||'var(--blue)'}" stroke-width="${s.width||2.4}" ${s.dash?'stroke-dasharray="5 5"':''} stroke-linejoin="round"/>`;
    s.values.forEach((v, i) => { if (s.dots && Number.isFinite(v)) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="${s.color||'var(--blue)'}"/>`; });
  });
  if (labels.length) [0, Math.floor((labels.length-1)/2), labels.length-1].forEach((index, i) => { svg += `<text x="${x(index)}" y="${height-6}" text-anchor="${['start','middle','end'][i]}">${escape(labels[index])}</text>`; });
  return svg+'</svg>'+`<div class="legend">${series.map(s=>`<span><i style="background:${s.color||'var(--blue)'}"></i>${escape(s.name)}</span>`).join('')}${marks.length?`<span><i style="background:#4f46e5"></i>${escape(markName)} (세로선)</span>`:''}${bands.length?`<span><i style="background:#f59e0b55"></i>${escape(bands[0].label)}</span>`:''}</div>`;
}

function kpi(label, value, unit, note, color='') {
  return `<div class="kpi"><div class="kpi-label">${escape(label)}</div><div class="kpi-value ${color}">${value}<small>${escape(unit)}</small></div><div class="kpi-note">${note}</div></div>`;
}

// Gate = WAPE ≤ 6 · RMSE/평균가 ≤ 8 · 방향 정확도 ≥ 60 (rules.json). Older records only carry WAPE.
const OPS = {'<=':'≤', '>=':'≥', '<':'<'};
const gateText = g => !g ? '—' : g.checks ? g.checks.map(c => `${c.label} ${pct(c.value, 1)}${OPS[c.op]}${c.limit}${c.passed ? '' : ' ✗'}`).join(' · ') : `WAPE ${pct(g.value)} ≤ ${g.max_percent}%`;
const check = (g, name) => g?.checks?.find(c => c.name === name)?.value;

const holdoutDays = d => (d.system?.rules?.gate?.finetune?.holdout_weeks ?? 0)*7;
const gateHeaders = d => [`WAPE (일일 파인튜닝은 최근 ${holdoutDays(d)}일)`, 'RMSE/평균가', '방향 정확도', '운영 모델 대비'];
// vs_champion: same validation weeks scored by the model that was serving when this one was trained.
const champ = g => { const c = g?.checks?.find(x => x.name === 'vs_champion'); if (!c) return '첫 모델'; if (c.applicable === false) return `${badge('비교 불가', 'amber')} 새 주 ${c.weeks}주`; const strict = c.op === '<'; return `${badge(c.passed ? (strict ? '더 나음' : '같거나 나음') : (strict ? '나아지지 않음' : '더 나쁨'), c.passed ? 'green' : 'red')} ${escape(c.champion)} ${pct(c.champion_value)}`; };
const gateCells = g => [pct(g?.value), pct(check(g, 'rmse_pct')), pct(check(g, 'direction'), 1), champ(g)];
const trainedFrom = base => base ? `파인튜닝 ← ${escape(base)}` : '처음부터';

/* Two numbers for the same thing, coloured by whether the second is better (lower is better for WAPE / RMSE). */
const arrow = (from, to, digits = 2, unit = '', lowerBetter = true) => `<span class="${(lowerBetter ? to < from : to > from) ? 'good-text' : (to === from ? '' : 'bad-text')}">${num(from, digits)}${unit} → <b>${num(to, digits)}${unit}</b></span>`;
const BASIS = {shadow: '섀도 (실제 정답)', prescreen: '사전 검증', forced: '검증 무시 (비교용)'};
const labLabel = m => m.lab_role === 'baseline' ? '서비스 랩 · 기준 모델' : `서비스 랩 · 파인튜닝${m.lab_parent ? ` ← ${m.lab_parent}` : ''}`;
function decisionNumbers(m) {
  const d = m.lab_decision; if (!d) return '';
  return `<br><small class="muted">교체 근거(${BASIS[d.basis] || d.basis} ${d.n}일): WAPE ${num(d.champion.wape, 2)} → ${num(d.challenger.wape, 2)}% · RMSE ${num(d.champion.rmse, 1)} → ${num(d.challenger.rmse, 1)}</small>`;
}
function activeModel(d) { return d.models.models.find(m => m.version === d.models.active); }

function pipeline(d) {
  const active = activeModel(d), latest = active || d.models.models.at(-1), jobs = d.jobs?.jobs || [];
  const period = d.system?.interval_days === 1 ? '일' : '주';
  const running = kind => jobs.some(j => j.kind === kind && ['queued','running'].includes(j.status));
  const openPerf = d.alerts.some(a => a.kind === 'performance' && a.status === 'open');
  const lastRetrain = jobs.find(j => j.kind === 'retraining');
  const stages = [
    ['데이터', '⛁', 'done', `${d.dataset.quality.rows}${period} · ${d.dataset.rows[0].unit}`],
    ['학습', '◎', running('training') ? 'active' : latest ? 'done' : '', latest ? `${latest.epochs_run} epoch` : '미실행'],
    ['게이트', '✓', !latest ? '' : latest.gate?.passed ? 'done' : 'error', latest?.gate ? (latest.gate.checks ? `조건 ${latest.gate.checks.filter(c => c.passed).length}/${latest.gate.checks.length} 통과` : gateText(latest.gate)) : '—'],
    ['배포', '⇪', active ? 'done' : '', active ? `자동 · MLflow @production` : '미배포'],
    ['감시', '◉', !active ? '' : openPerf ? 'error' : 'done', openPerf ? '성능 경보' : active ? 'WAPE·분포 감시' : '—'],
    ['재학습', '↻', running('retraining') ? 'active' : lastRetrain ? (lastRetrain.status === 'succeeded' ? 'done' : 'error') : '', lastRetrain ? JOB[lastRetrain.status][0] : '대기'],
  ];
  return `<div class="pipeline">${stages.map(([name, icon, cls, note]) => `<div class="stage ${cls}"><div class="stage-icon">${icon}</div>${name}<small>${escape(note)}</small></div>`).join('')}</div>`;
}

function alertList(alerts, limit=6) {
  if (!alerts.length) return empty('경보 없음');
  return alerts.slice(0, limit).map(a => `<div class="alert-row">${badge(a.status === 'open' ? (a.severity === 'error' ? '오류' : '경보') : '해제', a.status === 'open' ? (a.severity === 'error' ? 'red' : 'amber') : 'green')}<div><p>${escape(a.message)}</p><small>${escape(a.kind)} · ${escape(day(a.at))}</small></div></div>`).join('');
}

// Course Day3 serving metrics + model error + drift score (the example dashboard's five cards).
function service(d) {
  const s = d.metrics.service, m = d.metrics, rule = d.system?.service || {max_mean_latency_ms:500, min_requests:20};
  const n = s.request_count.value, slow = n >= rule.min_requests && s.latency_mean.value > rule.max_mean_latency_ms;
  const active = activeModel(d), op = m.model.wape, liveN = d.system?.interval_days === 1 ? 28 : 13;
  const live = op.value !== null && op.value !== undefined && op.n >= liveN;
  const error = live ? op.value : active?.gate?.value, ks = m.drift.ks;
  const series = d.series || [], labels = series.map(x => new Date(x.minute*1000).toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit', hour12:false}));
  const kpis = `<div class="kpis five">${
    kpi('요청 수', num(n, 0), '건', `최근 ${WINDOWS[state.window]} 업무 요청 · ${num(s.rps.value, 3)} req/s`)}${
    kpi('평균 응답시간', num(s.latency_mean.value, 0), 'ms', `p95 ${num(s.latency_p95.value, 0)}ms · 경계 ${rule.max_mean_latency_ms}ms`, slow ? 'bad' : '')}${
    kpi('성공률', num(s.success_rate.value, 1), '%', `2xx 응답 비율`)}${
    kpi('모델 오차 (WAPE)', num(error, 2), '%', live ? `최근 정답 확정 ${op.n}건 · 경계 ${num(op.threshold, 2)}%` : `${escape(d.models.active || '—')} ${active?.training_mode === 'finetune_recent' ? (active.interval_days === 1 ? `파인튜닝 판정 ${holdoutDays(d)}일` : `파인튜닝 판정 ${holdoutDays(d)/7}주`) : '검증 구간'} 기준 (운영 정답 확정 전)`, live && op.threshold && op.value > op.threshold ? 'bad' : '')}${
    kpi('드리프트 점수 (KS)', num(ks.value, 2), '', ks.threshold ? `${d.system?.interval_days === 1 ? '일일' : '주간'} 수익률 분포 · 경계 ${num(ks.threshold, 2)}` : '보정 전', ks.status === 'exceeded' ? 'bad' : '')}</div>`;
  const charts = `<div class="grid-two"><div>${chart([
    {name:'분당 평균 응답시간 (ms)', values:series.map(x => x.latency_mean ?? NaN), dots:true, width:1.6},
    {name:`경계 ${rule.max_mean_latency_ms}ms`, values:series.map(() => rule.max_mean_latency_ms), color:'var(--red)', dash:true, width:1.2}], {height:150, labels})}</div><div>${chart([
    {name:'분당 요청 수', values:series.map(x => x.requests)}], {height:150, labels})}</div></div>`;
  const toggle = `<div class="segmented">${Object.entries(WINDOWS).map(([w, label]) => `<button data-window="${w}" class="${Number(w) === state.window ? 'selected' : ''}">${label}</button>`).join('')}</div>`;
  return panel(`운영 지표 요약 · 최근 ${WINDOWS[state.window]}`, `${kpis}${charts}`, toggle);
}

// Retraining history like the course example: every registered version, newest first, with its stage.
function history(d, limit = 10) {
  const active = d.models.active, deployed = new Set(d.models.deployments.map(x => x.version));
  const models = [...d.models.models].reverse().slice(0, limit);
  if (!models.length) return empty('학습된 모델 없음');
  const mode = m => m.training_mode === 'finetune_recent' ? '<span class="chip">fine-tune</span>' : '<span class="chip">scratch</span>';
  const stage = m => m.version === active ? '<span class="stage-dot green">Production</span>' : !m.gate?.passed ? '<span class="stage-dot red">Rejected</span>'
    : deployed.has(m.version) ? '<span class="stage-dot">Archived</span>' : '<span class="stage-dot amber">Staging</span>';
  return table(['버전', '등록 시각', '모드', '오차 (WAPE)', '스테이지', ''], models.map(m => [
    `<b>${escape(m.version)}</b>`, escape(new Date(m.at).toLocaleString('ko-KR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'})),
    m.from_lab ? `<span class="chip">서비스 랩</span>` : mode(m),
    `${pct(m.gate?.value)} <small class="muted">${m.training_mode === 'finetune_recent' ? (m.interval_days === 1 ? `최근 ${holdoutDays(d)}일` : `최근 ${holdoutDays(d)/7}주`) : '검증'}</small>`, stage(m),
    m.version !== active && m.gate?.passed ? `<button data-select="${escape(m.version)}" class="secondary">운영 선택</button>` : '']));
}

function dashboard(d) {
  const active = activeModel(d), m = d.metrics, last = d.predictions.at(-1), rows = d.dataset.rows.slice(-180), unit = rows[0].unit;
  const prices = rows.map(r => r.midpoint), forecast = last && last.version === d.models.active ? last.prediction : null;
  const priceChart = chart([
    {name:`일일 버터 가격 (${unit})`, values:[...prices, NaN]},
    {name:'4주 뒤 예측', values:[...prices.map((_, i) => i === prices.length-1 ? prices.at(-1) : NaN), forecast ?? NaN], color:'var(--amber)', dash:true, dots:true},
  ], {labels:[...rows.map(r => r.date), forecast ? day(last.target_date) : '']});
  const right = `${panel('운영 모델', active ? `<div class="model-identity"><div class="model-icon">◆</div><div><strong>${escape(active.version)}</strong>${badge('production','blue')} ${d.health.model_loaded ? badge('로딩됨','green') : badge(`${d.health.loading_mode} · 미로딩`,'amber')}</div></div>${definition('게이트', active.gate?.passed ? badge('통과 · 자동 배포', 'green') : badge('미달', 'red'))}${definition('학습 방식', trainedFrom(active.warm_start_from))}${definition('학습 데이터 끝', escape(day(active.trained_through || active.validation_end)))}` : empty('운영 모델 없음', '모델 탭에서 학습하면 게이트 통과 시 자동 배포됩니다.'))}${panel('최근 경보', alertList(d.alerts))}`;
  const mine = d.predictions.filter(p => p.version === d.models.active).length;
  const kpis = `<div class="kpis three">${
    kpi('4주 뒤 예측가', `<span class="${state.flash ? 'flash' : ''}">${price(forecast)}</span>`, unit, forecast ? `목표일 ${escape(day(last.target_date))}` : '예측 실행 전')}${
    kpi('현재가', price(prices.at(-1)), unit, `${escape(rows.at(-1).date)} 관측`)}${
    kpi('예측 횟수', num(d.predictions.length, 0), '회', `운영 모델 ${escape(d.models.active || '—')}로 ${mine}회 · 최근 100건 기준`)}</div>`;
  // Predict first: the button, the numbers it changes and the chart sit together at the top; monitoring comes after.
  return `<div class="grid-main"><div>${panel('예측', `${kpis}${forecast ? `<div class="forecast-line ${state.flash ? 'flash' : ''}">${escape(day(last.target_date))} 예측 금액 : <b>${price(forecast)}</b> ${escape(unit)}</div>` : ''}${priceChart}`, `<button data-action="predict" ${active ? '' : 'disabled'}>예측 실행</button>`)}</div><div>${right}</div></div>
    ${service(d)}
    ${panel('AIOps 파이프라인', pipeline(d), (() => { const j = (d.jobs?.jobs || []).find(x => x.ended_ts || x.started_ts); return j ? badge(`마지막 작업 ${ago(j.ended_ts || j.started_ts)} · ${JOB[j.status]?.[0] || j.status}`) : ''; })())}
    ${panel('재학습 이력', `<p class="note">MLflow Model Registry(ButterCast_Predictor)에 등록된 버전을 그대로 보여줍니다.</p>${history(d)}`, `<a href="#model">전체 보기</a>`)}`;
}

function model(d) {
  const models = [...d.models.models].reverse(), latest = models[0], active = d.models.active;
  const deployed = new Set(d.models.deployments.map(x => x.version));
  const candidates = models.length ? table(['모델', '학습 방식', ...gateHeaders(d), '게이트', ''], models.map(m => [
    `${escape(m.version)} ${m.version === active ? badge('운영','blue') : ''}`,
    m.from_lab ? `${labLabel(m)}${decisionNumbers(m)}` : trainedFrom(m.warm_start_from),
    ...gateCells(m.gate),
    m.gate ? badge(m.gate.passed ? '통과 · 자동 배포' : '탈락', m.gate.passed ? 'green' : 'red') : badge('구버전'),
    m.version !== active && m.gate?.passed ? `<button data-select="${escape(m.version)}" class="secondary">${deployed.has(m.version) ? '다시 운영' : '운영 선택'}</button>` : ''])) : empty('학습된 모델 없음');
  const preds = d.predictions.length ? table(['발행', '목표일', '모델', '예측가'], d.predictions.slice(-8).reverse().map(p => [escape(day(p.issued_at)), escape(p.target_date), escape(p.version), `<b>${price(p.prediction)}</b>`])) : empty('예측 기록 없음');
  return `${panel('모델 (LSTM)', `<p class="note">게이트: 검증 WAPE ≤ 6% · RMSE/평균가 ≤ 8% · 방향 정확도 ≥ 60%, 그리고 같은 검증 구간에서 운영 모델보다 나쁘지 않아야 자동 배포. 실제 관측으로 학습한 모델만 운영 배포됩니다.</p>${candidates}`, `<button data-action="train" ${state.job ? 'disabled' : ''}>학습 실행</button>`)}
    ${panel('예측 기록', preds, `<button data-action="predict" ${active ? '' : 'disabled'}>예측 실행</button>`)}`;
}

const LOG_STYLE = {INFO: ['', '정보'], OK: ['green', '성공'], 'GATE PASSED': ['green', '게이트 통과'], 'GATE FAILED': ['red', '게이트 탈락'], WARN: ['amber', '경고'], FAIL: ['red', '실패'], ERROR: ['red', '오류'], ROLLBACK: ['red', '롤백']};
const LOG_FILTERS = {all: ['전체', () => true], issue: ['경고·실패', l => ['WARN', 'FAIL', 'ERROR', 'ROLLBACK', 'GATE FAILED'].includes(l.level)], tune: ['파인튜닝·모델', l => /파인튜닝|tuned_|retrain|promot|select|rollback|baseline|service period|드리프트|drift/i.test(l.text)]};
function parseLog(line) {
  const m = line.match(/^(\S+) \[([^\]]+)\] (.*)$/); if (!m) return {at: null, level: 'INFO', text: line};
  return {at: new Date(m[1]), level: m[2], text: m[3]};
}
function logView(lines) {
  if (!lines?.length) return empty('로그 없음');
  const filter = LOG_FILTERS[state.logFilter] || LOG_FILTERS.all, parsed = lines.map(parseLog).filter(filter[1]);
  const tabs = `<div class="segmented">${Object.entries(LOG_FILTERS).map(([k, [label]]) => `<button data-log-filter="${k}" class="${k === (state.logFilter || 'all') ? 'selected' : ''}">${label}</button>`).join('')}</div>`;
  const rows = parsed.slice(-300).reverse().map(l => { const [color, label] = LOG_STYLE[l.level] || ['', l.level];
    const when = l.at && !isNaN(l.at) ? `${String(l.at.getMonth()+1).padStart(2, '0')}-${String(l.at.getDate()).padStart(2, '0')} ${l.at.toLocaleTimeString('ko-KR', {hour12: false})}` : '';
    return `<div class="log-line ${color}"><time>${when}</time><b>${escape(label)}</b><span>${escape(l.text)}</span></div>`; }).join('');
  return `<div class="toolbar" style="margin:0 0 12px">${tabs}<span class="muted">${parsed.length}건 · 최신순 · 내 컴퓨터 시간</span></div><div class="log">${rows || '<div class="empty">해당하는 로그 없음</div>'}</div>`;
}

function ops(d) {
  const jobs = d.jobs.jobs;
  return `<div class="grid-main"><div>${panel('aiops.log', logView(d.logs))}</div><div>
    ${panel('작업', jobs.length ? table(['작업', '종류', '상태', '소요'], jobs.slice(0, 10).map(j => [escape(j.id), escape(j.kind), badge(...(JOB[j.status] || [j.status])), j.ended_ts && j.started_ts ? `${num(j.ended_ts-j.started_ts, 1)}초` : '—'])) : empty('작업 없음'))}
  </div></div>`;
}

/* ---------- 서비스 랩: 시점 선택 → 자동 판정 → 파인튜닝 → 기존 모델과 비교 ---------- */
const CAUSE = {trend_up: '상승 추세 (수준 이동)', trend_down: '하락 추세 (수준 이동)', vol_up: '변동성 확대', vol_down: '변동성 축소', trend_vol: '추세 + 변동성', shape: '분포 모양 변화'};
const causeBadge = c => c ? badge(CAUSE[c.kind] || c.kind, 'blue') : '';
const causeNote = c => c ? `평균 이동 ${num(c.mean_shift, 2)}σ (경계 ${num(c.limits.mean_shift, 2)}) · 변동폭 ${num(c.vol_ratio, 2)}배 (경계 ${num(Math.exp(c.limits.log_vol), 2)}배 / ${num(1/Math.exp(c.limits.log_vol), 2)}배)` : '';
const PROMOTION = {gate: '사전 검증만', shadow: '사전 검증 + 섀도 검증', always: '항상 교체 (비교용)'};
const COLOR = {actual: '#111827', base: '#94a3b8', tuned: '#16a34a'};
const VERDICT = {
  healthy: ['기존 모델이 정상이라 파인튜닝하지 않았습니다', 'neutral'],
  better: ['파인튜닝 모델이 확실히 더 정확합니다', 'good'],
  worse: ['파인튜닝 모델이 오히려 더 나빠졌습니다', 'bad'],
  inconclusive: ['두 모델의 차이가 통계적으로 구분되지 않습니다', 'neutral'],
};

async function loadService() {
  const s = state.svc, status = state.data.svcStatus;
  if (status?.config) { s.cfg = status.config; if (s.windowWeeks === null) { s.windowWeeks = s.cfg.default_window_weeks; s.evalWeeks = s.cfg.default_eval_weeks; s.cooldownDays = s.cfg.default_cooldown_days; } }
  if (status?.ready && s.timelineKey !== status.baseline.name) {
    s.timeline = await api('/service/timeline'); s.timelineKey = status.baseline.name;
    s.index = new Map(s.timeline.dates.map((d, i) => [d, i]));
    if (!s.day || !s.index.has(s.day)) s.day = (s.timeline.episodes.find(e => e.base_failing) || s.timeline.episodes[0])?.t || s.timeline.max_date;
  }
  if (s.timeline && !s.start) setRange('drift');
  if (s.resultId && s.result?.id !== s.resultId) { s.result = await api(`/service/replays/${s.resultId}`); s.notes = null; }
  if (s.result?.kind === 'period' && s.notes === null) s.notes = await api(`/service/notifications?job_id=${s.result.id}`);
  else if (!s.resultId && state.data.svcReplays?.length && !s.result) { s.resultId = state.data.svcReplays[0].id; s.result = await api(`/service/replays/${s.resultId}`); }
}

function clampDay(day) { const tl = state.svc.timeline; return day < tl.min_date ? tl.min_date : day > tl.max_date ? tl.max_date : day; }

/* Three stacked panels on one date axis: price, the baseline's error, and input drift. Click anywhere to pick T. */
/* The made-up section: same arithmetic as the server (service.py inject), used only to preview it on the timeline. */
function shockFactor(sh, k) {
  const drift = Math.log(1+sh.pct/100)/sh.days, amp = Math.log(1+(sh.wave_pct || 0)/100), period = sh.wave_days || 56, whole = Math.floor(sh.days/period)*period;
  return Math.exp(drift*Math.min(k, sh.days) + amp*Math.sin(2*Math.PI*Math.min(k, whole)/period));
}
function shockPreview(tl, sh) {
  const i0 = state.svc.index.get(sh.start) ?? tl.dates.findIndex(d => d >= sh.start);
  return tl.price.map((p, i) => i < i0 ? p : p*shockFactor(sh, i-i0+1));
}
function shockEnd(tl, sh) { const i0 = tl.dates.findIndex(d => d >= sh.start); return tl.dates[Math.min(tl.dates.length-1, i0+sh.days)]; }
function shockBand(dates, sh, endDate) { const a = dates.findIndex(d => d >= sh.start), b = dates.findIndex(d => d > endDate); return a < 0 ? [] : [{from: a, to: b < 0 ? dates.length-1 : b, label: '가상 충격 구간 (실제 데이터 아님)'}]; }
function setShockRange() {
  const s = state.svc, tl = s.timeline, sh = s.shock, within = d => d < tl.min_date ? tl.min_date : d > tl.max_period_end ? tl.max_period_end : d;
  s.start = within(shiftDay(sh.start, -C().ks_reference_days/4)); s.end = within(shockEnd(tl, sh));
  if (s.end <= s.start) s.end = within(shiftDay(s.start, C().ks_reference_days));
}

function timelineChart(tl, day, range = null) {
  const s = state.svc, W = 900, L = 56, R = 14, H = 350, n = tl.dates.length, X = i => L+i*(W-L-R)/(n-1);
  const iMin = s.index.get(tl.min_date), iMax = s.index.get(tl.max_date), iCut = s.index.get(tl.cutoff), iDay = s.index.get(day);
  const finite = v => v !== null && v !== undefined && Number.isFinite(v);
  const panels = [
    {title: `가격 (${tl.unit})${s.run === 'period' && s.shock.on ? ' · 주황 = 가상 충격을 넣은 가격' : ''}`, top: 10, h: 100, values: tl.price, lo: Math.min(...tl.price, ...(s.run === 'period' && s.shock.on ? shockPreview(tl, s.shock) : []))*.95, hi: Math.max(...tl.price, ...(s.run === 'period' && s.shock.on ? shockPreview(tl, s.shock) : []))*1.03, digits: 0, overlay: s.run === 'period' && s.shock.on ? shockPreview(tl, s.shock) : null},
    {title: `기존 모델 오차 · 최근 ${C().window_days}일 WAPE (%)`, top: 134, h: 86, values: tl.wape, lo: 0, hi: Math.max(tl.wape_tune_limit*1.5, ...tl.wape.filter(finite)), limits: [[tl.wape_limit, '#f59e0b'], [tl.wape_tune_limit, 'var(--red)']], digits: 0},
    {title: `입력 분포 변화 · 기준 모델 학습 윈도우 대비 최근 ${C().ks_current_days}일 KS`, top: 244, h: 76, values: tl.ks, lo: 0, hi: 1, limits: [[tl.ks_limit, 'var(--red)']], digits: 1},
  ];
  let svg = `<svg class="timeline" data-n="${n}" viewBox="0 0 ${W} ${H}" role="img" aria-label="가격, 기존 모델 오차, 입력 분포 변화 타임라인. 클릭하면 시점이 선택됩니다">`;
  svg += `<rect x="${L}" y="4" width="${X(iCut)-L}" height="${H-30}" fill="#eceff3" opacity=".6"/><rect x="${X(iMax)}" y="4" width="${W-R-X(iMax)}" height="${H-30}" fill="#eceff3" opacity=".6"/>`;
  tl.episodes.forEach(e => { const a = X(s.index.get(e.start)), b = X(s.index.get(e.end)); svg += `<rect x="${a}" y="4" width="${Math.max(3, b-a)}" height="${H-30}" fill="#f5b942" opacity=".38"/>`; });
  panels.forEach(p => {
    const y = v => p.top+(p.hi-v)/(p.hi-p.lo)*p.h, run = (test) => {
      const runs = []; let cur = null;
      p.values.forEach((v, i) => { if (finite(v) && test(v)) { (cur ||= []).push(`${X(i).toFixed(1)},${y(v).toFixed(1)}`); } else if (cur) { runs.push(cur); cur = null; } });
      if (cur) runs.push(cur); return runs;
    };
    svg += `<text x="${L+6}" y="${p.top+10}" class="tl-title">${escape(p.title)}</text>`;
    [p.lo, p.hi].forEach(v => { svg += `<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${num(v, p.digits || (p.hi-p.lo < 10 ? 1 : 0))}</text>`; });
    run(() => true).forEach(r => { svg += `<polyline points="${r.join(' ')}" fill="none" stroke="#2563eb" stroke-width="1.3"/>`; });
    if (p.overlay) svg += `<polyline points="${p.overlay.map((v, i) => `${X(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2"/>`;
    (p.limits || []).filter(([v]) => v !== null && v !== undefined).forEach(([limit, color]) => {
      svg += `<line x1="${L}" y1="${y(limit)}" x2="${W-R}" y2="${y(limit)}" stroke="${color}" stroke-dasharray="5 4" stroke-width="1.2"/>`;
      run(v => v > limit).forEach(r => { svg += `<polyline points="${r.join(' ')}" fill="none" stroke="${color}" stroke-width="2.2"/>`; });
    });
  });
  let lastYear = '';
  tl.dates.forEach((d, i) => { if (d.slice(0, 4) !== lastYear && d.slice(5) <= '01-07') { lastYear = d.slice(0, 4); svg += `<text x="${X(i)}" y="${H-8}" text-anchor="middle">${lastYear}</text>`; } });
  svg += `<line x1="${X(iCut)}" y1="4" x2="${X(iCut)}" y2="${H-26}" stroke="#8a94a6" stroke-dasharray="2 3"/><text x="${X(iCut)+4}" y="${H-12}" class="tl-title">기준 모델 학습 끝 ${escape(tl.cutoff)}</text>`;
  if (range) { const a = X(s.index.get(range[0])), b = X(s.index.get(range[1])); svg += `<rect x="${a}" y="2" width="${Math.max(2, b-a)}" height="${H-24}" fill="#4f46e5" opacity=".16"/><line x1="${a}" y1="2" x2="${a}" y2="${H-26}" stroke="#4f46e5" stroke-width="2.4"/><line x1="${b}" y1="2" x2="${b}" y2="${H-26}" stroke="#4f46e5" stroke-width="2.4"/>`; }
  else svg += `<line x1="${X(iDay)}" y1="2" x2="${X(iDay)}" y2="${H-26}" stroke="#4f46e5" stroke-width="2.4"/><circle cx="${X(iDay)}" cy="${panels[0].top+(panels[0].hi-tl.price[iDay])/(panels[0].hi-panels[0].lo)*panels[0].h}" r="4.5" fill="#4f46e5"/>`;
  return svg+`</svg><div class="legend"><span><i style="background:#eceff3"></i>선택 불가 (기준 모델 학습 구간 · 비교 구간 부족)</span><span><i style="background:#f5b942"></i>입력 데이터 드리프트 확인 구간</span><span><i style="background:#f59e0b"></i>1단계 경고 (주황 점선 초과)</span><span><i style="background:var(--red)"></i>2단계 파인튜닝 (빨간 점선 초과)</span><span><i style="background:#4f46e5"></i>${range ? '선택한 운영 구간' : '선택한 시점 T'}</span></div>`;
}

function pickerSummary(tl, day) {
  const i = state.svc.index.get(day), w = tl.wape[i], k = tl.ks[i];
  const prevK = tl.ks[i-1], drifting = k !== null && tl.ks_limit !== null && k > tl.ks_limit, confirmed = drifting && prevK !== null && prevK > tl.ks_limit;
  const level = confirmed || (w !== null && w > tl.wape_tune_limit) ? 2 : (w !== null && w > tl.wape_limit) || drifting ? 1 : 0, ref = tl.reference_window;
  const cell = (label, value, note) => `<div class="pick-cell"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
  return `<div class="pick-summary">${
    cell('선택한 시점 T', escape(day), `가격 ${num(tl.price[i], 1)} ${escape(tl.unit)}`)}${
    cell(`기존 모델 오차 (${C().window_days}일 WAPE)`, `${pct(w)} ${badge(['정상', '1단계 경고', '2단계'][level], ['green', 'amber', 'red'][level])}`, `경고 ${pct(tl.wape_limit)} · 파인튜닝 ${pct(tl.wape_tune_limit)}`)}${
    cell('학습 윈도우 대비 입력 변화 (KS)', `${num(k, 2)} ${badge(confirmed ? '드리프트 확정' : drifting ? '드리프트 의심' : '안정', confirmed ? 'red' : drifting ? 'amber' : 'green')}`, `기준 윈도우 ${escape(ref.start)} ~ ${escape(ref.end)} vs 최근 ${C().ks_current_days}일 · 경계 ${num(tl.ks_limit, 2)}`)}${
    cell('자동 판정', level === 2 ? badge('파인튜닝 실행', 'red') : level === 1 ? badge('경고만', 'amber') : badge('정상', 'green'), level === 2 ? (confirmed ? '최근 데이터가 학습 윈도우와 달라져 직전 구간으로 학습합니다' : '오차가 2단계 기준을 넘어 직전 구간으로 학습합니다') : level === 1 ? '1단계는 알리기만 하고 학습하지 않습니다' : '정상이면 비교만 하고 학습하지 않습니다')}</div>`;
}

function episodeCards(tl, day) {
  if (!tl.episodes.length) return empty('확인된 드리프트 구간 없음');
  return `<div class="episodes">${tl.episodes.map(e => `<button class="episode ${e.t === day ? 'selected' : ''}" data-action="svc-episode" data-day="${escape(e.t)}">
    <b>${escape(e.start)} ~ ${escape(e.end)}</b>
    <span>학습 윈도우와 ${e.days}일 동안 달랐음 · 경계의 ${num(e.strength, 2)}배 (KS ${num(e.peak_ks, 2)})</span>
    <span>30일 가격 ${e.price_change_pct > 0 ? '+' : ''}${num(e.price_change_pct, 1)}%</span>${e.cause ? `<span>${causeBadge(e.cause)}</span>` : ''}
    <span>대표 시점 <b>${escape(e.t)}</b> · 기존 모델 WAPE ${pct(e.wape_at_t, 1)}</span>
    ${badge(e.base_stage === 2 ? `2단계 → 파인튜닝 (${({drift: '드리프트', wape: '오차', both: '드리프트+오차'})[e.base_trigger]})` : ['기존 모델 정상', '1단계 경고만'][e.base_stage], ['green', 'amber', 'red'][e.base_stage])}</button>`).join('')}</div>`;
}

function periodSummary(tl, start, end) {
  const i = state.svc.index.get(start), j = state.svc.index.get(end), span = tl.wape.slice(i, j+1);
  const over = span.filter(v => v !== null && v > tl.wape_limit).length, tunable = span.filter(v => v !== null && v > tl.wape_tune_limit).length, episodes = tl.episodes.filter(e => e.end >= start && e.start <= end);
  const cell = (label, value, note) => `<div class="pick-cell"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`;
  return `<div class="pick-summary">${
    cell('운영 구간', `${j-i+1}일`, `${escape(start)} ~ ${escape(end)}`)}${
    cell('포함된 드리프트 구간', `${episodes.length}개`, episodes.length ? episodes.map(e => escape(e.start.slice(0, 7))).join(' · ') : '드리프트 없는 구간')}${
    cell('기존 모델 경고 · 파인튜닝 기준', `${over}일 · ${tunable}일`, `1단계 ${pct(tl.wape_limit)} 초과 · 2단계 ${pct(tl.wape_tune_limit)} 초과인 날`)}${
    cell('자동 동작', badge('1단계 경고 → 2단계 파인튜닝', tunable ? 'red' : over ? 'amber' : 'green'), '경고는 알리기만, 2단계에서 학습하고 게이트를 통과하면 교체')}</div>`;
}

function picker() {
  const s = state.svc, tl = s.timeline;
  return s.run === 'period' ? `${periodSummary(tl, s.start, s.end)}${timelineChart(tl, s.start, [s.start, s.end])}` : `${pickerSummary(tl, s.day)}${timelineChart(tl, s.day)}`;
}

function runControls() {
  const s = state.svc, tl = s.timeline, busy = !!state.job;
  const options = (values, current, label) => values.map(v => `<option value="${v}" ${v === current ? 'selected' : ''}>${label(v)}</option>`).join('');
  const lo = s.index.get(tl.min_date), hi = s.index.get(tl.max_date), run = busy ? '실행 중…' : null;
  if (s.run === 'period') return `<div class="controls">
    <label>시작일<input type="date" id="svc-start" value="${escape(s.start)}" min="${escape(tl.min_date)}" max="${escape(tl.max_period_end)}"></label>
    <label>종료일<input type="date" id="svc-end" value="${escape(s.end)}" min="${escape(tl.min_date)}" max="${escape(tl.max_period_end)}"></label>
    <label>파인튜닝에 쓸 직전 기간<select id="svc-window">${options(C().window_weeks_options, s.windowWeeks, v => `${v}주`)}</select></label>
    <label>파인튜닝 최소 간격<select id="svc-cooldown">${options(C().cooldown_options, s.cooldownDays, v => `${v}일`)}</select></label>
    <label>모델 교체 방식<select id="svc-promotion">${Object.entries(PROMOTION).map(([k, label]) => `<option value="${k}" ${s.promotion === k ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>시작 모델<select id="svc-start-model"><option value="">기준 모델 (처음 상태)</option>${(state.data.svcModels || []).map(m => `<option value="${escape(m.version)}" ${s.startModel === m.version ? 'selected' : ''}>${escape(m.version)} · ${m.lab_role === 'baseline' ? '기준 모델' : `파인튜닝 (${escape((m.lab_reference || {}).end || '')})`}${m.synthetic ? ' · 가상' : ''}</option>`).join('')}</select></label>
    <label>진행 속도 (화면에서 흐름 보기)<select id="svc-pace">${options([0.01, 0.05, 0.15], s.pace, v => ({0.01: '빠르게', 0.05: '보통', 0.15: '느리게'})[v])}</select></label>
    <button class="secondary" data-action="svc-range" data-range="drift">드리프트 모두 포함</button><button class="secondary" data-action="svc-range" data-range="all">전체 기간</button>
    <button data-action="svc-run-period" ${busy ? 'disabled' : ''}>${run || '이 구간 연속 운영 실행'}</button></div>
    <div class="controls shock-box"><label class="inline"><input type="checkbox" id="svc-shock-on" ${s.shock.on ? 'checked' : ''}> <b>가상 충격 데이터 넣기</b> (시뮬레이션용 · 실제 데이터는 바뀌지 않음)</label>
    ${s.shock.on ? `<label>시작일<input type="date" id="svc-shock-start" value="${escape(s.shock.start)}" min="${escape(s.start)}" max="${escape(s.end)}"></label>
      <label>오르는 기간 (일)<input type="number" id="svc-shock-days" value="${s.shock.days}" min="7" max="730" style="width:92px"></label>
      <label>상승률 (%)<input type="number" id="svc-shock-pct" value="${s.shock.pct}" min="-80" max="900" style="width:92px"></label>
      <label>출렁임 (%)<input type="number" id="svc-shock-wave" value="${s.shock.wave_pct}" min="0" max="150" style="width:92px"></label>
      <label>출렁임 주기 (일)<input type="number" id="svc-shock-period" value="${s.shock.wave_days}" min="7" max="365" style="width:92px"></label>
      <span class="note">기본값은 이 가격 이력에서 계산했습니다: 역대 최대 1년 상승률, 월간 변동폭의 95분위. 충격이 끝난 뒤 한참 더 돌리면 새 국면에 맞춘 모델이 오히려 불리해질 수 있어 기간을 충격 구간에 맞춰 두었습니다.</span>` : ''}</div>`;
  return `<div class="controls">
    ${s.mode === 'free' ? `<label>시점 T<input type="date" id="svc-date" value="${escape(s.day)}" min="${escape(tl.min_date)}" max="${escape(tl.max_date)}"></label>
    <label class="grow">날짜 이동<input type="range" id="svc-slider" min="${lo}" max="${hi}" value="${s.index.get(s.day)}"></label>` : `<span class="note">아래 드리프트 구간을 누르거나 그래프를 클릭하면 가장 가까운 구간의 대표 시점이 선택됩니다.</span>`}
    <label>파인튜닝에 쓸 직전 기간<select id="svc-window">${options(C().window_weeks_options, s.windowWeeks, v => `${v}주 (${v*7}일)`)}</select></label>
    <label>T 이후 비교 기간<select id="svc-eval">${options(C().eval_weeks_options, s.evalWeeks, v => `${v}주`)}</select></label>
    <label class="inline"><input type="checkbox" id="svc-force" ${s.force ? 'checked' : ''}> 정상이어도 파인튜닝해서 비교</label>
    <button data-action="svc-run" ${busy ? 'disabled' : ''}>${run || '이 시점으로 실행'}</button></div>`;
}

/* ----- result ----- */
const METRICS = [['wape', 'WAPE', '%', 2, 'lower'], ['rmse', 'RMSE', '', 2, 'lower'], ['rmse_pct', 'RMSE ÷ 평균가', '%', 2, 'lower'], ['direction', '4주 방향 정확도', '%', 1, 'higher'], ['bias', '편향 (절대값)', '', 2, 'lower']];
const gainOf = (key, direction, base, tuned) => {
  const b = key === 'bias' ? Math.abs(base) : base, t = key === 'bias' ? Math.abs(tuned) : tuned;
  return b ? (direction === 'lower' ? (b-t)/Math.abs(b) : (t-b)/Math.abs(b))*100 : 0;
};
// Centered at zero; the full width is the largest gain in this result, so even a small gap is a visible bar.
function deltaBar(gain) {
  const width = Math.min(50, Math.abs(gain)/DELTA_SCALE*50);
  return `<div class="delta-track"><i></i><b class="${gain >= 0 ? 'good' : 'bad'}" style="${gain >= 0 ? 'left' : 'right'}:50%;width:${width}%"></b></div>`;
}
function bigMetric(label, unit, digits, base, tuned, gain) {
  const better = gain > 0, top = Math.max(Math.abs(base), Math.abs(tuned)) || 1;
  const arrow = Math.abs(gain) < .05 ? '＝' : better ? '▼' : '▲';
  return `<div class="lab-card"><div class="lab-label">${label}</div>
    <div class="lab-pair"><span class="base">${num(base, digits)}<small>${unit}</small></span><em>→</em><span class="tuned">${num(tuned, digits)}<small>${unit}</small></span></div>
    <div class="lab-bars"><div><i style="width:${Math.abs(base)/top*100}%;background:${COLOR.base}"></i><small>기존</small></div><div><i style="width:${Math.abs(tuned)/top*100}%;background:${COLOR.tuned}"></i><small>파인튜닝</small></div></div>
    <div class="lab-delta ${better ? 'good' : Math.abs(gain) < .05 ? '' : 'bad'}">${arrow} ${num(Math.abs(base-tuned), digits)}${unit ? '%p' : ''} · ${gain >= 0 ? '' : '−'}${num(Math.abs(gain), 1)}% ${better ? '개선' : Math.abs(gain) < .05 ? '변화 없음' : '악화'}</div>${deltaBar(gain)}</div>`;
}

function weeklyBars(weekly, legend = ['기존 모델 (주별 WAPE %)', '파인튜닝 모델']) {
  const W = 900, H = 210, L = 44, R = 10, T = 14, B = 34, top = Math.max(...weekly.flatMap(w => [w.base, w.tuned ?? 0]))*1.1 || 1;
  const slot = (W-L-R)/weekly.length, bar = Math.min(26, slot*.38), y = v => T+(1-v/top)*(H-T-B);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="주별 WAPE 비교">`;
  for (let i = 0; i <= 3; i++) { const v = top*i/3; svg += `<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${num(v, 1)}</text>`; }
  weekly.forEach((w, i) => {
    const cx = L+slot*(i+.5);
    svg += `<rect x="${cx-bar-1}" y="${y(w.base)}" width="${bar}" height="${H-B-y(w.base)}" fill="${COLOR.base}" rx="2"/>`;
    if (w.tuned !== undefined) svg += `<rect x="${cx+1}" y="${y(w.tuned)}" width="${bar}" height="${H-B-y(w.tuned)}" fill="${COLOR.tuned}" rx="2"/>`;
    if (i % Math.ceil(weekly.length/14) === 0) svg += `<text x="${cx}" y="${H-18}" text-anchor="middle">${escape(w.label ?? `${i+1}주`)}</text>`;
    if (weekly.length <= 14) svg += `<text x="${cx-bar/2}" y="${y(w.base)-4}" text-anchor="middle" font-size="9">${num(w.base, 1)}</text>${w.tuned !== undefined ? `<text x="${cx+1+bar/2}" y="${y(w.tuned)-4}" text-anchor="middle" font-size="9">${num(w.tuned, 1)}</text>` : ''}`;
  });
  return svg+`</svg><div class="legend"><span><i style="background:${COLOR.base}"></i>${escape(legend[0])}</span>${weekly[0].tuned !== undefined ? `<span><i style="background:${COLOR.tuned}"></i>${escape(legend[1])}</span>` : ''}</div>`;
}

function labResult(r) {
  const tuned = !!r.tuned, after = r.metrics.after, v = r.verdict, [headline, tone] = VERDICT[v.code], d = r.decision;
  const decision = `<div class="lab-decision"><b>${escape(d.reason)}</b><span>${d.cause ? causeBadge(d.cause) : ''} ${d.drift_confirmed ? badge('학습 윈도우와 달라짐(드리프트 확정)', 'red') : d.input_drift ? badge('드리프트 의심', 'amber') : badge('입력 분포 안정', 'green')} ${badge(`T = ${r.day}`, 'blue')} ${badge(`직전 ${r.window_weeks}주 · 이후 ${r.eval_weeks}주`)}</span></div>`;
  if (!tuned) {
    const b = after.base;
    return `<section class="lab-hero neutral"><div class="lab-kicker">RESULT · ${escape(r.day)}</div><h2>${headline}</h2><p>기존 모델은 T 이후 ${b.n}일 동안 WAPE ${pct(b.wape)}, RMSE ${num(b.rmse, 1)}로 유지됐습니다.</p></section>${decision}
      ${panel('T 이후 기존 모델 성능', `<div class="kpis three">${kpi('WAPE', num(b.wape, 2), '%', `${b.n}일 예측`)}${kpi('RMSE', num(b.rmse, 1), r.unit, `평균가 대비 ${num(b.rmse_pct, 2)}%`)}${kpi('방향 정확도', num(b.direction, 1), '%', '4주 뒤 오름/내림')}</div>${forecastChart(r)}`, `<button data-action="svc-run-force" ${state.job ? 'disabled' : ''}>그래도 파인튜닝해서 비교</button>`)}`;
  }
  const t = after.tuned, b = after.base, g = Object.fromEntries(METRICS.map(([k,,, , dir]) => [k, gainOf(k, dir, b[k], t[k])]));
  DELTA_SCALE = Math.max(1, ...Object.values(g).map(Math.abs))*1.15;
  const ci = v.interval, hold = r.metrics.holdout, tu = r.tuned;
  const hero = `<section class="lab-hero ${tone}"><div class="lab-kicker">RESULT · ${escape(r.day)} 기준 · T 이후 ${b.n}일 예측</div><h2>${headline}</h2>
    <p>WAPE ${pct(b.wape)} → ${pct(t.wape)} (${v.wape_gain >= 0 ? '−' : '+'}${num(Math.abs(v.wape_gain), 2)}%p) · 95% 구간 ${ci[0] >= 0 ? '+' : ''}${num(ci[0], 2)} ~ ${ci[1] >= 0 ? '+' : ''}${num(ci[1], 2)}%p (0을 포함하면 우연일 수 있음) · 파인튜닝이 더 가까웠던 날 ${num(v.win_rate, 0)}%</p></section>`;
  const rows = METRICS.map(([k, name, unit, digits]) => [name, `${num(b[k], digits)}${unit}`, `${num(t[k], digits)}${unit}`, `${g[k] >= 0 ? '+' : '−'}${num(Math.abs(g[k]), 1)}%`, deltaBar(g[k])]);
  const gate = `<div class="lab-gate ${tu.gate_passed ? 'good' : 'bad'}"><b>${tu.gate_passed ? '교체 조건 충족' : '교체 조건 미달'}</b> — T 직전 ${tu.holdout_samples}일(학습에 쓰지 않은 구간) WAPE 기존 ${pct(hold.base.wape)} vs 파인튜닝 ${pct(hold.tuned.wape)} · ${tu.beats_baseline_on_holdout ? '기존보다 낮음' : '기존보다 낮지 않음'} · 상한 ${pct(tu.gate.max_percent, 0)} ${tu.gate.passed ? '통과' : '초과'}</div>`;
  const history = tu.learning_history;
  return `${hero}${decision}
    <div class="grid-main"><div>${panel('실제 가격과 두 모델의 4주 예측', forecastChart(r))}${gapPanels(r.series.target_date, r.series.actual, [{name: '기존 모델', values: r.series.base, color: COLOR.base}, {name: '파인튜닝 모델', values: r.series.tuned, color: COLOR.tuned}])}</div>
      <div><div class="lab-cards compact">${bigMetric('WAPE', '%', 2, b.wape, t.wape, g.wape)}${bigMetric(`RMSE`, '', 2, b.rmse, t.rmse, g.rmse)}</div>
      ${panel('파인튜닝 내역', `${gate}${definition('학습 기간', `${escape(tu.window_start)} ~ ${escape(tu.train_end)} (${tu.train_samples}개 표본)`)}${definition('epoch', `${tu.epochs} · ${num(tu.seconds, 1)}초`)}${definition('시작 모델', escape(r.baseline))}`)}
      ${panel('전체 지표 비교', table(['지표', '기존', '파인튜닝', '개선율'], rows.map(x => x.slice(0, 4))))}</div></div>`;
}

/* ----- 구매 타이밍 ----- */
const SIG = {must_buy: ['무조건 구매', '#dc2626'], buy: ['구매', '#f59e0b'], hold: ['보통', '#cbd5e1'], wait: ['대기', '#38bdf8'], strong_wait: ['강한 대기', '#1d4ed8']};
const sig = level => `<span class="sig" style="background:${SIG[level][1]}">${SIG[level][0]}</span>`;
const signed = (v, d = 1) => v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${num(v, d)}%`;

function signalChart(r) {
  const t = r.timing, ser = r.series, n = t.price.length, W = 900, H = 262, L = 56, Rm = 14, X = i => L+i*(W-L-Rm)/Math.max(n-1, 1);
  const runs = levels => { const out = []; levels.forEach((lv, i) => { if (out.length && out.at(-1).lv === lv) out.at(-1).b = i; else out.push({lv, a: i, b: i}); }); return out; };
  const lo = Math.min(...t.price)*.97, hi = Math.max(...t.price)*1.02, y = v => 14+(hi-v)/(hi-lo)*130, bar = (run, top, h, opacity = 1) => `<rect x="${X(run.a)-.3}" y="${top}" width="${X(run.b+1 > n-1 ? n-1 : run.b+1)-X(run.a)+.6}" height="${h}" fill="${SIG[run.lv][1]}" opacity="${opacity}"/>`;
  let svg = `<svg class="chart signal-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="일별 구매 타이밍">`;
  runs(t.adaptive.levels).forEach(run => { svg += bar(run, 8, 140, .3); });
  [lo, hi].forEach(v => { svg += `<line x1="${L}" y1="${y(v)}" x2="${W-Rm}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${num(v, 0)}</text>`; });
  svg += `<polyline points="${t.price.map((v, i) => `${X(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#111827" stroke-width="2"/>`;
  svg += `<text x="${L-6}" y="${171}" text-anchor="end" class="sig-label">자동</text><text x="${L-6}" y="${195}" text-anchor="end" class="sig-label">고정</text><text x="${L-6}" y="${216}" text-anchor="end" class="sig-label">신뢰</text><text x="${L-6}" y="${236}" text-anchor="end" class="sig-label">드리프트</text>`;
  runs(t.adaptive.levels).forEach(run => { svg += bar(run, 160, 18); });
  runs(t.fixed.levels).forEach(run => { svg += bar(run, 184, 18); });
  runs(t.reliable.map(v => v ? 'hold' : 'strong_wait')).filter(run => run.lv === 'strong_wait').forEach(run => { svg += `<rect x="${X(run.a)}" y="208" width="${X(Math.min(run.b+1, n-1))-X(run.a)}" height="10" fill="#111827" opacity=".75"/>`; });
  (r.episodes || []).forEach(e => { const a = ser.issued_at.findIndex(d => d >= e.start), bIdx = ser.issued_at.findIndex(d => d > e.end); const A = Math.max(0, a), B = bIdx < 0 ? n-1 : bIdx; if (a < 0 && bIdx < 0) return; svg += `<rect x="${X(A)}" y="228" width="${Math.max(3, X(B)-X(A))}" height="10" fill="#f5b942"/>`; });
  let lastMonth = '';
  ser.issued_at.forEach((d, i) => { const m = d.slice(0, 7); if (m !== lastMonth && ['01', '04', '07', '10'].includes(m.slice(5))) svg += `<text x="${X(i)}" y="${H-6}" text-anchor="middle">${m.slice(2)}</text>`; lastMonth = m; });
  svg += '</svg>';
  const legend = Object.entries(SIG).map(([k, [label, color]]) => `<span><i style="background:${color}"></i>${label}</span>`).join('');
  return svg+`<div class="legend">${legend}<span><i style="background:#111827"></i>신뢰 낮음 (서비스 모델 ${C().window_days}일 WAPE가 경계 초과)</span><span><i style="background:#f5b942"></i>데이터 드리프트 구간</span></div>`;
}

function signalCards(r) {
  const stats = r.timing.adaptive.stats, rule = r.timing.rules;
  const range = {must_buy: `예측 ≥ ${signed(rule.must_buy_pct, 2)}`, buy: `${signed(rule.buy_pct, 2)} ~ ${signed(rule.must_buy_pct, 2)}`, hold: `${signed(rule.wait_pct, 2)} ~ ${signed(rule.buy_pct, 2)}`, wait: `${signed(rule.strong_wait_pct, 2)} ~ ${signed(rule.wait_pct, 2)}`, strong_wait: `예측 ≤ ${signed(rule.strong_wait_pct, 2)}`};
  return `<div class="sig-cards">${Object.keys(SIG).map(level => { const s = stats[level]; return `<div class="sig-card" style="border-top-color:${SIG[level][1]}">
    <div class="sig-name" style="color:${SIG[level][1]}">${SIG[level][0]}</div><small>${range[level]}</small>
    <div class="sig-big">${s.days}<small>일 · ${num(s.share, 0)}%</small></div>
    <div class="sig-line">실제 4주 뒤 <b>${signed(s.avg_realized)}</b></div>
    <div class="sig-line">적중 <b class="${s.hit === null ? '' : s.hit >= 60 ? 'good' : 'bad'}">${s.hit === null ? '—' : `${num(s.hit, 0)}%`}</b></div></div>`; }).join('')}</div>`;
}

function timingPanels(r) {
  const t = r.timing, a = t.adaptive, f = t.fixed;
  const windows = a.windows.length ? table(['신호', '기간', '일수', '모델 예측', '실제 4주 뒤', '적중', '모델 신뢰'], a.windows.map(w => [
    sig(w.level), `${escape(w.start)} ~ ${escape(w.end)}`, `${w.days}일`, signed(w.avg_predicted), `<b class="${w.hit >= 60 ? 'good-text' : 'bad-text'}">${signed(w.avg_realized)}</b>`,
    badge(`${num(w.hit, 0)}%`, w.hit >= 60 ? 'green' : 'red'), w.reliable_share >= 80 ? badge('높음', 'green') : badge(`낮음 ${num(w.reliable_share, 0)}%`, 'amber')])) : empty('연속으로 이어진 무조건 구매·강한 대기 구간이 없습니다');
  const row = (name, m) => [name, `${m.stats.must_buy.days}일 · 적중 ${m.stats.must_buy.hit === null ? '—' : `${num(m.stats.must_buy.hit, 0)}%`}`,
    `${m.stats.strong_wait.days}일 · 적중 ${m.stats.strong_wait.hit === null ? '—' : `${num(m.stats.strong_wait.hit, 0)}%`}`, `${num(m.stats.direction_hit, 0)}%`];
  return `${panel('구매 타이밍 · 매일의 신호', `<p class="note">매일 서비스 모델의 4주 뒤 예측을 현재가와 비교해 신호를 냅니다. 배경색과 아래 띠가 같은 신호입니다. 검은 띠는 모델 오차가 경계를 넘은 "신뢰 낮음" 구간 — 이때 나온 신호는 조심해서 보세요.</p>${signalChart(r)}`, badge(`신뢰 낮음 ${t.unreliable_days}일`, t.unreliable_days ? 'amber' : 'green'))}
    ${signalCards(r)}
    ${panel('언제 사야/기다려야 했나 (연속 신호 구간)', `<p class="note">"무조건 구매"나 "강한 대기"가 3일 이상 이어진 구간입니다. 적중은 실제 4주 뒤 가격이 신호 방향(구매→상승, 대기→하락)으로 움직인 날의 비율입니다.</p>${windows}`)}
    ${panel('신호 품질 비교 · 자동 파인튜닝 vs 고정 기준 모델', table(['모델', '무조건 구매', '강한 대기', '구매·대기 방향 적중'], [row('자동 파인튜닝 서비스', a), row('고정 기준 모델', f)]) + (t.rules.quantiles ? `<p class="note">신호 경계는 입력한 숫자가 아니라 기준 모델이 학습하지 않은 구간의 예측 ${t.rules.samples}개에서 계산했습니다: 4주 예측 변화율의 상위 ${num((1-t.rules.quantiles.must_buy)*100, 0)}%(무조건 구매) · ${num((1-t.rules.quantiles.buy)*100, 0)}%(구매) · 하위 ${num(t.rules.quantiles.wait*100, 0)}%(대기) · ${num(t.rules.quantiles.strong_wait*100, 0)}%(강한 대기). "보통"의 적중은 실제 변동이 한 달 평균 변동폭(${num(t.rules.hold_band_pct, 2)}%) 안인 날입니다.</p>` : ''))}`;
}

/* ----- 라이브 시뮬레이션: 데이터 수신 → 예측 → 드리프트 확인 → 이상 감지 → 파인튜닝 → 게이트 → 교체 ----- */
function windowBox(now) {
  const cell = (label, from, to, note, color) => `<div class="win"><span>${label}</span><b style="color:${color}">${escape(from)} ~ ${escape(to)}</b><small>${note}</small></div>`;
  return `<div class="windows">${cell('서비스 모델이 학습한 윈도우 (기준)', now.ref_start, now.ref_end, `모델 ${escape(now.serving)} · 이 구간의 가격 변동 분포가 "정상"의 기준`, '#2563eb')}<i>vs</i>${
    cell(`최근 ${C().ks_current_days}일 (방금 들어온 데이터)`, now.cur_start, now.day, `KS ${num(now.ks, 2)} · 경계 ${num(now.ks_limit, 2)} · ${now.confirmed ? `${C().confirm_days}일 연속 초과 → 파인튜닝` : now.drift ? '초과 (확정 대기)' : '경계 안'}`, now.confirmed ? 'var(--red)' : now.drift ? 'var(--amber)' : 'var(--green)')}</div>`;
}

function liveView() {
  const rows = state.svc.live.rows, days = rows.filter(r => r.type === 'day'), events = rows.filter(r => r.type !== 'day' && r.type !== 'done');
  if (!days.length) return `<div class="empty">시뮬레이션을 시작하는 중…</div>`;
  const now = days.at(-1), newest = rows.at(-1), nan = v => v === null || v === undefined ? NaN : v;
  const recent = type => { const i = rows.findLastIndex(r => r.type === type); return i >= 0 && rows.length-i <= 10 ? rows[i] : null; };
  const tuning = newest.type === 'tune_start', end = recent('tune_end'), decided = recent('decision');
  const over = now.stage > 0;
  const stage = (name, icon, cls, note) => `<div class="stage ${cls}"><div class="stage-icon">${icon}</div>${name}<small>${escape(note)}</small></div>`;
  const pipe = `<div class="pipeline">${
    stage('데이터 수신', '⛁', 'done', `${now.day} · ${price(now.price)}`)}${
    stage('예측', '◎', 'done', `4주 뒤 ${price(now.adaptive)} (${signed((now.adaptive/now.price-1)*100)})`)}${
    stage('드리프트 확인', '◉', now.confirmed ? 'error' : now.drift ? 'active' : 'done', `학습 윈도우 대비 KS ${num(now.ks, 2)} / ${num(now.ks_limit, 2)}`)}${
    stage('이상 감지', '⚠', now.stage === 2 ? 'error' : now.stage === 1 ? 'active' : 'done', now.wape === null ? '오차 확정 대기' : now.stage === 2 ? `2단계 · ${pct(now.wape, 1)} > ${pct(now.wape_tune_limit, 1)}` : now.stage === 1 ? `1단계 경고 · ${pct(now.wape, 1)}` : `정상 · ${pct(now.wape, 1)}`)}${
    stage('파인튜닝', '↻', tuning ? 'active' : end ? 'done' : '', tuning ? `${newest.candidate} 학습 중…` : end ? end.candidate : '대기')}${
    stage('검증', '✓', now.challenger ? 'active' : decided ? (decided.promoted ? 'done' : 'error') : end ? (end.prescreen_passed ? 'done' : 'error') : '',
          now.challenger ? `섀도 ${now.shadow_done}/${now.shadow_need}일` : end ? `사전 ${pct(end.serving_wape, 1)} → ${pct(end.tuned_wape, 1)}` : '—')}${
    stage('모델 교체', '⇪', decided?.promoted ? 'done' : decided ? 'error' : '', decided ? (decided.promoted ? `${decided.candidate} 서비스 시작` : '교체 안 함') : `서비스 ${now.serving}`)}</div>`;
  const banners = `${now.synthetic ? `<div class="banner info"><b>가상 충격 구간</b> — 지금 들어오는 가격은 시뮬레이션용으로 만든 값입니다 (실제 데이터 아님)</div>` : ''}${now.quality?.length ? `<div class="banner danger">데이터 품질 문제 (${escape(now.quality.map(k => ({invalid: '비정상 값', gap: '관측 누락', unit: '단위 혼입 의심', stale: '갱신 정지'})[k] || k).join(', '))}) — 이 데이터로는 재학습하지 않고 보류합니다</div>` : ''}${
    now.challenger ? `<div class="banner info"><span><b>섀도 운영 중</b> ${escape(now.challenger)} — 서비스는 계속 ${escape(now.serving)}가 하고, 후보는 같은 입력으로 예측만 합니다. 실제 정답이 ${now.shadow_need}일치 확정되면(${now.shadow_done}/${now.shadow_need}) 챔피언과 비교해 교체 여부를 정합니다.</span><span class="progress wide"><i style="width:${Math.min(100, now.shadow_done/now.shadow_need*100)}%"></i></span></div>` : ''}`;
  const sloBar = `<div class="slo"><span>오차 SLO 에러 버짓</span><div class="progress"><i style="width:${Math.min(100, now.allowed_bad ? now.bad_days/now.allowed_bad*100 : 0)}%;background:${now.bad_days > now.allowed_bad ? 'var(--red)' : now.bad_days > now.allowed_bad*.7 ? 'var(--amber)' : 'var(--green)'}"></i></div><b>${now.bad_days}일 / 허용 ${num(now.allowed_bad, 1)}일</b></div>`;
  const progress = `<div class="progress"><i style="width:${(now.k+1)/now.n*100}%"></i></div>`;
  const kpis = `<div class="kpis five">${
    kpi('시뮬레이션 날짜', escape(now.day), '', `${now.k+1} / ${now.n}일 · 서비스 모델 ${escape(now.serving)}`)}${
    kpi('오늘 가격', price(now.price), '', '방금 들어온 관측')}${
    kpi('4주 뒤 예측', price(now.adaptive), '', `${sig(now.level)} ${signed((now.adaptive/now.price-1)*100)}`)}${
    kpi(`모델 오차 (${C().window_days}일 WAPE)`, now.wape === null ? '—' : num(now.wape, 2), '%', `${['정상', '1단계 경고', '2단계 파인튜닝'][now.stage]} · 경고 ${pct(now.wape_limit, 1)} / 파인튜닝 ${pct(now.wape_tune_limit, 1)}`, ['', 'warn', 'bad'][now.stage])}${
    kpi('학습 윈도우 대비 KS', num(now.ks, 2), '', `${now.confirmed ? '드리프트 확정' : now.drift ? '드리프트 의심' : '안정'} · 경계 ${num(now.ks_limit, 2)}`, now.confirmed ? 'bad' : now.drift ? 'warn' : '')}</div>`;
  const marks = events.filter(e => e.type === 'tune_start').map(e => days.findIndex(d => d.day === e.day)).filter(i => i >= 0);
  const extra = C().horizon_days, labels = [...days.map(d => d.day), ...Array(extra).fill(now.target_date)];
  const shifted = key => [...Array(extra).fill(NaN), ...days.map(d => d[key])].slice(0, days.length+extra);
  const priceChart = chart([
    {name: '들어온 가격', values: [...days.map(d => d.price), ...Array(extra).fill(NaN)], color: COLOR.actual, width: 2.2},
    {name: '고정 기준 모델의 4주 예측', values: shifted('fixed'), color: COLOR.base, width: 3, dash: true},
    {name: '자동 파인튜닝 서비스의 4주 예측', values: shifted('adaptive'), color: COLOR.tuned, width: 1.6},
    {name: '파인튜닝 후보의 4주 예측', values: shifted('candidate'), color: '#2563eb', width: 1.2}], {height: 230, labels, marks, markName: '자동 파인튜닝', bands: (() => { const f = days.findIndex(d => d.synthetic), l = days.findLastIndex(d => d.synthetic); return f < 0 ? [] : [{from: f, to: l + extra, label: '가상 충격 구간 (실제 데이터 아님)'}]; })()});
  const gapOf = key => days.map(d => d[key] === null || d[key] === undefined ? NaN : d[key]-d.fixed);
  const gapChart = chart([
    {name: '자동 서비스 − 고정 기준', values: gapOf('adaptive'), color: COLOR.tuned, width: 2},
    {name: '파인튜닝 후보 − 고정 기준', values: gapOf('candidate'), color: '#2563eb', width: 1.6, dash: true},
    {name: '0 (같음)', values: days.map(() => 0), color: '#94a3b8', dash: true, width: 1.2}], {height: 150, labels: days.map(d => d.day), marks, markName: '자동 파인튜닝'});
  const matured = days.map(d => d.matured).filter(Boolean);
  const running = (key, subset = matured) => { const rows2 = subset.filter(m => m[key] !== null && m[key] !== undefined); if (!rows2.length) return null;
    const abs = rows2.reduce((s, m) => s+Math.abs(m.actual-m[key]), 0), tot = rows2.reduce((s, m) => s+m.actual, 0), sq = rows2.reduce((s, m) => s+(m.actual-m[key])**2, 0);
    return {n: rows2.length, wape: abs/tot*100, rmse: Math.sqrt(sq/rows2.length), dir: rows2.filter(m => Math.sign(m[key]-m.last) === Math.sign(m.actual-m.last)).length/rows2.length*100}; };
  const withCand = matured.filter(m => m.candidate !== null);
  const metricRow = (name, color, key, subset) => { const m = running(key, subset); return [`<b style="color:${color}">${name}</b>`, m ? m.n : '—', m ? pct(m.wape) : '—', m ? num(m.rmse, 1) : '—', m ? pct(m.dir, 1) : '—']; };
  const metricsTable = table(['모델', '확정된 예측', 'WAPE', 'RMSE', '방향 정확도'], [
    metricRow('고정 기준 모델', COLOR.base, 'fixed'), metricRow('자동 파인튜닝 서비스', COLOR.tuned, 'adaptive'),
    ...(withCand.length ? [metricRow('— 후보 구간 · 고정', COLOR.base, 'fixed', withCand), metricRow('— 후보 구간 · 파인튜닝 후보', '#2563eb', 'candidate', withCand)] : [])]);
  const wapeChart = chart([
    {name: `서비스 모델 ${C().window_days}일 WAPE (%)`, values: days.map(d => nan(d.wape)), color: COLOR.tuned, width: 2},
    {name: '1단계 경고 경계', values: days.map(d => d.wape_limit), color: '#f59e0b', dash: true, width: 1.3},
    {name: '2단계 파인튜닝 경계', values: days.map(d => d.wape_tune_limit), color: 'var(--red)', dash: true, width: 1.3}], {height: 150, labels: days.map(d => d.day), marks, markName: '자동 파인튜닝'});
  const ksChart = chart([
    {name: '입력 분포 변화 (KS)', values: days.map(d => nan(d.ks)), color: '#2563eb', width: 2},
    {name: '경계', values: days.map(d => nan(d.ks_limit)), color: 'var(--red)', dash: true, width: 1.2}], {height: 150, labels: days.map(d => d.day)});
  const strip = `<div class="sig-strip">${days.slice(-90).map(d => `<i title="${escape(d.day)} ${SIG[d.level][0]}" style="background:${SIG[d.level][1]}"></i>`).join('')}</div>`;
  const line = e => ({
    drift_alert: [badge('드리프트 감지', 'amber'), `입력 분포 KS ${num(e.ks, 2)} > 경계 ${num(e.ks_limit, 2)} · ${C().confirm_days}일 연속 ${e.cause ? '· 원인: ' + (CAUSE[e.cause.kind] || e.cause.kind) : ''}`],
    warn: [badge('1단계 경고', 'amber'), `${escape(e.what || '')} — 알리기만 합니다 (파인튜닝: 학습 윈도우와 ${C().confirm_days}일 연속 달라지거나 WAPE ${pct(e.wape_tune_limit, 1)} 초과)`],
    warn_end: [badge('경고 해제', 'green'), `WAPE ${pct(e.wape, 1)}로 경계 안으로 돌아왔습니다`],
    drift_resolved: [badge('드리프트 해소', 'green'), '입력 분포가 경계 안으로 돌아왔습니다'],
    tune_start: [badge('2단계 파인튜닝', 'red'), `${({drift: `최근 ${C().ks_current_days}일이 학습 윈도우(${e.ref_start} ~ ${e.ref_end})와 달라짐 (KS ${num(e.ks, 2)} > ${num(e.ks_limit, 2)})`, wape: `서비스 모델 ${C().window_days}일 WAPE ${pct(e.wape, 1)} > ${pct(e.wape_limit, 1)}`, both: `학습 윈도우와 달라짐 (KS ${num(e.ks, 2)}) + WAPE ${pct(e.wape, 1)}`})[e.trigger]} → ${e.candidate} 파인튜닝 시작${e.cause ? ' · 원인: ' + (CAUSE[e.cause.kind] || e.cause.kind) : ''}`],
    tune_end: [e.prescreen_passed ? badge('사전 검증 통과', 'green') : badge('사전 검증 탈락', 'red'), `${e.candidate}: 직전 ${C().holdout_days}일 WAPE ${pct(e.serving_wape, 2)} → ${pct(e.tuned_wape, 2)} · RMSE ${num(e.serving_rmse, 1)} → ${num(e.tuned_rmse, 1)} · 학습 ${num(e.seconds, 1)}초`],
    shadow_start: [badge('섀도 시작', 'blue'), `${e.candidate}: 서비스하지 않고 병행 예측 — 정답 ${e.need}일치가 확정될 때까지`],
    shadow_end: [e.passed ? badge('섀도 통과', 'green') : badge('섀도 탈락', 'red'), `${e.candidate}: 확정된 ${e.n}일 동안 WAPE ${pct(e.champion_wape, 2)} → ${pct(e.challenger_wape, 2)} · RMSE ${num(e.champion_rmse, 1)} → ${num(e.challenger_rmse, 1)}`],
    decision: [e.promoted ? badge('모델 교체', 'green') : badge('유지', 'red'), `${e.candidate}: ${escape(e.why)}`],
    quality: [badge('데이터 품질', 'red'), `${(e.issues || []).map(i => escape(i.message)).join(' · ')} — 재학습 보류`],
    quality_end: [badge('품질 정상', 'green'), '데이터가 정상으로 돌아왔습니다'],
    slo_breach: [badge('SLO 위반', 'red'), `경계 초과 ${e.bad_days}일 > 허용 ${num(e.allowed, 1)}일 — 에러 버짓 소진`]})[e.type];
  const feed = events.length ? `<div class="feed">${[...events].reverse().slice(0, 14).map(e => { const [b, text] = line(e) || [badge(e.type), '']; return `<div class="feed-row"><time>${escape(e.day)}</time>${b}<span>${text}</span></div>`; }).join('')}</div>` : empty('아직 이상이 없습니다', '데이터가 계속 들어오는 중입니다');
  return `<div class="live-head"><b>● LIVE</b> 데이터가 들어올 때마다 예측하고, 드리프트를 확인하고, 이상이 생기면 스스로 고칩니다</div>${progress}${pipe}${banners}${kpis}
    ${windowBox(now)}
    <div class="grid-main"><div>${panel('가격 · 4주 예측 (목표일 기준)', priceChart)}${panel('고정 기준 모델 대비 예측 차이 (확대)', gapChart)}
      <div class="grid-two">${panel('모델 오차', wapeChart)}${panel('입력 드리프트', ksChart)}</div></div>
      <div>${panel('이벤트', feed)}${sloBar ? panel('오차 SLO 에러 버짓', sloBar) : ''}${panel('지금까지의 성능 (정답 확정분)', metricsTable)}${panel('최근 90일 구매 신호', strip + `<div class="legend">${Object.values(SIG).map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`)}</div></div>`;
}

/* Two forecasts that sit within a percent of each other overlap on a price chart. These panels draw only the gap. */
function gapPanels(dates, actual, lines, marks = []) {
  const nan = arr => arr.map(v => v === null || v === undefined ? NaN : v), [base, ...others] = lines;
  const gap = o => o.values.map((v, i) => v === null || base.values[i] === null ? NaN : v-base.values[i]);
  const err = values => values.map((v, i) => v === null ? NaN : (v/actual[i]-1)*100);
  const diffs = others.map(o => ({...o, values: gap(o)}));
  const stats = diffs.map(o => { const f = o.values.filter(Number.isFinite), big = f.filter(v => Math.abs(v) > 0); return `${o.name}: 평균 ${num(f.length ? f.reduce((s, v) => s+Math.abs(v), 0)/f.length : 0, 2)} · 최대 ${num(f.length ? Math.max(...f.map(Math.abs)) : 0, 1)} · 다른 날 ${big.length}일`; });
  const zero = values => ({name: '0 (기준 모델과 같음)', values: values.map(() => 0), color: '#94a3b8', dash: true, width: 1.2});
  return panel('예측 차이 확대 · 기준 모델 대비 (예측가 − 기준 예측가)', `<p class="note">${stats.map(escape).join(' &nbsp;|&nbsp; ')}</p>${chart([
      ...diffs.map(o => ({name: `${o.name} − ${base.name}`, values: o.values, color: o.color, width: 2, dash: o.dash})), zero(dates)], {height: 190, labels: dates, marks, markName: '모델 교체'})}`) +
    panel('오차 비교 · (예측 − 실제) ÷ 실제, % · 0에 가까울수록 정확', chart([
      ...lines.map(l => ({name: l.name, values: err(l.values), color: l.color, width: l === base ? 1.6 : 2, dash: l.dash})), zero(dates)], {height: 210, labels: dates, marks, markName: '모델 교체'}));
}

const OWNER_COLORS = ['#16a34a', '#0d9488', '#65a30d', '#15803d', '#0f766e', '#4d7c0f'];
function servingPanel(r) {
  const ser = r.series, owner = ser.owner; if (!owner) return '';
  const runs = []; owner.forEach((name, i) => { if (runs.length && runs.at(-1).name === name) { runs.at(-1).end = ser.issued_at[i]; runs.at(-1).days++; } else runs.push({name, start: ser.issued_at[i], end: ser.issued_at[i], days: 1}); });
  const names = [...new Set(owner)], isBase = n => n === r.baseline, color = n => isBase(n) ? '#94a3b8' : OWNER_COLORS[(names.filter(x => !isBase(x)).indexOf(n)) % OWNER_COLORS.length];
  const label = n => isBase(n) ? '기준 모델' : n.startsWith('tuned_') ? `파인튜닝 ${n.split('_').at(-1)}번째` : `저장된 모델 ${n}`;
  const bar = `<div class="owner-bar">${runs.map(x => `<i title="${escape(label(x.name))} ${escape(x.start)}~${escape(x.end)}" style="flex:${x.days};background:${color(x.name)}"></i>`).join('')}</div>`;
  const info = r.baseline_info ? {...r.baseline_info, reference_window: r.baseline_info.reference_window || null} : null, base = info ? `기준 모델 <b>${escape(r.baseline)}</b>: ${escape(info.mode)} · 학습 데이터 ${escape(info.trained_through)}까지${info.refit ? ' (컷오프까지 재학습)' : ''} · 자체 게이트 ${info.gate_passed ? '통과' : '미달(방향 정확도 등)'}` : `기준 모델 <b>${escape(r.baseline)}</b>`;
  return panel('시점별로 어떤 모델이 서비스됐나', `<p class="note">${base}. 고정 기준 모델은 이 구간 내내 같은 모델이고, 자동 서비스는 최근 ${C().ks_current_days}일이 서비스 모델의 학습 윈도우와 달라지거나(드리프트) 오차가 기준을 넘을 때 파인튜닝하고, 게이트를 통과(또는 항상 교체 모드)하면 그 모델로 바뀝니다. 바뀌면 "정상"의 기준 윈도우도 새 모델이 학습한 구간으로 바뀝니다.</p>${bar}
    ${table(['서비스 모델', '서비스한 기간', '일수', '이 모델이 학습한 윈도우', '구분'], runs.map(x => { const ev = r.events.find(e => e.candidate === x.name), w = isBase(x.name) ? info?.reference_window : ev && {start: ev.window_start, end: ev.day}; return [`<b style="color:${color(x.name)}">${escape(label(x.name))}</b> <small class="muted">${escape(x.name)}</small>`, `${escape(x.start)} ~ ${escape(x.end)}`, `${x.days}일`, w ? `${escape(w.start)} ~ ${escape(w.end)}` : '—', isBase(x.name) ? badge('처음부터 학습한 모델') : badge('파인튜닝한 모델', 'green')]; }))}`,
    runs.length === 1 ? badge('끝까지 같은 모델', 'amber') : badge(`${runs.length - 1}번 교체`, 'green'));
}

function switchNotice(r) {
  const swaps = r.events.filter(e => e.promoted);
  const forced = r.promotion === 'always' ? ' <b>항상 교체 모드</b>라 검증 결과와 상관없이 매번 교체했습니다.' : '';
  if (!r.events.length) return `<div class="banner info">파인튜닝이 한 번도 일어나지 않아 자동 서비스와 고정 기준 모델의 예측이 같습니다.</div>`;
  if (!swaps.length) return `<div class="banner info"><span>파인튜닝은 ${r.events.length}번 했지만 서비스 모델은 끝까지 기준 모델 그대로입니다: ${r.events.map(e => `${escape(e.day)} ${escape(e.decision || '탈락')}`).join(' · ')}. 그래서 초록(자동)과 회색(고정) 선이 같은 값이라 겹칩니다. 파란 선이 서비스에 올리지 않은 후보가 냈을 값입니다.</span></div>`;
  return `<div class="banner info">첫 모델 교체는 <b>${escape(swaps[0].day)}</b>입니다. 그 전에는 서비스 모델이 기준 모델이라 두 선이 같고, 교체(세로선) 이후부터 갈라집니다.${forced}</div>`;
}

function shadowPanel(r) {
  const s = r.shadow, row = (name, m, color) => [`<b style="color:${color}">${name}</b>`, pct(m.wape), num(m.rmse, 1), pct(m.rmse_pct), pct(m.direction, 1)];
  const best = Math.min(s.fixed.wape, s.adaptive.wape, s.candidate.wape);
  return panel(`첫 파인튜닝 이후 ${escape(s.since)}부터 ${s.days}일 · 세 모델 같은 날 비교`, table(['모델', 'WAPE', 'RMSE', 'RMSE ÷ 평균가', '방향 정확도'],
    [row('고정 기준 모델', s.fixed, COLOR.base), row('자동 파인튜닝 서비스', s.adaptive, COLOR.tuned), row('파인튜닝 후보 (항상 최신 후보)', s.candidate, '#2563eb')]) +
    `<p class="note">가장 낮은 WAPE는 ${pct(best)}입니다. "후보"는 게이트 통과 여부와 상관없이 가장 최근에 파인튜닝한 모델을 서비스했다면 나왔을 값입니다.</p>`);
}

function sloBars(slo) {
  const row = (name, color, s) => s ? `<div class="slo-row"><b style="color:${color}">${name}</b><div class="slo-track"><i style="width:${s.attainment}%;background:${s.attainment >= slo.target ? 'var(--green)' : 'var(--red)'}"></i><u style="left:${slo.target}%"></u></div><span>${pct(s.attainment, 1)} <small class="muted">목표 ${pct(slo.target, 0)}</small></span><span>${s.bad_days}일 초과 / 허용 ${num(s.allowed_bad_days, 1)}일 ${s.budget_left >= 0 ? badge(`버짓 ${num(s.budget_left, 1)}일 남음`, 'green') : badge(`버짓 ${num(-s.budget_left, 1)}일 초과`, 'red')}</span></div>` : '';
  return `<p class="note">목표: 서비스 모델의 ${C().window_days}일 WAPE가 경고 경계(${pct(slo.limit)}) 이내인 날이 ${pct(slo.target, 0)} 이상. 이 목표는 기준 모델이 학습하지 않은 구간에서 스스로 달성한 비율(경고 분위수)에서 가져왔습니다.</p>${row('고정 기준 모델', COLOR.base, slo.fixed)}${row('자동 파인튜닝', COLOR.tuned, slo.adaptive)}`;
}

function opsPanels(r, keys = ['slo', 'causes', 'quality', 'lineage', 'notes']) {
  const parts = {};
  if (r.slo) parts.slo = panel('오차 SLO · 에러 버짓', sloBars(r.slo));
  const causes = Object.entries(r.causes || {});
  parts.causes = (panel('드리프트 원인별 파인튜닝 성과', causes.length ? table(['드리프트 원인', '파인튜닝', '모델 교체', '교체 비율'], causes.map(([k, v]) => [causeBadge({kind: k}), `${v.n}회`, `${v.promoted}회`, pct(v.promoted/v.n*100, 0)])) + '<p class="note">이번 실행과 이전 실행을 합친 누적입니다. 교체 비율이 낮은 원인은 파인튜닝이 잘 듣지 않는 유형이므로 재학습 대신 경고와 점검으로 다루는 편이 낫습니다.</p>' : empty('원인이 분류된 파인튜닝이 없습니다')));
  const bad = r.quality || [];
  parts.quality = (panel('데이터 품질', bad.length ? table(['시작', '끝', '문제', '재학습'], bad.map(q => [escape(q.start), escape(q.end), q.issues.map(i => escape(i.message)).join('<br>'), badge('보류', 'amber')])) : `<div class="empty"><strong>이 구간에서는 데이터 품질 문제가 없었습니다</strong>매일 비정상 값 · 관측 누락 · 단위 혼입(${C().observation_step_days}일 변화율) · 공식 관측 갱신 정지를 점검하고, 문제가 있으면 드리프트로 오인해 재학습하지 않습니다.</div>`));
  const lineage = r.lineage || [];
  parts.lineage = (panel(`모델 계보 · 감사 기록 (${lineage.length})`, lineage.length ? table(['모델 ← 부모', '트리거 · 원인', '학습 윈도우', '사전 검증', '섀도 검증', '결과', '비용 · 개선'], lineage.map(l => [
    `<b>${escape(l.model)}</b> ${l.registry ? badge(l.registry, 'blue') : ''} ← ${escape(l.parent)}<br><small class="muted">${escape(l.day)} · ${PROMOTION[l.promotion] || ''} · 데이터 ${escape(l.data_version || '')}</small>`,
    `${l.trigger ? ({drift: '입력 드리프트', wape: '오차 초과', both: '둘 다'})[l.trigger] : ''} ${l.cause ? causeBadge({kind: l.cause}) : ''}`,
    `${escape(l.train_window.start)} ~ ${escape(l.train_window.end)}<br><small class="muted">${l.window_weeks}주 · ${l.epochs ?? '—'} epoch · lr ${l.learning_rate}</small>`,
    `${badge(l.prescreen_passed ? '통과' : '탈락', l.prescreen_passed ? 'green' : 'red')} <small class="muted">${pct(l.prescreen.serving.wape)} → ${pct(l.prescreen.tuned.wape)}</small>`,
    l.shadow ? `${badge(l.shadow.passed ? '통과' : '탈락', l.shadow.passed ? 'green' : 'red')} <small class="muted">${pct(l.shadow.champion_wape)} → ${pct(l.shadow.challenger_wape)}</small>` : '—',
    `${l.promoted ? badge('교체', 'green') : badge('유지', 'red')}<br><small class="muted">${escape(l.decision)}</small>`,
    `${num(l.cost_seconds, 1)}초${l.wape_gain === null ? '' : ` · WAPE ${l.wape_gain >= 0 ? '−' : '+'}${num(Math.abs(l.wape_gain), 2)}%p`}`])) + '<p class="note">같은 설정과 데이터 윈도우로 모델을 다시 만들고, 누가 어떤 근거로 서비스에 올렸는지 따라갈 수 있게 남기는 기록입니다 (service_lineage 테이블 · /api/service/lineage).</p>' : empty('이번 실행에서 만들어진 후보가 없습니다')));
  const notes = state.svc.notes || [];
  parts.notes = (panel(`알림함 (${notes.length})`, notes.length ? table(['시각', '수준', '제목', '내용', '전달'], notes.slice(0, 40).map(n => [escape(new Date(n.at).toLocaleString('ko-KR', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false})),
    badge({info: '정보', warn: '경고', page: '긴급'}[n.level] || n.level, {warn: 'amber', page: 'red'}[n.level] || ''), escape(n.title), escape(n.body || ''),
    n.delivery === 'sent' ? badge('전송됨', 'green') : n.delivery === 'failed' ? badge('전송 실패', 'red') : badge('알림함만')])) + '<p class="note">1단계 경고는 "경고", 파인튜닝·교체·데이터 품질·SLO 위반은 "긴급"으로 분류됩니다. 서버를 띄울 때 BUTTERCAST_WEBHOOK_URL 환경변수를 지정하면 같은 내용이 그 주소(Slack 등)로 전송되고, 지정하지 않으면 여기에만 쌓입니다.</p>' : empty('알림 없음')));
  return keys.map(k => parts[k] || '').join('');
}

function ownerBar(r) {
  const ser = r.series, owner = ser.owner; if (!owner) return '';
  const runs = []; owner.forEach((name, i) => { if (runs.length && runs.at(-1).name === name) runs.at(-1).days++; else runs.push({name, days: 1, start: ser.issued_at[i]}); });
  const names = [...new Set(owner)], isBase = n => n === r.baseline, order = names.filter(x => !isBase(x));
  const color = n => isBase(n) ? '#94a3b8' : OWNER_COLORS[order.indexOf(n) % OWNER_COLORS.length], label = n => isBase(n) ? '기준 모델' : `파인튜닝 ${n.split('_').at(-1)}번째`;
  return `<div class="owner-bar">${runs.map(x => `<i title="${escape(label(x.name))} · ${escape(x.start)} · ${x.days}일" style="flex:${x.days};background:${color(x.name)}"></i>`).join('')}</div>
    <div class="legend">${[...new Set(owner)].map(n => `<span><i style="background:${color(n)}"></i>${escape(label(n))} ${owner.filter(x => x === n).length}일</span>`).join('')}</div>`;
}

function swapTable(r) {
  const done = r.events.filter(e => e.promoted && e.decision_metrics);
  if (!done.length) return empty('이 실행에서 교체된 모델이 없습니다', '교체되면 그 순간의 WAPE · RMSE · 방향 정확도와 교체 후 실제 성과가 여기에 기록됩니다');
  const rows = done.map(e => {
    const m = e.decision_metrics, af = e.after;
    return [`<b>${escape(e.decided_on)}</b><br><small class="muted">${escape(e.before)} → ${escape(e.candidate)}</small>`,
      `${BASIS[m.basis] || m.basis}<br><small class="muted">${m.n}일${m.better ? '' : ' · <b class="bad-text">지표 악화인데 교체</b>'}</small>`,
      `${arrow(m.champion.wape, m.challenger.wape, 2, '%')}<br><small class="muted">${m.wape_delta <= 0 ? '' : '+'}${num(m.wape_delta, 2)}%p</small>`,
      `${arrow(m.champion.rmse, m.challenger.rmse, 1)}<br><small class="muted">${m.rmse_delta <= 0 ? '' : '+'}${num(m.rmse_delta, 1)}</small>`,
      arrow(m.champion.direction, m.challenger.direction, 0, '%', false),
      af ? `<small class="muted">${escape(af.from_day)} ~ ${escape(af.to_day)} (${af.days}일)</small><br>WAPE ${arrow(af.old.wape, af.new.wape, 2, '%')}<br>RMSE ${arrow(af.old.rmse, af.new.rmse, 1)}` : '<small class="muted">교체 후 기간이 짧아 평가 안 함</small>',
      af ? (af.better ? badge('교체 후 실제로도 좋아짐', 'green') : badge('교체 후 실제로는 나빠짐/혼조', 'red')) : '—',
      e.registry_version ? badge(`${e.registry_version} 저장됨`, 'blue') : '—'];
  });
  return table(['교체 날짜', '교체 근거', 'WAPE 이전 → 이후', 'RMSE 이전 → 이후', '방향 정확도', '교체 후 실제 (이전 모델 → 새 모델)', '사후 판정', '모델 탭'], rows)
    + `<p class="note">교체는 두 지표(WAPE와 RMSE)가 모두 낮아질 때만 일어납니다. 왼쪽 숫자가 교체를 결정한 근거이고, 오른쪽은 교체 후 다음 교체 전까지 같은 예측에 이전 모델을 계속 썼다면 어땠을지를 나중에 계산한 값입니다. 결정 당시에는 좋았어도 국면이 바뀌면 사후에는 나빠질 수 있습니다.</p>`;
}

function eventList(r) {
  if (!r.events.length) return empty('파인튜닝 없음', '구간 내내 기준을 넘지 않았습니다');
  return `<div class="feed">${r.events.map(e => `<div class="feed-row"><time>${escape(e.day)}</time><span>${e.trigger ? ({drift: badge('드리프트', 'amber'), wape: badge('오차', 'red'), both: badge('둘 다', 'red')})[e.trigger] : ''} ${e.cause ? badge(CAUSE[e.cause.kind] || e.cause.kind, 'blue') : ''}</span><span>${e.promoted ? badge('교체', 'green') : badge('유지', 'red')} <small class="muted">${e.decision_metrics ? `WAPE ${num(e.decision_metrics.champion.wape, 1)}→${num(e.decision_metrics.challenger.wape, 1)} · RMSE ${num(e.decision_metrics.champion.rmse, 0)}→${num(e.decision_metrics.challenger.rmse, 0)}` : escape(e.decision || '')}</small>${e.after ? ' ' + badge(e.after.better ? '사후 좋아짐' : '사후 나빠짐', e.after.better ? 'green' : 'red') : ''}</span></div>`).join('')}</div>`;
}

function sloMini(r) {
  const slo = r.slo; if (!slo?.adaptive) return '';
  const row = (name, color, s) => `<div class="slo-mini"><b style="color:${color}">${name}</b><div class="slo-track"><i style="width:${s.attainment}%;background:${s.attainment >= slo.target ? 'var(--green)' : 'var(--red)'}"></i><u style="left:${slo.target}%"></u></div><span>${pct(s.attainment, 1)}</span>${s.budget_left >= 0 ? badge(`버짓 ${num(s.budget_left, 0)}일`, 'green') : badge(`${num(-s.budget_left, 0)}일 초과`, 'red')}</div>`;
  return panel('오차 SLO', row('고정', COLOR.base, slo.fixed)+row('자동', COLOR.tuned, slo.adaptive)+`<p class="note">목표 ${pct(slo.target, 0)} · 막대의 검은 선이 목표</p>`);
}

function signalPanel(r) {
  if (!r.timing) return '';
  return panel('구매 신호 · 매일의 신호와 적중 (자동 서비스)', signalChart(r) + signalCards(r), badge(`신뢰 낮음 ${r.timing.unreliable_days}일`, r.timing.unreliable_days ? 'amber' : 'green'));
}

function periodResult(r) {
  const v = r.verdict, f = r.metrics.fixed, ad = r.metrics.adaptive, ci = v.interval, ser = r.series;
  const text = {no_trigger: ['구간 내내 기존 모델이 경계 안이라 파인튜닝이 한 번도 일어나지 않았습니다', 'neutral'], better: ['자동 파인튜닝을 켠 쪽이 구간 전체에서 확실히 더 정확합니다', 'good'],
    worse: ['자동 파인튜닝을 켠 쪽이 구간 전체에서 오히려 더 나빴습니다', 'bad'], inconclusive: ['구간 전체로 보면 두 쪽의 차이가 통계적으로 구분되지 않습니다', 'neutral']}[v.code];
  const g = Object.fromEntries(METRICS.map(([k,,, , dir]) => [k, gainOf(k, dir, f[k], ad[k])]));
  DELTA_SCALE = Math.max(1, ...Object.values(g).map(Math.abs))*1.15;
  const hero = `<section class="lab-hero ${text[1]}"><div class="lab-kicker">연속 운영 · ${escape(r.start)} ~ ${escape(r.end)} · ${f.n}일 예측 · ${escape(PROMOTION[r.promotion] || '게이트 방식')}${r.shock ? ` · 가상 충격 +${num(r.shock.pct, 0)}%/${r.shock.days}일${r.shock.wave_pct ? ` · 출렁임 ${num(r.shock.wave_pct, 0)}%` : ''}` : ''}</div><h2>${text[0]}</h2>
    <p>자동 파인튜닝 ${v.tunes}회 · 모델 교체 ${v.promoted}회 · 최종 서비스 모델 ${escape(r.final_model)} — WAPE ${pct(f.wape)} → ${pct(ad.wape)} (${v.wape_gain >= 0 ? '−' : '+'}${num(Math.abs(v.wape_gain), 2)}%p)${ci ? `, 95% 구간 ${ci[0] >= 0 ? '+' : ''}${num(ci[0], 2)} ~ ${ci[1] >= 0 ? '+' : ''}${num(ci[1], 2)}%p` : ''}, 자동 쪽이 더 가까웠던 날 ${num(v.win_rate, 0)}%</p></section>`;
  const rows = METRICS.map(([k, name, unit, digits]) => [name, `${num(f[k], digits)}${unit}`, `${num(ad[k], digits)}${unit}`, `${g[k] >= 0 ? '+' : '−'}${num(Math.abs(g[k]), 1)}%`, deltaBar(g[k])]);
  const shadowCell = e => e.shadow ? `${badge(e.shadow.passed ? '통과' : '탈락', e.shadow.passed ? 'green' : 'red')} <small class="muted">${e.shadow.n}일 · WAPE ${pct(e.shadow.champion_wape)} → ${pct(e.shadow.challenger_wape)}${e.shadow.champion ? ` · RMSE ${num(e.shadow.champion.rmse, 1)} → ${num(e.shadow.challenger.rmse, 1)}` : ''}</small>` : '—';
  const events = r.events.length ? table(['날짜', '왜 파인튜닝했나', '학습 윈도우 (기준) → 새 학습 구간', `사전 검증 (직전 ${C().holdout_days}일 WAPE)`, '섀도 검증 (실제 정답)', '결과'], r.events.map(e => [
    (e.days_from_start <= 3 ? `${escape(e.day)}<br>${badge('시작 직후', 'amber')}` : escape(e.day)),
    `${e.trigger ? ({drift: badge('입력 드리프트', 'amber'), wape: badge('오차 초과', 'red'), both: badge('둘 다', 'red')})[e.trigger] : ''} ${causeBadge(e.cause)}<br><small class="muted">KS ${num(e.ks, 2)} / ${num(e.ks_limit, 2)} · WAPE ${pct(e.wape, 1)}</small>`,
    e.reference ? `${escape(e.reference.start)}~${escape(e.reference.end)} → ${escape(e.window_start)}~${escape(e.day)}` : '—',
    `${badge(e.gate_passed ? '통과' : '탈락', e.gate_passed ? 'green' : 'red')} <small class="muted">${pct(e.holdout.serving.wape)} → ${pct(e.holdout.tuned.wape)}</small>`,
    shadowCell(e),
    `${e.promoted ? badge('교체', 'green') : badge('유지', 'red')}<br><small class="muted">${escape(e.decided_on || '')} ${escape(e.decision || '')}</small>`])) : empty('파인튜닝이 일어나지 않았습니다');
  const marks = r.events.map(e => ser.issued_at.indexOf(e.day)).filter(i => i >= 0);
  const swaps = r.events.filter(e => e.promoted).map(e => ser.issued_at.indexOf(e.day)).filter(i => i >= 0);
  const nan = a => a.map(x => x === null ? NaN : x), hasCandidate = !!ser.candidate?.some(x => x !== null);
  const tab = state.svc.resultTab, tabs = [['summary', '요약'], ['forecast', '예측 · 오차'], ['timing', '구매 타이밍'], ['tunes', '파인튜닝 기록'], ['ops', '운영 (SLO · 품질 · 계보 · 알림)']];
  const tabBar = `<div class="segmented result-tabs">${tabs.map(([k, label]) => `<button data-action="svc-tab" data-tab-name="${k}" class="${k === tab ? 'selected' : ''}">${label}</button>`).join('')}</div>`;
  const priceChart = chart([
    {name: '실제 가격', values: ser.actual, color: COLOR.actual, width: 1.8},
    {name: '고정 기준 모델', values: ser.fixed, color: COLOR.base, width: 3, dash: true},
    {name: '자동 파인튜닝 서비스', values: ser.adaptive, color: COLOR.tuned, width: 1.6},
    ...(hasCandidate ? [{name: '파인튜닝 후보 (탈락 포함)', values: nan(ser.candidate), color: '#2563eb', width: 1.2}] : [])], {height: 230, labels: ser.target_date, marks: swaps, markName: '모델 교체', bands: r.shock ? shockBand(ser.target_date, r.shock, r.shock.ramp_end || r.end) : []});
  const wapeChart = chart([
    {name: '고정 기준 모델', values: nan(ser.wape_fixed), color: '#cbd5e1', width: 6},
    {name: '자동 파인튜닝 서비스', values: nan(ser.wape_adaptive), color: COLOR.tuned, width: 1.8},
    ...(ser.wape_candidate?.some(x => x !== null) ? [{name: '파인튜닝 후보', values: nan(ser.wape_candidate), color: '#2563eb', width: 1.6}] : []),
    {name: '1단계 경고 경계', values: ser.wape_fixed.map(() => r.limits?.warn ?? NaN), color: '#f59e0b', dash: true, width: 1.2},
    {name: '2단계 파인튜닝 경계', values: ser.wape_fixed.map(() => r.limits?.tune ?? NaN), color: 'var(--red)', dash: true, width: 1.2}], {height: 190, labels: ser.issued_at, marks, markName: '자동 파인튜닝'});
  const body = {
    summary: `<div class="grid-main"><div>${panel('실제 가격과 모델별 4주 예측', priceChart)}${panel(`최근 ${C().window_days}일 WAPE · 세로선 = 자동 파인튜닝`, wapeChart, r.episodes.length ? badge(`드리프트 구간 ${r.episodes.length}개`, 'amber') : '')}${signalPanel(r)}</div>
      <div><div class="lab-cards compact">${bigMetric('WAPE', '%', 2, f.wape, ad.wape, g.wape)}${bigMetric(`RMSE`, '', 2, f.rmse, ad.rmse, g.rmse)}</div>
      ${sloMini(r)}${panel('서비스 모델 · 파인튜닝', ownerBar(r) + eventList(r))}</div></div>`,
    forecast: `${gapPanels(ser.target_date, ser.actual, [{name: '고정 기준 모델', values: ser.fixed, color: COLOR.base},
      {name: '자동 파인튜닝 서비스', values: ser.adaptive, color: COLOR.tuned}, ...(hasCandidate ? [{name: '파인튜닝 후보', values: ser.candidate, color: '#2563eb', dash: true}] : [])], swaps)}
      ${panel('전체 지표 비교', table(['지표', '고정 기준 모델', '자동 파인튜닝', '개선율', `차이 (막대 끝 = ±${num(DELTA_SCALE, 0)}%)`], rows))}`,
    timing: r.timing ? timingPanels(r) : empty('구매 타이밍 기록 없음'),
    tunes: `${panel('모델 교체 기록 · 교체한 순간의 지표와 교체 후 실제 성과', swapTable(r))}${opsPanels(r, ['causes'])}${panel(`자동 파인튜닝 기록 (${r.events.length}회)`, `<p class="note">2단계: 서비스 모델의 최근 ${C().window_days}일 WAPE가 파인튜닝 경계(${pct(r.limits?.tune, 1)})를 넘거나 최근 ${C().ks_current_days}일이 학습 윈도우와 ${C().confirm_days}일 연속 달라지면 그날까지의 직전 ${r.window_weeks}주로 파인튜닝합니다. 같은 모델은 ${r.cooldown_days}일 안에 다시 학습하지 않습니다.</p>${events}`)}
      ${panel(`1단계 경고 (${(r.warnings || []).length}회)`, (r.warnings || []).length ? table(['시작', '끝', '최고 WAPE', '2단계로 이어짐'], r.warnings.map(w => [escape(w.start), escape(w.end), pct(w.peak, 1), r.events.some(e => e.day >= w.start && e.day <= w.end) ? badge('파인튜닝', 'red') : badge('경고만', 'amber')])) : empty('경고가 없었습니다'))}
      ${servingPanel(r)}`,
    ops: opsPanels(r, ['slo', 'quality', 'lineage', 'notes'])}[tab] || '';
  return `${hero}${tabBar}${body}`;
}

function forecastChart(r) {
  const c = r.context, tuned = c.tuned.some(v => v !== null);
  const nan = a => a.map(v => v === null ? NaN : v);
  return chart([
    {name: '실제 가격', values: c.price, color: COLOR.actual, width: 2.2},
    {name: '기존 모델 4주 예측 (목표일 기준)', values: nan(c.base), color: COLOR.base, width: 3, dash: true},
    ...(tuned ? [{name: '파인튜닝 모델 4주 예측', values: nan(c.tuned), color: COLOR.tuned, width: 1.6}] : [])],
    {height: 250, labels: c.dates, marks: [c.t_index], markName: '시점 T'});
}

function replayHistory(list) {
  if (!list?.length) return '';
  const label = {better: ['개선', 'green'], worse: ['악화', 'red'], inconclusive: ['구분 안 됨', ''], healthy: ['정상', 'green'], no_trigger: ['트리거 없음', 'green']};
  return panel('지난 실행', table(['실행', '종류', '시점 / 구간', '파인튜닝', '판정', 'WAPE', ''], list.slice(0, 6).map(r => {
    const period = r.kind === 'period', a = period ? {base: r.metrics.fixed, tuned: r.metrics.adaptive} : r.metrics.after, [text, color] = label[r.verdict.code];
    return [escape(day(r.at)), period ? badge('연속', 'blue') : badge('단일'), period ? `${escape(r.start)} ~ ${escape(r.end)}` : escape(r.day),
      period ? `${r.verdict.tunes}회 · 교체 ${r.verdict.promoted}회` : r.tuned ? badge('실행', 'amber') : badge('없음'), badge(text, color) + (r.shock ? ' ' + badge('가상 충격', 'amber') : ''),
      a.tuned ? `${pct(a.base.wape)} → ${pct(a.tuned.wape)}` : pct(a.base.wape), `<button class="secondary" data-action="svc-open" data-id="${escape(r.id)}">보기</button>`];
  })));
}

function serviceLab(d) {
  const s = state.svc, st = d.svcStatus;
  if (st.unsupported) return panel('서비스 랩을 쓸 수 없습니다', empty('지원하지 않는 데이터', st.unsupported));
  if (!st.ready) return panel('1. 기준 모델 준비', `<p>서비스 랩은 <b>${escape(st.rules.baseline_cutoff)}까지의 실제 가격만으로 학습한 기준 모델</b>을 "이미 운영 중인 모델"로 놓고, 그 이후 어느 시점에서든 이 모델이 잘 맞는지 확인합니다. 한 번만 학습하면 되고 보통 수십 초 걸립니다.</p>
    <p class="note">${escape(st.rules.reason)}</p><div class="toolbar"><button data-action="svc-baseline" ${state.job ? 'disabled' : ''}>${state.job ? '학습 중…' : '기준 모델 학습'}</button></div>`);
  if (!s.timeline) return `<div class="empty">타임라인 계산 중…</div>`;
  const tl = s.timeline, point = s.run === 'point';
  const tabs = `<div class="segmented"><button data-action="svc-run-type" data-run="period" class="${!point ? 'selected' : ''}">연속 자동 운영</button><button data-action="svc-run-type" data-run="point" class="${point ? 'selected' : ''}">단일 시점 비교</button></div>`;
  const modeTabs = `<div class="segmented"><button data-action="svc-mode" data-mode="drift" class="${s.mode === 'drift' ? 'selected' : ''}">데이터 드리프트 시점 (${tl.episodes.length})</button><button data-action="svc-mode" data-mode="free" class="${s.mode === 'free' ? 'selected' : ''}">자유 시점 선택</button></div>`;
  const intro = point
    ? `${modeTabs}${s.mode === 'drift' ? `<p class="note">학습 윈도우와 ${C().confirm_days}일 연속 달라진 구간입니다. 대표 시점은 그 구간과 이후 ${escape(String(st.rules.episode_follow_days))}일 중 기존 모델 오차가 가장 컸던 날입니다.</p><div id="svc-episodes">${episodeCards(tl, s.day)}</div>` : `<p class="note">${escape(tl.min_date)} ~ ${escape(tl.max_date)} 중 아무 날이나 고를 수 있습니다.</p>`}`
    : `<p class="note">구간을 하루씩 진행하며 감시합니다. 드리프트 구간을 누르면 그 구간(앞 ${C().ks_current_days}일 · 뒤 ${C().episode_follow_days}일 포함)이 선택됩니다.</p><div id="svc-episodes">${episodeCards(tl, null)}</div>`;
  const busy = s.live ? `<div id="svc-live">${liveView()}</div>` : state.job ? `<div class="banner info">파인튜닝과 비교를 실행 중입니다…</div>` : '';
  const result = s.result ? (s.result.kind === 'period' ? periodResult(s.result) : labResult(s.result)) : null;
  return `${panel(point ? '1. 시점 고르기' : '1. 구간 고르기', `${intro}<details class="how"><summary>어떤 윈도우를 보나?</summary><p class="note"> 서비스 모델이 학습한 구간(기준 모델은 ${tl.reference_window.start} ~ ${tl.reference_window.end}, ${C().ks_reference_days}일)과 <u>최근 ${C().ks_current_days}일</u>의 가격 변동 분포를 비교합니다. 고른 시점 앞에서 새로 학습하지 않습니다. "직전 N주"는 드리프트나 오차로 파인튜닝이 시작될 때만 쓰는 학습 구간이고, 파인튜닝 후 교체되면 기준 윈도우도 그 구간으로 바뀝니다.</p></details><div id="svc-controls">${runControls()}</div><div id="svc-picker">${picker()}</div>`, tabs)}
    ${busy}${result ? panel('2. 결과', `<div id="svc-result">${result}</div>`) : panel('2. 결과', empty('아직 실행한 기록이 없습니다', '위에서 구간(또는 시점)을 고르고 실행하세요.'))}
    ${replayHistory(d.svcReplays)}`;
}

/* ----- interaction ----- */
function refreshPicker() {
  const s = state.svc;
  if ($('svc-picker')) $('svc-picker').innerHTML = picker();
  if ($('svc-date')) $('svc-date').value = s.day;
  if ($('svc-slider')) $('svc-slider').value = s.index.get(s.day);
  if ($('svc-start')) $('svc-start').value = s.start;
  if ($('svc-end')) $('svc-end').value = s.end;
  document.querySelectorAll('.episode').forEach(e => e.classList.toggle('selected', s.run === 'point' ? e.dataset.day === s.day : false));
}
function selectDay(day) { state.svc.day = clampDay(day); refreshPicker(); }
const shiftDay = (day, delta) => { const d = new Date(day+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+delta); return d.toISOString().slice(0, 10); };
function setRange(kind, a, b) {
  const s = state.svc, tl = s.timeline, within = d => d < tl.min_date ? tl.min_date : d > tl.max_period_end ? tl.max_period_end : d;
  if (kind === 'all') [a, b] = [tl.min_date, tl.max_period_end];
  if (kind === 'drift') [a, b] = tl.episodes.length ? [shiftDay(tl.episodes[0].start, -C().ks_current_days), shiftDay(tl.episodes.at(-1).end, C().episode_follow_days)] : [tl.min_date, tl.max_period_end];
  [s.start, s.end] = [within(a), within(b)];
  if (s.end <= s.start) s.end = within(shiftDay(s.start, C().ks_current_days));
  refreshPicker();
}
function serviceClick(b) {
  const s = state.svc;
  if (b.dataset.action === 'svc-mode') { s.mode = b.dataset.mode; render(); return true; }
  if (b.dataset.action === 'svc-run-type') { s.run = b.dataset.run; render(); return true; }
  if (b.dataset.action === 'svc-episode') {
    if (s.run === 'period') { const e = s.timeline.episodes.find(x => x.t === b.dataset.day); setRange('custom', shiftDay(e.start, -C().ks_current_days), shiftDay(e.end, C().episode_follow_days)); document.querySelectorAll('.episode').forEach(x => x.classList.toggle('selected', x === b)); }
    else selectDay(b.dataset.day);
    return true;
  }
  if (b.dataset.action === 'svc-tab') { s.resultTab = b.dataset.tabName; render(); return true; }
  if (b.dataset.action === 'svc-range') { setRange(b.dataset.range); return true; }
  if (b.dataset.action === 'svc-open') { s.resultId = b.dataset.id; s.result = null; refresh(); return true; }
  return false;
}
function serviceChartClick(event) {
  const svg = event.target.closest('svg.timeline'); if (!svg) return;
  const s = state.svc, tl = s.timeline, rect = svg.getBoundingClientRect(), W = 900, L = 56, R = 14;
  const i = Math.max(0, Math.min(tl.dates.length-1, Math.round(((event.clientX-rect.left)/rect.width*W-L)/(W-L-R)*(tl.dates.length-1))));
  if (s.run === 'period') {
    const a = s.index.get(s.start), b = s.index.get(s.end);
    if (Math.abs(i-a) <= Math.abs(i-b)) setRange('custom', tl.dates[i], s.end); else setRange('custom', s.start, tl.dates[i]);
    return;
  }
  if (s.mode === 'drift') {
    const near = [...tl.episodes].sort((x, y) => Math.abs(s.index.get(x.t)-i) - Math.abs(s.index.get(y.t)-i))[0];
    if (near) selectDay(near.t);
  } else selectDay(tl.dates[i]);
}
function serviceInput(event) {
  const s = state.svc;
  if (event.target.id === 'svc-slider') selectDay(s.timeline.dates[Number(event.target.value)]);
}
function serviceChange(event) {
  const s = state.svc, id = event.target.id, value = event.target.value;
  if (id === 'svc-date' && value) selectDay(value);
  if (id === 'svc-start' && value) setRange('custom', value, s.end);
  if (id === 'svc-end' && value) setRange('custom', s.start, value);
  if (id === 'svc-window') s.windowWeeks = Number(value);
  if (id === 'svc-eval') s.evalWeeks = Number(value);
  if (id === 'svc-cooldown') s.cooldownDays = Number(value);
  if (id === 'svc-shock-on') {
    const sh = s.shock, d = s.cfg.shock_defaults; sh.on = event.target.checked;
    if (sh.on) { Object.assign(sh, {days: sh.days ?? d.days, pct: sh.pct ?? d.pct, wave_pct: sh.wave_pct ?? d.wave_pct, wave_days: sh.wave_days ?? d.wave_days});
      const mid = new Date((Date.parse(s.start)+Date.parse(s.end))/2).toISOString().slice(0, 10); sh.start = sh.start && sh.start >= s.start && sh.start <= s.end ? sh.start : mid; setShockRange(); }
    render();
  }
  if (id === 'svc-shock-start' && value) { s.shock.start = value; setShockRange(); render(); }
  if (id === 'svc-shock-days') { s.shock.days = Number(value); setShockRange(); render(); }
  if (id === 'svc-shock-pct') { s.shock.pct = Number(value); refreshPicker(); }
  if (id === 'svc-shock-wave') { s.shock.wave_pct = Number(value); refreshPicker(); }
  if (id === 'svc-shock-period') { s.shock.wave_days = Number(value); refreshPicker(); }
  if (id === 'svc-pace') s.pace = Number(value);
  if (id === 'svc-start-model') s.startModel = value;
  if (id === 'svc-promotion') s.promotion = value;
  if (id === 'svc-force') s.force = event.target.checked;
}
async function pollLive() {
  const l = state.svc.live; if (!l) return;
  const r = await api(`/service/live/${l.job}?after=${l.rows.length}`);
  l.rows.push(...r.rows);
  if ($('svc-live')) $('svc-live').innerHTML = liveView();
}
async function runPeriod() {
  const s = state.svc;
  const job = await post('/service/period', {start: s.start, end: s.end, window_weeks: s.windowWeeks, cooldown_days: s.cooldownDays, pace: s.pace, promotion: s.promotion, start_model: s.startModel || null, shock: s.shock.on ? {start: s.shock.start, days: s.shock.days, pct: s.shock.pct, wave_pct: s.shock.wave_pct, wave_days: s.shock.wave_days} : null});
  s.live = {job: job.id, rows: []};
  await waitJob(job.id, j => { s.resultId = j.result.id; s.result = null; return `연속 운영 완료 · 자동 파인튜닝 ${j.result.tunes}회`; }, pollLive);
}
async function runReplay(force) {
  const s = state.svc;
  const job = await post('/service/replay', {date: s.day, window_weeks: s.windowWeeks, eval_weeks: s.evalWeeks, force: force || s.force});
  await waitJob(job.id, j => { s.resultId = j.result.id; s.result = null; return j.result.tuned ? `완료 · 파인튜닝 ${({better: '개선', worse: '악화', inconclusive: '차이 불확실'})[j.result.verdict]}` : '완료 · 기존 모델 정상이라 파인튜닝하지 않았습니다'; });
}

const PAGES = {
  service: ['서비스', 'SERVICE LAB', '시점을 고르면 기존 모델이 그때 잘 맞았는지 판정하고, 부진하면 직전 몇 주로 파인튜닝해 두 모델을 실제 가격으로 비교합니다', serviceLab, ['svcStatus', 'svcReplays', 'jobs', 'svcModels']],
  dashboard: ['대시보드', 'AIOPS CONTROL TOWER', '운영 모델의 서비스 지표와 드리프트 자동대응을 한 화면에서 확인합니다', dashboard, ['metrics', 'models', 'alerts', 'health', 'dataset', 'predictions', 'jobs', 'system', 'series']],
  model: ['모델', 'MLOPS', `학습 → 게이트(검증 WAPE) 통과 시 자동 배포 → MLflow @production`, model, ['models', 'predictions', 'health', 'system']],
  ops: ['로그', 'OPERATIONS', '운영 로그와 작업 기록', ops, ['logs', 'jobs']],
};
const SOURCES = {svcStatus:'/service/status', svcReplays:'/service/replays', svcModels:'/service/models', metrics:() => `/metrics?window=${state.window}`, models:'/models', alerts:'/alerts', health:'/health', dataset:'/datasets', predictions:'/predictions', jobs:'/jobs', logs:'/logs', system:'/system', series:() => `/metrics/series?minutes=${Math.min(state.window/60, 1440)}`};

function render() {
  const [title, eyebrow, description, view] = PAGES[state.tab];
  $('title').textContent = title; $('eyebrow').textContent = eyebrow; $('description').textContent = description;
  document.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b.dataset.tab === state.tab); b.setAttribute('aria-current', b.dataset.tab === state.tab ? 'page' : 'false'); });
  $('content').innerHTML = view(state.data);
}

async function refresh() {
  try {
    const names = [...new Set(['health', ...PAGES[state.tab][4]])];
    const results = await Promise.all(names.map(n => api(typeof SOURCES[n] === 'function' ? SOURCES[n]() : SOURCES[n])));
    names.forEach((n, i) => state.data[n] = results[i]);
    if (state.tab === 'service') await loadService();
    const h = state.data.health;
    $('connection').hidden = true;
    $('status-text').textContent = h.active_model ? `운영 ${h.active_model}` : '운영 모델 없음';
    $('status-dot').className = `dot ${h.status === 'running' ? '' : 'off'}`;
    $('updated').textContent = `갱신 ${new Date().toLocaleTimeString('ko-KR', {hour12:false})}`;
    if (!document.querySelector('#content select:focus, #content input:focus, #content textarea:focus')) render();
  } catch (error) { $('connection').textContent = `연결 실패 · ${error.message}`; $('connection').hidden = false; }
}

async function waitJob(id, done, tick = null) {
  state.job = id; render();
  while (true) {
    await new Promise(r => setTimeout(r, tick ? 600 : 1000));
    if (tick) await tick();
    const job = await api(`/jobs/${id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      state.job = null;
      if (tick) { state.svc.live = null; if (job.status !== 'succeeded') render(); }
      toast(job.status === 'succeeded' ? done(job) : `실패: ${job.error}`);
      await refresh();
      return;
    }
  }
}

document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.dataset.tab) { location.hash = b.dataset.tab; return; }
  if (b.dataset.logFilter) { state.logFilter = b.dataset.logFilter; render(); return; }
  if (b.id === 'refresh') { await refresh(); return; }
  if (b.dataset.window) { state.window = Number(b.dataset.window); await refresh(); return; }
  if (serviceClick(b)) return;
  if (!b.dataset.action && !b.dataset.select) return;
  b.disabled = true;
  try {
    if (b.dataset.action === 'train') { const job = await post('/train', {epochs:40}); await waitJob(job.id, j => `${j.result.version} ${j.result.promoted ? '게이트 통과 · 자동 배포됨' : '게이트 탈락 · 기존 모델 유지'} (${gateText(j.result.gate)})`); }
    if (b.dataset.action === 'svc-baseline') { const job = await post('/service/baseline', {epochs:40}); await waitJob(job.id, j => `기준 모델 ${j.result.name} 준비 완료`); }
    if (b.dataset.action === 'svc-run') await runReplay(false);
    if (b.dataset.action === 'svc-run-period') await runPeriod();
    if (b.dataset.action === 'svc-run-force') await runReplay(true);
    // Blink the forecast (0.5 s) so a re-run with the same value still visibly refreshes.
    if (b.dataset.action === 'predict') { await post('/predict'); state.flash = true; await refresh(); state.flash = false; }
    if (b.dataset.select) { const r = await post(`/models/${b.dataset.select}/select`); toast(`${r.active} 운영 반영 · MLflow v${r.registry.version} @production · 대시보드에서 예측 실행`); await refresh(); }
  } catch (error) { toast(error.message); } finally { b.disabled = false; }
});
document.addEventListener('change', serviceChange);
document.addEventListener('input', serviceInput);
document.addEventListener('click', serviceChartClick);
window.addEventListener('hashchange', () => { state.tab = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'service'; refresh(); });
state.tab = PAGES[location.hash.slice(1)] ? location.hash.slice(1) : 'service';
const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('ko-KR', {hour12:false}); };
tick(); refresh();
setInterval(() => { tick(); if (!document.hidden && !state.job) refresh(); }, 5000);
