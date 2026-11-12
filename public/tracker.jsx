// ─────────────────────────────────────────────────────────────────────────────
// tracker.jsx — 지표추적 탭 (알상무 '지표추적자' 방식)
//   이동평균선 보드 · 오늘의 체크포인트 · 이평선/기준선 차트 · 지지·저항 기준선 관리
//   서버 /api/tracker 가 5·20·60일선, 20주선, 이번 주 주봉 모양을 계산하고
//   지지·저항 기준선은 사용자가 정해 브라우저(localStorage)에 보관한다.
// ─────────────────────────────────────────────────────────────────────────────
const { useState: tState, useMemo: tMemo, useEffect: tEffect, useRef: tRef } = React;

const TRACKER_KEY = 'signalboard-tracker-v1';
const TRK_STOCK = /^(?=.*\d)[0-9A-Z]{6}$/;

// 기본값: 영상(지표추적자 1110)에서 짚은 지표와 선
const TRACKER_DEFAULT = {
  items: [
    { id: 'kospi' }, { id: 'kosdaq' }, { id: 'ixic' }, { id: 'n225' },
    { id: 'usdkrw' }, { id: 'usdjpy' }, { id: 'ktb3' }, { id: 'us10y' },
    { id: 'wti' }, { id: 'gold' },
    { id: '005930', name: '삼성전자' }, { id: '000660', name: 'SK하이닉스' },
    { id: 'btc' }, { id: 'usdidr' }, { id: 'orcl' }, { id: 'softbank' },
  ],
  levels: [
    { id: 'lv1', target: 'kospi', price: 5000, type: 'support', note: '지지 확인 구간', alert: true },
    { id: 'lv2', target: 'kospi', price: 5200, type: 'resistance', note: '반등 목표, 5일선 저항', alert: true },
    { id: 'lv3', target: 'kosdaq', price: 666, type: 'pivot', note: '666 아래 매수, 위 분할매도', alert: true },
    { id: 'lv4', target: 'ixic', price: 26000, type: 'support', note: '20일선·20주선 겹치는 자리', alert: true },
    { id: 'lv5', target: 'n225', price: 60000, type: 'resistance', note: '매물대', alert: true },
    { id: 'lv6', target: 'usdjpy', price: 158, type: 'pivot', note: '2주째 158 횡보', alert: true },
    { id: 'lv7', target: '005930', price: 200000, type: 'resistance', note: '20만원 저항', alert: true },
    { id: 'lv8', target: '000660', price: 1200000, type: 'resistance', note: '120만원 터치 후 밀림', alert: true },
  ],
  selected: 'kospi',
};

const TrackerStore = (() => {
  let state = loadLocal(TRACKER_KEY, null) || TRACKER_DEFAULT;
  const listeners = new Set();
  return {
    get: () => state,
    set(fn) {
      state = typeof fn === 'function' ? fn(state) : fn;
      saveLocal(TRACKER_KEY, state);
      listeners.forEach(l => l());
    },
    reset() { this.set(TRACKER_DEFAULT); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
function useTracker() { return React.useSyncExternalStore(TrackerStore.subscribe, TrackerStore.get); }

const LEVEL_TYPES = { support: '지지', resistance: '저항', pivot: '기준' };
const MA_COLS = [['ma5', '5일'], ['ma20', '20일'], ['ma60', '60일'], ['ma20w', '20주']];
const ALIGN_LABELS = { bull: '정배열', bear: '역배열', mixed: '혼조' };
const SHAPE_LABELS = { upper_wick: '윗꼬리', lower_wick: '아랫꼬리', long_up: '장대양봉', long_down: '장대음봉', up: '양봉', down: '음봉', flat: '보합' };

// 지표추적 전용 추가 지표 (서버가 Yahoo 일봉으로 계산, 실시간 시세 없이 15분 단위 갱신)
const TRK_EXTRA = {
  btc: { name: '비트코인', dec: 0 }, eth: { name: '이더리움', dec: 0 }, usdidr: { name: '달러/루피아', dec: 0 },
  orcl: { name: '오라클', dec: 2 }, nvda: { name: '엔비디아', dec: 2 }, softbank: { name: '소프트뱅크그룹', dec: 0 },
};
const trName = (item, row) => (item && item.name) || (IND_BY_ID[item ? item.id : ''] || TRK_EXTRA[item ? item.id : ''] || {}).name || (row && row.name) || (item && item.id);
const trDec = id => (TRK_STOCK.test(id) ? 0 : IND_BY_ID[id] ? IND_BY_ID[id].dec : TRK_EXTRA[id] ? TRK_EXTRA[id].dec : 2);
const trIsRate = row => row && (row.unit === 'pct' || row.unit === '%');
const trLivePrice = (id, quotes, stocks, row) =>
  quotes[id] && quotes[id].price != null ? quotes[id].price
    : stocks[id] && stocks[id].price != null ? stocks[id].price
    : row ? row.price : null;

// 기준선 대비 현재 위치
function levelStatus(lv, price) {
  if (price == null || !lv.price) return null;
  const above = price >= lv.price;
  const dist = ((price - lv.price) / Math.abs(lv.price)) * 100;
  const text = lv.type === 'support' ? (above ? '지지 위' : '지지 이탈')
    : lv.type === 'resistance' ? (above ? '저항 돌파' : '저항 아래')
    : (above ? '기준선 위' : '기준선 아래');
  const tone = lv.type === 'support' && !above ? 'down' : lv.type === 'resistance' && above ? 'up' : 'neutral';
  return { above, dist, text, tone };
}

// 이평선 이격 표시: 금리는 bp, 나머지는 %
function maGap(pos, row) {
  if (!pos) return '–';
  if (trIsRate(row)) return `${pos.diff >= 0 ? '+' : ''}${Math.round(pos.diff * 100)}bp`;
  return fmtPct(pos.dist_pct, 1);
}
function crossText(pos, weekly) {
  if (!pos || !pos.cross) return '';
  const limit = weekly ? 3 : 5;
  if (pos.cross.ago > limit) return '';
  const when = pos.cross.ago === 0 ? (weekly ? '이번 주' : '오늘') : `${pos.cross.ago}${weekly ? '주' : '일'} 전`;
  return `${when} ${pos.cross.dir === 'up' ? '돌파' : '이탈'}`;
}

function useTrackerData() {
  const tr = useTracker();
  const sample = useLive((s, i) => i.sample);
  const version = useLive(s => (s.series ? s.series.version : 0));
  const tick = useTick(60);
  const ids = tr.items.map(i => i.id);
  const res = useResource(sample || !ids.length ? null : `/api/tracker?ids=${ids.join(',')}`, `${version}:${tick}`);
  const byId = tMemo(() => {
    const m = {};
    for (const it of (res.data && res.data.items) || []) m[it.id] = it;
    return m;
  }, [res.data]);
  return { tr, sample, res, byId };
}

function TrkNeedServer({ height = 160 }) {
  return <ChartEmpty height={height} text="서버에 연결되면 이동평균선 위치를 계산해요" />;
}

// ─── 이동평균선 보드 ──────────────────────────────────────────────────────────
function TrackerBoardPanel({ colors }) {
  const { tr, sample, res, byId } = useTrackerData();
  const quotes = useLive(s => s.quotes);
  const stocks = useLive(s => s.stocks);
  if (sample) return <TrkNeedServer height={300} />;
  if (res.loading && !res.data) return <ChartLoading height={300} />;
  if (!tr.items.length) return <ChartEmpty height={200} text="기준선 관리에서 추적할 지표를 추가하세요" />;
  const tone = v => (v == null || v === 0 ? 'var(--text-2)' : v > 0 ? colors.up : colors.down);
  return (
    <div className="trk-wrap">
      <table className="trk-table">
        <thead>
          <tr>
            <th>지표</th><th>현재가</th>
            {MA_COLS.map(([k, label]) => <th key={k}>{label}선</th>)}
            <th>배열</th><th>이번 주</th><th>가까운 기준선</th>
          </tr>
        </thead>
        <tbody>
          {tr.items.map(item => {
            const row = byId[item.id];
            const name = trName(item, row);
            const sel = tr.selected === item.id;
            const pick = () => TrackerStore.set(s => ({ ...s, selected: item.id }));
            if (!row || row.error) {
              return (
                <tr key={item.id} className={sel ? 'sel' : ''} onClick={pick}>
                  <td className="trk-name">{name}</td>
                  <td colSpan={8} className="trk-muted">{row ? row.error : '불러오는 중…'}</td>
                </tr>
              );
            }
            const price = trLivePrice(item.id, quotes, stocks, row);
            const dec = trDec(item.id);
            const levels = tr.levels.filter(l => l.target === item.id)
              .map(l => ({ l, st: levelStatus(l, price) })).filter(x => x.st)
              .sort((a, b) => Math.abs(a.st.dist) - Math.abs(b.st.dist));
            const near = levels[0];
            const wk = row.week;
            return (
              <tr key={item.id} className={sel ? 'sel' : ''} onClick={pick} title="누르면 아래 차트에 표시">
                <td className="trk-name">{name}{row.stale && <em className="trk-muted"> 지연</em>}</td>
                <td>
                  <b>{fmtNum(price, dec)}</b>
                  <small style={{ color: tone(row.change) }}>{trIsRate(row) ? `${row.change >= 0 ? '+' : ''}${Math.round(row.change * 100)}bp` : fmtPct(row.change_pct)}</small>
                </td>
                {MA_COLS.map(([k]) => {
                  const pos = row.ma[k];
                  const cross = crossText(pos, k === 'ma20w');
                  return (
                    <td key={k} className="trk-ma" title={pos ? `${k === 'ma20w' ? '20주' : k.slice(2) + '일'}선 ${fmtNum(pos.value, dec)}` : '데이터 부족'}>
                      {pos ? <b style={{ color: pos.above ? colors.up : colors.down }}>{pos.above ? '▲' : '▼'} {maGap(pos, row)}</b> : <b className="trk-muted">–</b>}
                      {cross && <small className={pos.cross.dir === 'up' ? 'trk-cross-up' : 'trk-cross-down'} style={{ color: pos.cross.dir === 'up' ? colors.up : colors.down }}>{cross}</small>}
                    </td>
                  );
                })}
                <td><span className="trk-tag">{ALIGN_LABELS[row.alignment] || '–'}</span><small>{row.above_count}/{row.line_count}선 위</small></td>
                <td title={row.ohlc ? '' : '시가·고가·저가가 없는 지표라 일별 종가로 만든 근사 주봉'}>
                  {wk ? <span className={`trk-tag ${wk.shape === 'upper_wick' || wk.shape === 'lower_wick' ? 'hot' : ''}`}>{row.ohlc ? '' : '≈'}{SHAPE_LABELS[wk.shape]}</span> : '–'}
                </td>
                <td>
                  {near ? (
                    <>
                      <b style={{ color: near.st.tone === 'up' ? colors.up : near.st.tone === 'down' ? colors.down : 'var(--text)' }}>{fmtNum(near.l.price, dec)} {near.st.text}</b>
                      <small>{fmtPct(near.st.dist, 1)}</small>
                    </>
                  ) : <span className="trk-muted">–</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── 오늘의 체크포인트 (자동 브리핑) ──────────────────────────────────────────
function buildCheckpoints(tr, byId, quotes, stocks) {
  const out = [];
  for (const item of tr.items) {
    const row = byId[item.id];
    if (!row || row.error) continue;
    const name = trName(item, row);
    const dec = trDec(item.id);
    const price = trLivePrice(item.id, quotes, stocks, row);
    for (const [k, label] of MA_COLS) {
      const pos = row.ma[k];
      const weekly = k === 'ma20w';
      if (!pos || !pos.cross || pos.cross.ago > (weekly ? 1 : 2)) continue;
      const when = pos.cross.ago === 0 ? (weekly ? '이번 주' : '오늘') : `${pos.cross.ago}${weekly ? '주' : '일'} 전`;
      out.push({
        name, prio: weekly ? 3 : k === 'ma60' ? 2.5 : 2, tone: pos.cross.dir === 'up' ? 'up' : 'down',
        msg: `${when} ${label}선 ${pos.cross.dir === 'up' ? '위로 돌파' : '아래로 이탈'} (${label}선 ${fmtNum(pos.value, dec)})`,
      });
    }
    for (const l of tr.levels.filter(x => x.target === item.id)) {
      const st = levelStatus(l, price);
      if (!st || Math.abs(st.dist) > 2) continue;
      out.push({
        name, prio: Math.abs(st.dist) < 0.5 ? 4 : 3.5, tone: st.tone,
        msg: `${fmtNum(l.price, dec)} ${LEVEL_TYPES[l.type]}선 ${st.text} (${fmtPct(st.dist, 1)})${l.note ? ` · ${l.note}` : ''}`,
      });
    }
    // 주 초반(2거래일 이하)엔 이번 주 봉이 아직 의미가 없어 지난주 봉을 본다
    const wk = row.week && row.week.days <= 2 && row.prev_week ? row.prev_week : row.week;
    const wkName = wk === row.week ? '이번 주' : '지난주';
    if (wk && (wk.shape === 'upper_wick' || wk.shape === 'lower_wick')) {
      const pct = Math.round((wk.shape === 'upper_wick' ? wk.upper_wick : wk.lower_wick) * 100);
      out.push({
        name, prio: 1.5, tone: wk.shape === 'upper_wick' ? 'down' : 'up',
        msg: `${wkName} ${row.ohlc ? '' : '(종가 기준) '}${wk.shape === 'upper_wick' ? '윗꼬리' : '아랫꼬리'} ${pct}%${wk.shape === 'upper_wick' ? ' · 위에서 팔렸다' : ' · 아래에서 받쳤다'}`,
      });
    }
  }
  return out.sort((a, b) => b.prio - a.prio);
}

function TrackerBriefPanel({ colors }) {
  const { tr, sample, res, byId } = useTrackerData();
  const quotes = useLive(s => s.quotes);
  const stocks = useLive(s => s.stocks);
  const points = tMemo(() => buildCheckpoints(tr, byId, quotes, stocks), [tr, byId, quotes, stocks]);
  if (sample) return <TrkNeedServer />;
  if (res.loading && !res.data) return <ChartLoading height={180} />;
  if (!points.length) return <ChartEmpty height={160} text="최근 이평선 돌파·이탈이나 기준선 근접이 없어요" />;
  const color = t => (t === 'up' ? colors.up : t === 'down' ? colors.down : 'var(--gauge-mid)');
  return (
    <div className="signals">
      {points.slice(0, 12).map((p, i) => (
        <div key={i} className="signal-row trk-point">
          <span className="signal-dot" style={{ background: color(p.tone) }}></span>
          <span className="signal-label">{p.name}</span>
          <span className="signal-msg">{p.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── 이평선 + 기준선 차트 ─────────────────────────────────────────────────────
const TRK_RANGES = [['1m', '1달', 22], ['3m', '3달', 66], ['6m', '6달', 130]];
const TRK_LINE_COLORS = ['#3B6EF5', '#E5484D', '#F5A623', '#2A9D6E', '#7A5AE0'];
function TrackerChartPanel({ compact, themeKey, colors }) {
  const { tr, sample, res, byId } = useTrackerData();
  const [range, setRange] = tState('3m');
  const id = tr.items.some(i => i.id === tr.selected) ? tr.selected : tr.items[0] && tr.items[0].id;
  const item = tr.items.find(i => i.id === id);
  const row = byId[id];
  const height = compact ? 300 : 360;
  const levels = tMemo(() => tr.levels.filter(l => l.target === id), [tr.levels, id]);
  const view = tMemo(() => {
    if (!row || !row.series) return null;
    const n = TRK_RANGES.find(r => r[0] === range)[2];
    return row.series.slice(-n);
  }, [row, range]);
  if (sample) return <TrkNeedServer height={height} />;
  const dec = trDec(id || '');
  const t = apexTheme(colors);
  const tools = (
    <div className="dl-chart-tools trk-tools">
      <select className="trk-select" value={id || ''} onChange={e => TrackerStore.set(s => ({ ...s, selected: e.target.value }))}>
        {tr.items.map(i => <option key={i.id} value={i.id}>{trName(i, byId[i.id])}</option>)}
      </select>
      <div className="mini-seg">{TRK_RANGES.map(([k, label]) => <button key={k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>{label}</button>)}</div>
      <span className="dl-legend">
        {['종가', '5일', '20일', '60일', '20주'].map((l, i) => <React.Fragment key={l}><i style={{ background: TRK_LINE_COLORS[i] }}></i>{l} </React.Fragment>)}
      </span>
    </div>
  );
  if (!view || view.length < 2) return <div>{tools}{res.loading ? <ChartLoading height={height - 40} /> : <ChartEmpty height={height - 40} text={row && row.error ? row.error : '데이터 없음'} />}</div>;
  const vals = view.map(r => r.close);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.6 || Math.abs(hi) * 0.05;
  // 화면 범위에서 너무 먼 기준선은 그리지 않는다 (축이 눌려 차트가 안 보이는 것 방지)
  const shown = levels.filter(l => l.price >= lo - pad && l.price <= hi + pad);
  const levelColor = l => (l.type === 'support' ? '#2A9D6E' : l.type === 'resistance' ? '#E5484D' : '#8B95A1');
  return (
    <div>
      {tools}
      <ApexBase height={height - 40} deps={[view, levels, id]} rebuildKey={themeKey} build={() => ({
        series: [
          { name: trName(item, row), data: vals },
          { name: '5일선', data: view.map(r => r.ma5) },
          { name: '20일선', data: view.map(r => r.ma20) },
          { name: '60일선', data: view.map(r => r.ma60) },
          { name: '20주선', data: view.map(r => r.ma20w) },
        ],
        chart: { height: '100%', type: 'line', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit', animations: { enabled: false }, zoom: { enabled: false } },
        colors: TRK_LINE_COLORS,
        stroke: { width: [2.2, 1.4, 1.4, 1.4, 1.8], curve: 'straight', dashArray: [0, 0, 0, 0, 5] },
        theme: { mode: t.mode },
        legend: { show: false },
        dataLabels: { enabled: false },
        xaxis: { categories: view.map(r => r.date), tickAmount: 6, labels: { style: { colors: t.text3 }, rotate: 0, formatter: v => (typeof v === 'string' ? v.slice(5).replace('-', '.') : v) }, tooltip: { enabled: false } },
        yaxis: { opposite: true, labels: { formatter: v => (v == null ? '' : fmtNum(v, dec)), style: { colors: t.text3 } } },
        grid: { borderColor: t.line, strokeDashArray: 4 },
        annotations: {
          yaxis: shown.map(l => ({
            y: l.price, borderColor: levelColor(l), strokeDashArray: 3,
            label: { text: `${LEVEL_TYPES[l.type]} ${fmtNum(l.price, dec)}`, position: 'left', textAnchor: 'start', style: { color: '#fff', background: levelColor(l), fontSize: '10px' } },
          })),
        },
        tooltip: { theme: t.mode, shared: true, y: { formatter: v => (v == null ? '–' : fmtNum(v, dec)) } },
      })} />
    </div>
  );
}

// ─── 지지·저항 기준선 + 추적 대상 관리 ────────────────────────────────────────
function TrackerLevelsPanel({ colors }) {
  const { tr, byId, sample } = useTrackerData();
  const quotes = useLive(s => s.quotes);
  const stocks = useLive(s => s.stocks);
  const [form, setForm] = tState({ target: '', price: '', type: 'support', note: '' });
  const [q, setQ] = tState('');
  const [results, setResults] = tState([]);
  const target = tr.items.some(i => i.id === form.target) ? form.target : tr.selected || (tr.items[0] && tr.items[0].id) || '';
  const addable = [
    ...INDICATORS.filter(i => !i.kind && !i.noHistory),
    ...Object.entries(TRK_EXTRA).map(([id, x]) => ({ id, name: `${x.name} (일봉)` })),
  ].filter(i => !tr.items.some(x => x.id === i.id));

  tEffect(() => {
    const term = q.trim();
    if (!term || sample) { setResults([]); return; }
    let alive = true;
    const timer = setTimeout(() => {
      fetchJSON(`/api/stocks/search?q=${encodeURIComponent(term)}`).then(r => alive && setResults(r.slice(0, 6))).catch(() => alive && setResults([]));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, sample]);

  const addLevel = () => {
    const price = parseFloat(String(form.price).replace(/,/g, ''));
    if (!target || !Number.isFinite(price)) return;
    TrackerStore.set(s => ({ ...s, levels: [...s.levels, { id: `lv${Date.now()}`, target, price, type: form.type, note: form.note.trim(), alert: true }] }));
    setForm({ ...form, target, price: '', note: '' });
  };
  const patchLevel = (lid, patch) => TrackerStore.set(s => ({ ...s, levels: s.levels.map(l => (l.id === lid ? { ...l, ...patch } : l)) }));
  const removeLevel = lid => TrackerStore.set(s => ({ ...s, levels: s.levels.filter(l => l.id !== lid) }));
  const addItem = it => {
    if (!it || tr.items.some(x => x.id === it.id) || tr.items.length >= 40) return;
    TrackerStore.set(s => ({ ...s, items: [...s.items, it] }));
    setQ(''); setResults([]);
  };
  const removeItem = id => TrackerStore.set(s => ({ ...s, items: s.items.filter(x => x.id !== id), levels: s.levels.filter(l => l.target !== id) }));
  const itemName = id => trName(tr.items.find(i => i.id === id), byId[id]);

  return (
    <div className="trk-levels">
      <div className="trk-form">
        <select value={target} onChange={e => setForm({ ...form, target: e.target.value })}>
          {tr.items.map(i => <option key={i.id} value={i.id}>{itemName(i.id)}</option>)}
        </select>
        <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
          {Object.entries(LEVEL_TYPES).map(([k, v]) => <option key={k} value={k}>{v}선</option>)}
        </select>
        <input type="text" inputMode="decimal" placeholder="가격" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} onKeyDown={e => e.key === 'Enter' && addLevel()} />
        <input type="text" placeholder="메모 (선택)" value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} onKeyDown={e => e.key === 'Enter' && addLevel()} />
        <button className="primary-btn" onClick={addLevel}>추가</button>
      </div>

      <div className="trk-level-list">
        {!tr.levels.length && <p className="trk-muted">기준선이 없어요. 지지·저항 가격을 넣으면 넘나들 때 알려 드려요.</p>}
        {tr.items.flatMap(item => tr.levels.filter(l => l.target === item.id).sort((a, b) => b.price - a.price).map(l => {
          const st = levelStatus(l, trLivePrice(item.id, quotes, stocks, byId[item.id]));
          const dec = trDec(item.id);
          return (
            <div key={l.id} className="trk-level">
              <span className="trk-level-name">{itemName(item.id)}</span>
              <span className={`trk-tag type-${l.type}`}>{LEVEL_TYPES[l.type]}</span>
              <b className="trk-level-price">{fmtNum(l.price, dec)}</b>
              <span className="trk-level-st" style={{ color: st && st.tone === 'up' ? colors.up : st && st.tone === 'down' ? colors.down : 'var(--text-2)' }}>
                {st ? `${st.text} ${fmtPct(st.dist, 1)}` : '–'}
              </span>
              <span className="trk-level-note" title={l.note}>{l.note}</span>
              <button className={`icon-btn trk-bell ${l.alert ? 'on' : ''}`} title={l.alert ? '넘나들면 알림 (끄기)' : '알림 꺼짐 (켜기)'} onClick={() => patchLevel(l.id, { alert: !l.alert })}>
                <svg width="13" height="13" viewBox="0 0 16 16"><path d="M8 2.2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.8V6.2a4 4 0 0 0-4-4Z M6.4 12.6a1.7 1.7 0 0 0 3.2 0" fill={l.alert ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"></path></svg>
              </button>
              <button className="icon-btn trk-x" title="기준선 삭제" onClick={() => removeLevel(l.id)}>
                <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path></svg>
              </button>
            </div>
          );
        }))}
      </div>

      <div className="trk-items">
        <div className="trk-subhead">추적 대상 <span className="trk-muted">{tr.items.length}/40</span>
          <button className="text-btn" onClick={() => { if (confirm('추적 대상과 기준선을 영상 기본값으로 되돌릴까요?')) TrackerStore.reset(); }}>기본값으로</button>
        </div>
        <div className="trk-chips">
          {tr.items.map(i => (
            <span key={i.id} className="trk-chip">{itemName(i.id)}
              <button title="추적 대상에서 빼기 (기준선도 함께 삭제)" onClick={() => removeItem(i.id)}>×</button>
            </span>
          ))}
        </div>
        <div className="trk-add">
          <select value="" onChange={e => e.target.value && addItem({ id: e.target.value })}>
            <option value="">+ 지표 추가</option>
            {addable.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <div className="watch-search">
            <input type="text" placeholder={sample ? '서버 연결 시 종목 검색' : '+ 종목 검색 (예: 삼성전자)'} value={q} disabled={sample}
                   onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && results[0]) addItem({ id: results[0].code, name: results[0].name }); }} />
            {results.length > 0 && (
              <div className="watch-results">
                {results.map(r => (
                  <button key={r.code} className="watch-result" onClick={() => addItem({ id: r.code, name: r.name })}>
                    <span>{r.name}</span><span className="watch-code">{r.code} · {r.market}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 기준선 돌파/이탈 알림 (App 에서 항상 실행) ───────────────────────────────
// 실시간 시세가 기준선을 '넘는 순간'에만 알린다. 첫 값은 기준 상태로만 기록
function useTrackerAlerts() {
  const tr = useTracker();
  const quotes = useLive(s => s.quotes);
  const stocks = useLive(s => s.stocks);
  const sides = tRef(new Map());
  tEffect(() => {
    for (const l of tr.levels) {
      if (!l.alert) { sides.current.delete(l.id); continue; }
      const q = quotes[l.target] || stocks[l.target];
      if (!q || q.price == null || q.stale) continue;
      const above = q.price >= l.price;
      const was = sides.current.get(l.id);
      sides.current.set(l.id, above);
      if (was == null || was === above) continue;
      const item = tr.items.find(i => i.id === l.target);
      const name = trName(item || { id: l.target }, null);
      const dec = trDec(l.target);
      const title = `${name} ${fmtNum(l.price, dec)} ${LEVEL_TYPES[l.type]}선 ${above ? '상향 돌파' : '하향 이탈'}`;
      const body = `현재 ${fmtNum(q.price, dec)}${l.note ? ` · ${l.note}` : ''}`;
      toast({ title, body });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, tag: l.id });
    }
  }, [quotes, stocks, tr.levels]);
}

// 추적 대상 중 종목코드 (실시간 시세를 받으려고 관심종목 구독에 합친다)
const trackerStockCodes = tr => tr.items.map(i => i.id).filter(id => TRK_STOCK.test(id));

window.TrackerPanels = {
  tracker: TrackerBoardPanel,
  'tracker-brief': TrackerBriefPanel,
  'tracker-chart': TrackerChartPanel,
  'tracker-levels': TrackerLevelsPanel,
};
Object.assign(window, { TrackerStore, useTracker, useTrackerAlerts, trackerStockCodes, levelStatus, buildCheckpoints });
