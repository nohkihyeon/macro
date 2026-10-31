// ─────────────────────────────────────────────────────────────────────────────
// dollar.jsx — 달러 탭: 원/달러 매수 타이밍 (DollarScope 이식 + 확장)
//   종합 판단 · 3년 추세(평균 밴드) · 지표 체크리스트 · 참고 가격대 · 은행 고시 환율
//   분석은 서버(pipeline/dollar.js)가 실시간 시세로 다시 계산해 'dollar' 토픽으로 푸시한다.
// ─────────────────────────────────────────────────────────────────────────────
const { useState: dState, useMemo: dMemo, useContext: dContext } = React;

const TONE_COLORS = { buy: 'var(--ok)', neutral: 'var(--gauge-mid)', wait: 'var(--warn)' };
const SIGNAL_LABELS = { buy: '매수 유리', neutral: '중립', wait: '불리' };
const GROUP_LABELS = { valuation: '가격 매력도', timing: '타이밍', direction: '방향 압력' };
const GROUP_HELP = {
  valuation: '장기 평균·분포 대비 지금 달러가 싼가',
  timing: '단기 과열/과매도와 공포 국면 여부',
  direction: '앞으로 환율을 밀어 올릴 요인이 많은가',
};
const won1 = v => (v == null ? '–' : `${fmtNum(v, 1)}원`);

function useDollar() {
  const sample = useLive((s, i) => i.sample);
  const d = useLive(s => s.dollar);
  const q = useLive(s => s.quotes.usdkrw);
  return { sample, d, q };
}

function ScoreBar({ score, color }) {
  return (
    <div className="dl-scorebar">
      <div className="dl-scorebar-fill" style={{ width: `${score}%`, background: color }}></div>
      <div className="dl-scorebar-marks"><span>매수 자제</span><span>관망</span><span>중립</span><span>분할 매수</span><span>매수 적기</span></div>
    </div>
  );
}

// ─── 종합 판단 ────────────────────────────────────────────────────────────────
function DollarVerdictPanel() {
  const { sample, d, q } = useDollar();
  const ui = dContext(UiContext);
  if (sample) return <NeedServer height={260} />;
  if (!d) return <ChartEmpty height={260} text="환율 3년 히스토리 수집 중…" />;
  const color = TONE_COLORS[d.tone];
  const price = q && q.price != null ? q.price : d.price;
  const ds = d.dollarscope;
  const below = d.levels.filter(l => l.price < price).slice(0, 2);
  const alertBelow = l => ui.addAlert({ target: 'usdkrw', metric: 'price', op: '<=', value: Math.round(l.price * 10) / 10 }, `원/달러 ${won1(l.price)}(${l.label}) 이하로 내려오면 알려드릴게요`);
  return (
    <div className="dl-verdict">
      <div className="dl-left">
        <div className="dl-head">
          <span className="dl-label" style={{ color }}>{d.label}</span>
          <span className="dl-score" style={{ color }}>{d.score}<small>/100</small></span>
        </div>
        <ScoreBar score={d.score} color={color} />
        <p className="dl-advice">{d.advice}</p>
        <div className={`dl-ds ${ds.status === 'BUY' ? 'buy' : 'wait'}`}>
          <b>DollarScope 원칙 · {ds.status}</b>
          <span>현재 {won1(price)} · {d.stats.window} 평균 {won1(ds.avg3y)} 대비 {fmtPct(ds.diff_pct, 1)}</span>
        </div>
        <div className="dl-groups">
          {Object.entries(d.groups).filter(([, v]) => v != null).map(([g, v]) => (
            <div key={g} className="dl-group" title={GROUP_HELP[g]}>
              <span className="board-k">{GROUP_LABELS[g]}</span>
              <div className="fg-track"><div style={{ width: `${v}%`, background: v >= 60 ? 'var(--ok)' : v <= 40 ? 'var(--warn)' : 'var(--gauge-mid)' }}></div></div>
              <span className="fg-v">{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="dl-right">
        <div className="dl-stats">
          {[
            ['현재 환율', won1(price)], [`${d.stats.window} 평균`, won1(d.stats.avg3y)],
            [`${d.stats.window} 백분위`, `하위 ${Math.max(1, Math.round(d.stats.pct3y))}%`], ['200일선', won1(d.stats.ma200)],
            ['52주 범위', `${fmtNum(d.stats.low52w, 0)} ~ ${fmtNum(d.stats.high52w, 0)}`], ['RSI(14)', d.stats.rsi14 != null ? d.stats.rsi14.toFixed(0) : '–'],
          ].map(([k, v]) => <div key={k} className="board-ma-item"><span className="board-k">{k}</span><span className="board-v">{v}</span></div>)}
        </div>
        <ul className="summary dl-summary">{d.summary.map((l, i) => <li key={i}>{l}</li>)}</ul>
        {below.length > 0 && (
          <div className="dl-alerts">
            {below.map(l => <button key={l.label} className="add-btn" onClick={() => alertBelow(l)}>🔔 {fmtNum(l.price, 0)}원({l.label}) 이하 알림</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 3년 추세 + 평균 밴드 (DollarScope 차트) ──────────────────────────────────
const DOLLAR_RANGES = [['1y', '1년', 366], ['3y', '3년', 1096], ['5y', '5년', 1827]];
function DollarChartPanel({ compact, themeKey, colors }) {
  const { sample, d, q } = useDollar();
  const [range, setRange] = dState('3y');
  const version = useLive(s => (s.series ? s.series.version : 0));
  const res = useResource(sample ? null : '/api/history/usdkrw?range=5y', version);
  const height = compact ? 300 : 360;
  const view = dMemo(() => {
    const rows = mergeLiveRows(res.data && res.data.rows, q);
    if (!rows || rows.length < 30) return null;
    const vals = rows.map(r => r.close);
    const ma = vals.map((_, i) => (i >= 199 ? +(vals.slice(i - 199, i + 1).reduce((s, v) => s + v, 0) / 200).toFixed(2) : null));
    const days = DOLLAR_RANGES.find(r => r[0] === range)[2];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const from = Math.max(0, rows.findIndex(r => r.date >= cutoff));
    return { dates: rows.slice(from).map(r => r.date), vals: vals.slice(from), ma: ma.slice(from) };
  }, [res.data, q, range]);
  if (sample) return <NeedServer height={height} />;
  if (!view || !d) return res.loading ? <ChartLoading height={height} /> : <ChartEmpty height={height} />;
  const t = apexTheme(colors);
  const { avg3y, std3y, window: win } = d.stats;
  return (
    <div>
      <div className="dl-chart-tools">
        <div className="mini-seg">{DOLLAR_RANGES.map(([k, label]) => <button key={k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>{label}</button>)}</div>
        <span className="dl-legend"><i style={{ background: '#E5484D' }}></i>{win} 평균 {won1(avg3y)} <i style={{ background: 'rgba(42,157,110,.35)' }}></i>±1σ <i style={{ background: '#F5A623' }}></i>200일선</span>
      </div>
      <ApexBase height={height - 34} deps={[view, d.stats.avg3y]} rebuildKey={themeKey} build={() => ({
        series: [{ name: '원/달러', data: view.vals }, { name: '200일선', data: view.ma }],
        chart: { height: '100%', type: 'line', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit', animations: { enabled: false }, zoom: { enabled: false } },
        colors: ['#3B6EF5', '#F5A623'],
        stroke: { width: [2, 1.6], curve: 'straight', dashArray: [0, 4] },
        theme: { mode: t.mode },
        legend: { show: false },
        dataLabels: { enabled: false },
        xaxis: { categories: view.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: v => (typeof v === 'string' ? v.slice(2, 7).replace('-', '.') : v) } },
        yaxis: { opposite: true, labels: { formatter: v => (v == null ? '' : fmtNum(v, 0)), style: { colors: t.text3 } } },
        grid: { borderColor: t.line, strokeDashArray: 4 },
        annotations: {
          yaxis: [
            { y: avg3y - std3y, y2: avg3y + std3y, fillColor: '#2A9D6E', opacity: 0.08, borderColor: 'transparent' },
            { y: avg3y, borderColor: '#E5484D', strokeDashArray: 5, label: { text: `${win} 평균`, position: 'left', textAnchor: 'start', style: { color: '#fff', background: '#E5484D', fontSize: '10px' } } },
          ],
        },
        tooltip: { theme: t.mode, y: { formatter: v => (v == null ? '–' : `${fmtNum(v, 1)}원`) } },
      })} />
    </div>
  );
}

// ─── 지표 체크리스트 ──────────────────────────────────────────────────────────
function DollarSignalsPanel() {
  const { sample, d } = useDollar();
  if (sample) return <NeedServer height={300} />;
  if (!d) return <ChartEmpty height={300} />;
  return (
    <div className="dl-signals">
      {['valuation', 'timing', 'direction'].map(g => {
        const items = d.components.filter(c => c.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="dl-sig-group">
            <div className="dl-sig-head"><span>{GROUP_LABELS[g]}</span><em>{GROUP_HELP[g]}</em><b>{d.groups[g]}</b></div>
            {items.map(c => (
              <div key={c.id} className="dl-sig-row" title={c.why}>
                <span className={`dl-chip ${c.signal}`}>{SIGNAL_LABELS[c.signal]}</span>
                <div className="dl-sig-body">
                  <span className="dl-sig-label">{c.label}</span>
                  <span className="dl-sig-display">{c.display}</span>
                </div>
                <span className="dl-sig-score">{c.score}</span>
              </div>
            ))}
          </div>
        );
      })}
      <div className="corr-note">점수가 높을수록 지금 달러를 사기에 유리 · 항목에 마우스를 올리면 근거가 보여요 · 정보 제공용이며 투자 판단의 책임은 본인에게 있어요</div>
    </div>
  );
}

// ─── 참고 가격대 ──────────────────────────────────────────────────────────────
function DollarLevelsPanel() {
  const { sample, d, q } = useDollar();
  if (sample) return <NeedServer height={260} />;
  if (!d) return <ChartEmpty height={260} />;
  const price = q && q.price != null ? q.price : d.price;
  const rows = [...d.levels.map(l => ({ ...l, diff_pct: (l.price / price - 1) * 100 })), { label: '현재', price, current: true }]
    .sort((a, b) => b.price - a.price);
  return (
    <div className="dl-levels">
      {rows.map(l => (
        <div key={l.label} className={`dl-level ${l.current ? 'current' : ''}`}>
          <span className="dl-level-label">{l.current ? '● 현재 환율' : l.label}</span>
          <span className="dl-level-price">{won1(l.price)}</span>
          <span className="dl-level-diff">{l.current ? '' : fmtPct(l.diff_pct, 1)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── 은행 고시 환율 ───────────────────────────────────────────────────────────
function DollarBankPanel() {
  const { sample, d } = useDollar();
  if (sample) return <NeedServer height={220} />;
  const b = d && d.bank;
  if (!b) return <ChartEmpty height={220} text="고시 환율 수집 중…" />;
  const spread = v => (v == null ? '' : fmtPct((v / b.base - 1) * 100, 2));
  const pref = rate => b.base + (b.cash_buy - b.base) * (1 - rate);   // 환율 우대: 스프레드를 rate 만큼 깎아 줌
  return (
    <div className="dl-bank">
      {[
        ['매매기준율', b.base, ''], ['현찰 살 때', b.cash_buy, spread(b.cash_buy)], ['현찰 팔 때', b.cash_sell, spread(b.cash_sell)],
        ['송금 보낼 때', b.send, spread(b.send)], ['송금 받을 때', b.receive, spread(b.receive)],
      ].map(([k, v, s]) => (
        <div key={k} className="dl-level"><span className="dl-level-label">{k}</span><span className="dl-level-price">{won1(v)}</span><span className="dl-level-diff">{s}</span></div>
      ))}
      <div className="dl-bank-tip">
        현찰로 1달러 살 때 우대율별 예상: 50% {won1(pref(0.5))} · 90% {won1(pref(0.9))}
        <br />외화통장·송금 기준은 현찰보다 {won1(b.cash_buy - b.send)} 싸요 · {b.date} 고시 (하나은행 기준, 네이버)
      </div>
    </div>
  );
}

window.DollarPanels = {
  'dollar-verdict': DollarVerdictPanel,
  'dollar-chart': DollarChartPanel,
  'dollar-signals': DollarSignalsPanel,
  'dollar-levels': DollarLevelsPanel,
  'dollar-bank': DollarBankPanel,
};
