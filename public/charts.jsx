// ─────────────────────────────────────────────────────────────────────────────
// charts.jsx
//   · SVG 위젯 차트: LineChart(크로스헤어·전일 기준선·실시간 점) · BarChart · Gauge · SectorList
//   · ApexCharts 패널: Treemap · MultiLine · Investors · Dual · FlowBoard · Candle · YieldCurve
//     (데이터가 바뀌면 다시 만들지 않고 제자리 갱신 → 깜빡임 없음, 테마가 바뀔 때만 재생성)
// ─────────────────────────────────────────────────────────────────────────────
const { useState, useRef, useEffect, useMemo, useCallback } = React;

// 컨테이너 폭 측정 훅
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  const measure = useCallback(() => { if (ref.current) setW(ref.current.clientWidth); }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    let ro = null;
    if (window.ResizeObserver && ref.current) { ro = new ResizeObserver(measure); ro.observe(ref.current); }
    return () => { window.removeEventListener('resize', measure); if (ro) ro.disconnect(); };
  }, []);
  useEffect(measure);
  return [ref, w];
}

// CSS 변수 읽기 (Apex 는 실제 색 문자열이 필요)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function resolveColor(c) {
  const m = /^var\((--[\w-]+)\)$/.exec(c || '');
  return m ? cssVar(m[1]) : c;
}
function mixHex(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
// 등락률 → 색 (0~5% 구간에서 진해짐)
function heatColor(v, up, down, neutral) {
  if (v == null || isNaN(v) || v === 0) return neutral;
  const base = v > 0 ? up : down;
  return mixHex(neutral, base, 0.45 + 0.55 * Math.min(1, Math.abs(v) / 5));
}

function ChartLoading({ height }) {
  return <div className="chart-loading" style={{ height }}><span className="spinner"></span> 데이터 불러오는 중…</div>;
}
function ChartEmpty({ height, text }) {
  return <div className="chart-empty" style={{ height }}>{text || '데이터 없음'}</div>;
}

// ─── 라인 차트 ────────────────────────────────────────────────────────────────
// baseline: 전일 종가 등 기준선 (있으면 선 색이 기준 대비 상승/하락 색) · live: 마지막 점 깜빡임
function LineChart(props) {
  const { data, height } = props;
  if (!data || !data.values || data.values.length < 2) return <ChartEmpty height={height} />;
  return <LineChartInner {...props} />;
}

function LineChartInner({ data, height, color, dec, unit, periodKey, indId, baseline, upColor, downColor, live }) {
  const [wrapRef, W] = useWidth();
  const H = height;
  const [hover, setHover] = useState(null);
  const PAD = { t: 10, b: 22, l: 8, r: 8 };
  const { values, dates } = data;
  const n = values.length;
  let lo = Math.min(...values), hi = Math.max(...values);
  if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
  const range = hi - lo || 1;
  const x = i => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - (v - lo) / range) * (H - PAD.t - PAD.b);
  const stroke = baseline != null && upColor ? (values[n - 1] >= baseline ? upColor : downColor) : color;
  const path = useMemo(() => {
    if (!W) return '';
    let d = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < n; i++) d += ` L ${x(i)} ${y(values[i])}`;
    return d;
  }, [W, values, H, lo, hi]);
  const onMove = useCallback(e => {
    const rect = wrapRef.current.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }, [W, n]);
  const yTicks = [lo + range * 0.15, lo + range * 0.85];
  const gid = `g-${indId}`;
  const hv = hover != null ? values[hover] : null;
  const tipLeft = hover != null && W ? Math.min(Math.max(x(hover), 56), W - 56) : 0;
  return (
    <div ref={wrapRef} className="chart-wrap" style={{ height: H, position: 'relative' }}
         onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {W > 0 && (
        <svg width={W} height={H} style={{ display: 'block' }}>
          <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.18"></stop>
            <stop offset="100%" stopColor={stroke} stopOpacity="0"></stop>
          </linearGradient></defs>
          {yTicks.map((tv, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(tv)} y2={y(tv)} className="gridline"></line>
              <text x={W - PAD.r} y={y(tv) - 4} textAnchor="end" className="tick-label">{fmtNum(tv, dec)}</text>
            </g>
          ))}
          {baseline != null && (
            <g>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(baseline)} y2={y(baseline)} className="baseline"></line>
              <text x={PAD.l + 2} y={y(baseline) < PAD.t + 14 ? y(baseline) + 13 : y(baseline) - 4} className="tick-label">전일 {fmtNum(baseline, dec)}</text>
            </g>
          )}
          <path d={`${path} L ${x(n - 1)} ${H - PAD.b} L ${x(0)} ${H - PAD.b} Z`} fill={`url(#${gid})`}></path>
          <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"></path>
          {live && hover == null && <circle cx={x(n - 1)} cy={y(values[n - 1])} r="3.5" fill={stroke} className="live-dot"></circle>}
          <text x={PAD.l} y={H - 6} className="tick-label">{fmtDate(dates[0], periodKey)}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick-label">{fmtDate(dates[n - 1], periodKey)}</text>
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair"></line>
              <circle cx={x(hover)} cy={y(hv)} r="4.5" fill={stroke} stroke="var(--card)" strokeWidth="2"></circle>
            </g>
          )}
        </svg>
      )}
      {hover != null && (
        <div className="chart-tip" style={{ left: tipLeft }}>
          <span className="tip-date">{fmtDate(dates[hover], periodKey)}</span>
          <span className="tip-val">{fmtNum(hv, dec)}{unit && ` ${unit}`}</span>
        </div>
      )}
    </div>
  );
}

// ─── 막대 차트 ────────────────────────────────────────────────────────────────
function BarChart(props) {
  const { data, height } = props;
  if (!data || !data.values || !data.values.length) return <ChartEmpty height={height} />;
  return <BarChartInner {...props} />;
}

function BarChartInner({ data, height, upColor, downColor, periodKey, unit }) {
  const [wrapRef, W] = useWidth();
  const H = height;
  const [hover, setHover] = useState(null);
  const PAD = { t: 10, b: 22, l: 8, r: 8 };
  const { values, dates } = data;
  const n = values.length;
  const maxAbs = Math.max(...values.map(Math.abs)) || 1;
  const innerW = W - PAD.l - PAD.r;
  const bw = Math.max(1.5, Math.min(14, (innerW / n) * 0.66));
  const x = i => PAD.l + (i + 0.5) * (innerW / n);
  const zero = PAD.t + (H - PAD.t - PAD.b) / 2;
  const yh = v => (Math.abs(v) / maxAbs) * ((H - PAD.t - PAD.b) / 2 - 2);
  const onMove = e => {
    const rect = wrapRef.current.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left - PAD.l) / innerW) * n);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hv = hover != null ? values[hover] : null;
  const tipLeft = hover != null && W ? Math.min(Math.max(x(hover), 70), W - 70) : 0;
  return (
    <div ref={wrapRef} className="chart-wrap" style={{ height: H, position: 'relative' }}
         onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {W > 0 && (
        <svg width={W} height={H} style={{ display: 'block' }}>
          <line x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} className="gridline"></line>
          {values.map((v, i) => (
            <rect key={i} x={x(i) - bw / 2} width={bw}
              y={v >= 0 ? zero - yh(v) : zero} height={Math.max(1, yh(v))}
              rx={bw > 3 ? 1.5 : 0} fill={v >= 0 ? upColor : downColor}
              opacity={hover == null || hover === i ? 0.92 : 0.35}></rect>
          ))}
          <text x={PAD.l} y={H - 6} className="tick-label">{fmtDate(dates[0], periodKey)}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick-label">{fmtDate(dates[n - 1], periodKey)}</text>
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair"></line>}
        </svg>
      )}
      {hover != null && (
        <div className="chart-tip" style={{ left: tipLeft }}>
          <span className="tip-date">{fmtDate(dates[hover], periodKey)}</span>
          <span className="tip-val" style={{ color: hv >= 0 ? upColor : downColor }}>
            {hv >= 0 ? '+' : ''}{fmtNum(hv, 0)} {unit}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── 게이지 ───────────────────────────────────────────────────────────────────
function Gauge({ value, height, upColor, downColor }) {
  const [wrapRef, W] = useWidth();
  const H = height;
  const cx = W / 2, cy = H - 26, R = Math.min(W / 2 - 24, H - 56);
  const a = Math.PI * (1 - value / 100);
  const px = cx + R * Math.cos(a), py = cy - R * Math.sin(a);
  const arc = (from, to, color, key) => {
    const a1 = Math.PI * (1 - from / 100), a2 = Math.PI * (1 - to / 100);
    const x1 = cx + R * Math.cos(a1), y1 = cy - R * Math.sin(a1);
    const x2 = cx + R * Math.cos(a2), y2 = cy - R * Math.sin(a2);
    return <path key={key} d={`M ${x1} ${y1} A ${R} ${R} 0 0 1 ${x2} ${y2}`}
      fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"></path>;
  };
  const label = value < 25 ? '극단적 공포' : value < 45 ? '공포' : value < 55 ? '중립' : value < 75 ? '탐욕' : '극단적 탐욕';
  return (
    <div ref={wrapRef} style={{ height: H, position: 'relative' }}>
      {W > 0 && R > 20 && (
        <svg width={W} height={H} style={{ display: 'block' }}>
          {arc(2, 34, downColor, 'a')}
          {arc(38, 62, 'var(--gauge-mid)', 'b')}
          {arc(66, 98, upColor, 'c')}
          <circle cx={px} cy={py} r="8" fill="var(--card)" stroke="var(--text)" strokeWidth="3"></circle>
          <text x={cx} y={cy - R * 0.32} textAnchor="middle" className="gauge-num">{value}</text>
          <text x={cx} y={cy - R * 0.32 + 24} textAnchor="middle" className="gauge-label">{label}</text>
        </svg>
      )}
    </div>
  );
}

// ─── 업종 등락 리스트 (상위 n · 하위 n) ───────────────────────────────────────
function SectorList({ rows, upColor, downColor, split }) {
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.chg))) || 1;
  const row = r => (
    <div className="sector-row" key={r.name}>
      <span className="sector-name" title={r.name}>{r.name}</span>
      <div className="sector-bar-track">
        <div className="sector-bar" style={{
          width: `${(Math.abs(r.chg) / maxAbs) * 50}%`,
          [r.chg >= 0 ? 'left' : 'right']: '50%',
          background: r.chg >= 0 ? upColor : downColor,
        }}></div>
      </div>
      <span className="sector-chg" style={{ color: r.chg >= 0 ? upColor : downColor }}>
        {r.chg >= 0 ? '+' : ''}{r.chg.toFixed(2)}%
      </span>
    </div>
  );
  const sorted = [...rows].sort((a, b) => b.chg - a.chg);
  return (
    <div className="sector-list">
      {split ? sorted.slice(0, split).map(row) : sorted.map(row)}
      {split && sorted.length > split * 2 && <div className="sector-gap">⋯</div>}
      {split && sorted.slice(Math.max(split, sorted.length - split)).map(row)}
    </div>
  );
}

// ─── ApexCharts 공통 베이스 ───────────────────────────────────────────────────
// 데이터가 바뀌면 updateOptions 로 제자리 갱신, rebuildKey(테마)가 바뀔 때만 다시 만든다
function ApexBase({ height, build, deps, rebuildKey }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const keyRef = useRef(null);
  useEffect(() => {
    if (!elRef.current || !window.ApexCharts) return;
    const opts = build();
    if (!opts) return;
    if (chartRef.current && keyRef.current === rebuildKey) {
      chartRef.current.updateOptions(opts, false, false, false);
      return;
    }
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new ApexCharts(elRef.current, opts);
    chartRef.current.render();
    keyRef.current = rebuildKey;
  }, [...deps, rebuildKey]);
  useEffect(() => () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } }, []);
  return <div ref={elRef} style={{ height, width: '100%' }} />;
}

function apexTheme(colors) {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    mode: dark ? 'dark' : 'light',
    text3: cssVar('--text-3') || '#8B95A1',
    line: cssVar('--line') || '#E8EAED',
    card: cssVar('--card') || '#fff',
    up: resolveColor(colors && colors.up) || '#E5484D',
    down: resolveColor(colors && colors.down) || '#3470E4',
    neutral: dark ? '#3A3F47' : '#A8B0BA',
  };
}
const apexChart = extra => ({ height: '100%', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit', animations: { enabled: false }, ...extra });
// 'YYYY-MM-DD' → 'YY.MM' (긴 기간) / 'MM.DD' (짧은 기간)
const axisDate = long => v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? (long ? v.slice(2, 7).replace('-', '.') : v.slice(5).replace('-', '.')) : v);

// ─── 트리맵 (코스피/코스닥 시총 상위 50) ──────────────────────────────────────
function TreemapChart({ market, weekly, height, themeKey, colors, onSelect }) {
  const sample = useLive((s, i) => i.sample);
  const live = useLive(s => s.treemap[market]);
  const tick = useTick(60);
  const week = useResource(weekly && !sample ? `/api/treemap?market=${market}&period=weekly` : null, tick);

  // 업종별로 묶고 등락률 색을 입힌다 (데이터·테마가 바뀔 때만 다시 계산 → 차트도 그때만 갱신)
  const colored = useMemo(() => {
    let series;
    if (sample) series = buildSampleTreemap(market);
    else if (weekly) series = week.data && week.data.series ? week.data.series : null;
    else if (live && live.length) {
      const groups = new Map();
      for (const s of live) {
        if (!groups.has(s.sector)) groups.set(s.sector, []);
        groups.get(s.sector).push({ x: s.name, y: +(s.market_cap / 10000).toFixed(2), value: s.change_percent, code: s.code });
      }
      series = [...groups].map(([name, data]) => ({ name, data }))
        .sort((a, b) => b.data.reduce((t, d) => t + d.y, 0) - a.data.reduce((t, d) => t + d.y, 0));
    }
    if (!series) return null;
    const t = apexTheme(colors);
    return series.map(g => ({ name: g.name, data: g.data.map(d => ({ ...d, fillColor: heatColor(d.value, t.up, t.down, t.neutral) })) }));
  }, [sample, weekly, live, week.data, themeKey]);

  if (!colored) return weekly && week.loading ? <ChartLoading height={height} /> : <ChartEmpty height={height} text={weekly ? '주간 등락 계산 중…' : '데이터 없음'} />;
  const t = apexTheme(colors);
  return <ApexBase height={height} deps={[colored]} rebuildKey={themeKey} build={() => ({
    series: colored,
    legend: { show: false },
    chart: apexChart({
      type: 'treemap',
      events: { dataPointSelection: (e, ctx, cfg) => {
        const d = colored[cfg.seriesIndex] && colored[cfg.seriesIndex].data[cfg.dataPointIndex];
        if (d && d.code && onSelect) onSelect(d.code, d.x);
      } },
    }),
    theme: { mode: t.mode },
    plotOptions: { treemap: { enableShades: false, distributed: false } },
    stroke: { show: true, width: 2, colors: [t.card] },
    dataLabels: {
      enabled: true, style: { fontSize: '12px', fontWeight: 700, colors: ['#fff'] },
      formatter: (text, op) => {
        const d = op.w.config.series[op.seriesIndex].data[op.dataPointIndex];
        return d.value == null ? text : [text, `${d.value >= 0 ? '+' : ''}${d.value.toFixed(2)}%`];
      },
    },
    tooltip: { theme: t.mode, y: { formatter: (val, o) => {
      const it = o.w.config.series[o.seriesIndex].data[o.dataPointIndex];
      return `시총 ${it.y.toFixed(1)}조 · ${it.value >= 0 ? '+' : ''}${(it.value || 0).toFixed(2)}% · ${o.w.config.series[o.seriesIndex].name}`;
    } } },
  })} />;
}

// ─── 글로벌 지수 정규화 비교 ──────────────────────────────────────────────────
function MultiLineChart({ range, height, themeKey, colors }) {
  const sample = useLive((s, i) => i.sample);
  const version = useLive(s => (s.series ? s.series.version : 0));
  const tick = useTick(120);
  const res = useResource(sample ? null : `/api/global?range=${range}`, `${version}:${tick}`);
  const sampleData = useMemo(() => (sample ? buildSampleGlobal() : null), [sample]);
  const d = sample ? sampleData : res.data && res.data.source === 'live' ? res.data : null;
  if (!d) return res.loading ? <ChartLoading height={height} /> : <ChartEmpty height={height} />;
  const t = apexTheme(colors);
  const PALETTE = ['#E5484D', '#3B6EF5', '#F5A623', '#2A9D6E', '#7A5AE0', '#E8772E', '#0EA5E9', '#EC4899', '#84CC16', '#64748B'];
  const long = range === '1y' || range === '5y';
  return <ApexBase height={height} deps={[d]} rebuildKey={themeKey} build={() => ({
    series: d.series.map(s => ({ name: s.name, data: s.data })),
    chart: apexChart({ type: 'line', zoom: { enabled: false } }),
    colors: PALETTE,
    stroke: { curve: 'straight', width: 2 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '12px' },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, type: 'category', tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: axisDate(long) } },
    yaxis: { labels: { formatter: v => (v == null ? '' : v.toFixed(0) + '%'), style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, y: { formatter: v => (v == null ? '–' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%') } },
  })} />;
}

// 일별 수급 리소스 (누적 라인 · 이중축 공용)
const FLOW_DAYS = { '1d': 5, '1w': 5, '1m': 21, '1y': 250, '5y': 600 };
function useDailyFlows(periodKey) {
  const sample = useLive((s, i) => i.sample);
  const version = useLive(s => (s.series ? s.series.version : 0));
  const flowsDate = useLive(s => (s.boards.KOSPI && s.boards.KOSPI.flows ? `${s.boards.KOSPI.flows.date}:${s.boards.KOSPI.flows.foreign}` : ''));
  const res = useResource(sample ? null : `/api/flows?market=KOSPI&days=${FLOW_DAYS[periodKey] || 30}`, `${version}:${flowsDate}`);
  const sampleData = useMemo(() => (sample ? buildSampleInvestors() : null), [sample]);
  if (sample) return { data: sampleData, loading: false };
  return { data: res.data && res.data.source === 'live' ? res.data : null, loading: res.loading };
}

// ─── 투자자별 누적 순매수 ─────────────────────────────────────────────────────
function InvestorsChart({ periodKey, height, themeKey, colors }) {
  const { data: d, loading } = useDailyFlows(periodKey);
  if (!d) return loading ? <ChartLoading height={height} /> : <ChartEmpty height={height} />;
  const t = apexTheme(colors);
  return <ApexBase height={height} deps={[d]} rebuildKey={themeKey} build={() => ({
    series: [
      { name: '개인', data: d.individual }, { name: '외국인', data: d.foreigner },
      { name: '기관', data: d.institution }, { name: '연기금', data: d.pension },
    ],
    chart: apexChart({ type: 'line' }),
    colors: ['#2A9D6E', '#E5484D', '#3B6EF5', '#7A5AE0'],
    stroke: { curve: 'smooth', width: 2.5 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 } },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: axisDate(d.dates.length > 120) } },
    yaxis: { labels: { formatter: v => v.toFixed(1) + '조', style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, y: { formatter: v => v.toFixed(2) + '조원' } },
  })} />;
}

// ─── 외국인 누적 순매수 vs KOSPI (이중축) ─────────────────────────────────────
function DualChart({ periodKey, height, themeKey, colors }) {
  const { data: d, loading } = useDailyFlows(periodKey);
  if (!d || !d.kospi || !d.kospi.some(x => x != null)) return loading ? <ChartLoading height={height} /> : <ChartEmpty height={height} />;
  const t = apexTheme(colors);
  return <ApexBase height={height} deps={[d]} rebuildKey={themeKey} build={() => ({
    series: [
      { name: '외국인 누적 순매수', type: 'column', data: d.foreignerCum },
      { name: 'KOSPI 지수', type: 'line', data: d.kospi },
    ],
    chart: apexChart({ type: 'line' }),
    colors: ['rgba(229,72,77,0.55)', '#3B6EF5'],
    stroke: { width: [0, 3], curve: 'smooth' },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 } },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: axisDate(d.dates.length > 120) } },
    yaxis: [
      { title: { text: '누적 순매수(조)', style: { color: '#E5484D' } }, labels: { formatter: v => v.toFixed(1), style: { colors: t.text3 } } },
      { opposite: true, title: { text: 'KOSPI', style: { color: '#3B6EF5' } }, labels: { formatter: v => (v == null ? '' : v.toFixed(0)), style: { colors: t.text3 } } },
    ],
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode },
  })} />;
}

// ─── 투자자 수급 종합 보드 (예시 "외인, N주 연속 매도 중" 재현) ───────────────
// 좌: 4개 누적 순매수 라인 / 우: 외국인 누적 vs 지수 이중축 + 자동 헤드라인 (코스피·코스닥 전환)
function FlowBoardChart({ height, themeKey, colors }) {
  const [market, setMarket] = useState('KOSPI');
  const sample = useLive((s, i) => i.sample);
  const version = useLive(s => (s.series ? s.series.version : 0));
  const tick = useTick(300);   // 장중 잠정 수급이 이번 주 막대에 반영되도록 5분마다
  const res = useResource(sample ? null : `/api/flows/weekly?market=${market}&weeks=104`, `${version}:${tick}`);
  const sampleData = useMemo(() => (sample ? buildSampleFlowBoard() : null), [sample]);
  const d = sample ? sampleData : res.data && res.data.source === 'live' ? res.data : null;
  if (!d) return res.loading ? <ChartLoading height={height} /> : <ChartEmpty height={height} />;
  const t = apexTheme(colors);
  const { weeks, direction } = d.streak;
  const selling = direction === 'sell';
  const lastNet = d.net ? d.net.foreigner[d.net.foreigner.length - 1] : null;
  const chH = Math.max(220, height - 16);
  const indexName = market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';

  const leftBuild = () => ({
    series: [
      { name: '개인', data: d.cum.individual }, { name: '외국인', data: d.cum.foreigner },
      { name: '기관', data: d.cum.institution }, { name: '연기금', data: d.cum.pension },
    ],
    chart: apexChart({ type: 'line' }),
    colors: ['#2A9D6E', '#E5484D', '#3B6EF5', '#8B95A1'],
    stroke: { curve: 'straight', width: 2 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '11px', markers: { width: 8, height: 8 } },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: axisDate(true) } },
    yaxis: { labels: { formatter: v => v.toFixed(0) + '조', style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, y: { formatter: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '조원' } },
  });
  const rightBuild = () => ({
    series: [
      { name: '외국인 누적 순매수', type: 'line', data: d.cum.foreigner },
      { name: indexName, type: 'line', data: d.kospi },
    ],
    chart: apexChart({ type: 'line' }),
    colors: ['#E5484D', '#3B6EF5'],
    stroke: { width: [2, 2], curve: 'straight', dashArray: [5, 0] },
    markers: { size: [2.5, 0], strokeWidth: 0, hover: { sizeOffset: 1 } },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '11px' },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: axisDate(true) } },
    yaxis: [
      { seriesName: '외국인 누적 순매수', labels: { formatter: v => v.toFixed(1) + '조', style: { colors: '#E5484D' } }, title: { text: '외국인 누적(조)', style: { color: '#E5484D' } } },
      { opposite: true, seriesName: indexName, labels: { formatter: v => (v == null ? '' : v.toFixed(0)), style: { colors: '#3B6EF5' } }, title: { text: indexName, style: { color: '#3B6EF5' } } },
    ],
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode },
  });

  return (
    <div className="flowboard">
      <div className="flowboard-headline">
        {weeks > 0 ? (
          selling
            ? <>외인, <span className="fb-streak">{weeks}주 연속</span> 순매도 중</>
            : <>외인, <span className="fb-buy">{weeks}주 연속</span> 순매수 중</>
        ) : <>외국인 수급 혼조</>}
        {lastNet != null && (
          <span className="fb-meta">이번 주 {lastNet >= 0 ? '+' : ''}{lastNet.toFixed(2)}조{d.provisional ? ' (장중 잠정 포함)' : ''}</span>
        )}
        {!sample && (
          <span className="mini-seg">
            {['KOSPI', 'KOSDAQ'].map(m => (
              <button key={m} className={market === m ? 'active' : ''} onClick={() => setMarket(m)}>{m === 'KOSPI' ? '코스피' : '코스닥'}</button>
            ))}
          </span>
        )}
      </div>
      <div className="flowboard-grid">
        <div className="flowboard-cell">
          <div className="flowboard-sub">투자자별 누적 순매수 (주간 · 최근 2년)</div>
          <ApexBase height={chH} deps={[d]} rebuildKey={themeKey} build={leftBuild} />
        </div>
        <div className="flowboard-cell">
          <div className="flowboard-sub">외국인 누적 순매수 vs {indexName}</div>
          <ApexBase height={chH} deps={[d]} rebuildKey={themeKey} build={rightBuild} />
        </div>
      </div>
    </div>
  );
}

// ─── 캔들 차트 (종목 상세) ────────────────────────────────────────────────────
function CandleChart({ rows, height, themeKey, colors }) {
  if (!rows || rows.length < 2) return <ChartEmpty height={height} />;
  const t = apexTheme(colors);
  const data = rows.map(r => ({ x: new Date(`${r.date}T00:00:00`).getTime(), y: [r.open, r.high, r.low, r.close] }));
  return <ApexBase height={height} deps={[rows]} rebuildKey={themeKey} build={() => ({
    series: [{ name: '시세', data }],
    chart: apexChart({ type: 'candlestick' }),
    theme: { mode: t.mode },
    plotOptions: { candlestick: { colors: { upward: t.up, downward: t.down }, wick: { useFillColor: true } } },
    xaxis: { type: 'datetime', labels: { style: { colors: t.text3 }, datetimeUTC: false, format: 'MM.dd' } },
    yaxis: { tooltip: { enabled: true }, labels: { formatter: v => fmtNum(v, 0), style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, x: { format: 'yyyy.MM.dd' } },
  })} />;
}

// ─── 국채 수익률 곡선 (한국 vs 미국) ──────────────────────────────────────────
// x 는 만기 순번(0=1년 … 5=30년) — 없는 만기는 건너뛰고 선을 잇는다
function YieldCurveChart({ tenors, kr, us, height, themeKey, colors }) {
  const t = apexTheme(colors);
  const points = values => values.map((y, x) => (y == null ? null : { x, y })).filter(Boolean);
  return <ApexBase height={height} deps={[kr, us]} rebuildKey={themeKey} build={() => ({
    series: [{ name: '한국 국고채', data: points(kr) }, { name: '미국 국채', data: points(us) }],
    chart: apexChart({ type: 'line' }),
    colors: ['#E5484D', '#3B6EF5'],
    stroke: { curve: 'straight', width: 2.5 },
    markers: { size: 4, strokeWidth: 0 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '11px' },
    dataLabels: { enabled: false },
    xaxis: { type: 'numeric', min: 0, max: tenors.length - 1, tickAmount: tenors.length - 1,
      labels: { style: { colors: t.text3 }, formatter: v => tenors[Math.round(v)] || '' }, tooltip: { enabled: false } },
    yaxis: { labels: { formatter: v => (v == null ? '' : v.toFixed(2) + '%'), style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, x: { formatter: v => `만기 ${tenors[Math.round(v)]}` }, y: { formatter: v => (v == null ? '–' : v.toFixed(3) + '%') } },
  })} />;
}

// ── 합성 폴백 빌더 (서버에 연결할 수 없을 때 디자인 유지용) ─────────────────────
function buildSampleTreemap(market) {
  const seeds = market === 'KOSDAQ'
    ? [['에코프로비엠', 11, 2.1], ['알테오젠', 7, -1.4], ['HLB', 5, 3.2], ['에코프로', 6, 0.8], ['엔켐', 3, -2.1], ['휴젤', 4, 1.1], ['클래시스', 3, -0.5], ['JYP', 2, 0.9], ['크래프톤', 8, -1.8], ['에스엠', 2, 0.4]]
    : [['삼성전자', 480, 1.2], ['SK하이닉스', 160, 2.4], ['LG에너지솔루션', 95, -1.1], ['삼성바이오', 70, 0.6], ['현대차', 55, -0.8], ['기아', 42, 0.3], ['NAVER', 38, -1.6], ['카카오', 30, 1.9], ['KB금융', 35, 0.5], ['셀트리온', 33, -2.2]];
  return [{ name: market === 'KOSDAQ' ? '코스닥 상위' : '코스피 상위', data: seeds.map(([x, y, value]) => ({ x, y, value })) }];
}
function buildSampleGlobal() {
  const names = [['코스피', 11, 26], ['니케이', 12, 17], ['코스닥', 13, 12], ['S&P500', 14, 22], ['나스닥', 15, 28], ['항셍', 16, -4], ['독일 DAX', 17, 19], ['다우', 18, 14]];
  const dates = DATES_5Y.slice(-252).map(d => d.toISOString().slice(0, 10));
  const series = names.map(([name, seed, end]) => ({ name, data: genSeries(seed, 0, end, Math.abs(end) / 20 + 0.5, 252).map(v => +v.toFixed(2)) }))
    .sort((a, b) => b.data[b.data.length - 1] - a.data[a.data.length - 1]);
  return { dates, series };
}
function buildSampleInvestors() {
  const n = 30;
  const dates = DATES_5Y.slice(-n).map(d => d.toISOString().slice(0, 10));
  const acc = (seed, drift, v) => { const r = mulberry32(seed); let s = 0; return Array.from({ length: n }, () => +(s += drift + (r() - 0.5) * v).toFixed(2)); };
  const foreigner = acc(51, -1.6, 1.2);
  const kbase = genSeries(99, 3050, 3052, 12, n).map(v => +v.toFixed(2));
  return {
    dates, individual: acc(53, 1.5, 1.0), foreigner, institution: acc(52, 0.2, 0.6), pension: acc(54, 0.1, 0.3),
    foreignerCum: foreigner, kospi: kbase,
  };
}
// 2년 주간 수급 보드 샘플 (예시 형태: 외국인 후반 연속 순매도, 기관·개인 누적, KOSPI 상승 발산)
function buildSampleFlowBoard() {
  const n = 104, lateK = 19;
  const r = mulberry32(719);
  const dates = [];
  const base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(base); dt.setDate(dt.getDate() - i * 7);
    dates.push(dt.toISOString().slice(0, 10));
  }
  const individual = [], foreigner = [], institution = [], pension = [], kospi = [];
  let ai = 0, af = 0, an = 0, ap = 0;
  for (let i = 0; i < n; i++) {
    const late = i >= n - lateK;
    af += late ? -(0.5 + r() * 0.6) : (r() - 0.42) * 0.7;
    ai += late ? (0.25 + r() * 0.4) : (r() - 0.45) * 0.5;
    an += (r() - 0.5) * 0.25 + (late ? 0.12 : 0.04);
    ap += (r() - 0.5) * 0.12 + 0.03;
    foreigner.push(+af.toFixed(2)); institution.push(+ai.toFixed(2));
    pension.push(+an.toFixed(2)); individual.push(+(-af * 0.9 + ap + (r() - 0.5)).toFixed(2));
    const prog = i / (n - 1);
    kospi.push(+(2400 + prog * prog * 5200 + Math.sin(i / 9) * 180 + (r() - 0.5) * 120).toFixed(2));
  }
  return { dates, cum: { individual, foreigner, institution, pension }, kospi, streak: { weeks: lateK, direction: 'sell' } };
}

Object.assign(window, {
  LineChart, BarChart, Gauge, SectorList, useWidth, cssVar, resolveColor, heatColor, apexTheme,
  TreemapChart, MultiLineChart, InvestorsChart, DualChart, FlowBoardChart, CandleChart, YieldCurveChart,
  ChartLoading, ChartEmpty, ApexBase,
});
