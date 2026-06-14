// ─────────────────────────────────────────────────────────────────────────────
// charts.jsx
//   · SVG 위젯 차트: LineChart(크로스헤어) · BarChart · Gauge · SectorList  (UI web 원본)
//   · ApexCharts 패널: TreemapChart · MultiLineChart · InvestorsChart · DualChart
//     (macro 이식 — 라이브 /api/* 실패 시 합성 폴백, source 콜백으로 배지 표시)
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

// CSS 변수 읽기 (Apex 테마용)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ─── 라인 차트 ────────────────────────────────────────────────────────────────
function LineChart({ data, height, color, dec, unit, periodKey, indId }) {
  const [wrapRef, W] = useWidth();
  const H = height;
  const [hover, setHover] = useState(null);
  const PAD = { t: 10, b: 22, l: 8, r: 8 };
  const { values, dates } = data;
  const n = values.length;
  const lo = Math.min(...values), hi = Math.max(...values);
  const range = hi - lo || 1;
  const x = i => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - (v - lo) / range) * (H - PAD.t - PAD.b);
  const path = useMemo(() => {
    if (!W) return '';
    let d = `M ${x(0)} ${y(values[0])}`;
    for (let i = 1; i < n; i++) d += ` L ${x(i)} ${y(values[i])}`;
    return d;
  }, [W, values, H]);
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
            <stop offset="0%" stopColor={color} stopOpacity="0.18"></stop>
            <stop offset="100%" stopColor={color} stopOpacity="0"></stop>
          </linearGradient></defs>
          {yTicks.map((tv, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(tv)} y2={y(tv)} className="gridline"></line>
              <text x={W - PAD.r} y={y(tv) - 4} textAnchor="end" className="tick-label">{fmtNum(tv, dec)}</text>
            </g>
          ))}
          <path d={`${path} L ${x(n - 1)} ${H - PAD.b} L ${x(0)} ${H - PAD.b} Z`} fill={`url(#${gid})`}></path>
          <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"></path>
          <text x={PAD.l} y={H - 6} className="tick-label">{fmtDate(dates[0], periodKey)}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick-label">{fmtDate(dates[n - 1], periodKey)}</text>
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair"></line>
              <circle cx={x(hover)} cy={y(hv)} r="4.5" fill={color} stroke="var(--card)" strokeWidth="2"></circle>
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
function BarChart({ data, height, upColor, downColor, periodKey, unit }) {
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

// ─── 업종 등락 리스트 ─────────────────────────────────────────────────────────
function SectorList({ rows, upColor, downColor }) {
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.chg))) || 1;
  const sorted = [...rows].sort((a, b) => b.chg - a.chg);
  return (
    <div className="sector-list">
      {sorted.map(r => (
        <div className="sector-row" key={r.name}>
          <span className="sector-name">{r.name}</span>
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
      ))}
    </div>
  );
}

// ─── ApexCharts 공통 베이스 ───────────────────────────────────────────────────
// build(el) → ApexCharts 인스턴스 옵션. deps 변경 시 재생성.
function ApexBase({ height, build, deps }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!elRef.current || !window.ApexCharts) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    const opts = build();
    if (!opts) return;
    chartRef.current = new ApexCharts(elRef.current, opts);
    chartRef.current.render();
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, deps);
  return <div ref={elRef} style={{ height, width: '100%' }} />;
}

function apexTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    mode: dark ? 'dark' : 'light',
    text3: cssVar('--text-3') || '#8B95A1',
    line: cssVar('--line') || '#E8EAED',
    card: cssVar('--card') || '#fff',
    up: cssVar('--accent') || '#3B6EF5',
  };
}

// ─── 트리맵 (코스피/코스닥 시총) ──────────────────────────────────────────────
function TreemapChart({ market, period, height, themeKey, onSource }) {
  const [series, setSeries] = useState(null);
  useEffect(() => {
    let alive = true;
    setSeries(null);
    fetchJSON(`/api/treemap?market=${market}&period=${period}`)
      .then(d => { if (!alive) return; if (d.source === 'live' && d.series.length) { setSeries(d.series); onSource && onSource('live'); } else throw 0; })
      .catch(() => { if (!alive) return; setSeries(buildSampleTreemap(market)); onSource && onSource('sample'); });
    return () => { alive = false; };
  }, [market, period]);
  const t = apexTheme();
  return series == null
    ? <ChartLoading height={height} />
    : <ApexBase height={height} deps={[series, themeKey]} build={() => ({
        series,
        legend: { show: false },
        chart: { type: 'treemap', height: '100%', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit' },
        theme: { mode: t.mode },
        plotOptions: { treemap: { enableShades: false, distributed: false } },
        stroke: { show: true, width: 2, colors: [t.card] },
        dataLabels: {
          enabled: true, style: { fontSize: '12px', fontWeight: 700, colors: ['#fff'] },
          formatter: (text, op) => {
            const v = op.w.config.series[op.seriesIndex].data[op.dataPointIndex].value;
            return [text, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`];
          },
        },
        tooltip: { theme: t.mode, y: { formatter: (val, o) => {
          const it = o.w.config.series[o.seriesIndex].data[o.dataPointIndex];
          return `시총 ${it.y.toFixed(1)}조 · ${it.value >= 0 ? '+' : ''}${it.value.toFixed(2)}%`;
        } } },
      })} />;
}

// ─── 글로벌 지수 1년 정규화 비교 ──────────────────────────────────────────────
function MultiLineChart({ range, height, themeKey, onSource }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true; setD(null);
    fetchJSON(`/api/global?range=${range}`)
      .then(r => { if (!alive) return; if (r.source === 'live' && r.series.length) { setD(r); onSource && onSource('live'); } else throw 0; })
      .catch(() => { if (!alive) return; setD(buildSampleGlobal()); onSource && onSource('sample'); });
    return () => { alive = false; };
  }, [range]);
  const t = apexTheme();
  const PALETTE = ['#E5484D', '#3B6EF5', '#F5A623', '#2A9D6E', '#7A5AE0', '#E8772E', '#0EA5E9', '#EC4899', '#84CC16', '#64748B'];
  return d == null ? <ChartLoading height={height} /> : <ApexBase height={height} deps={[d, themeKey]} build={() => ({
    series: d.series,
    chart: { type: 'line', height: '100%', toolbar: { show: false }, background: 'transparent', zoom: { enabled: false }, fontFamily: 'inherit' },
    colors: PALETTE,
    stroke: { curve: 'smooth', width: 2 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '12px' },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, type: 'category', tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: v => (v || '').slice(2) } },
    yaxis: { labels: { formatter: v => v.toFixed(0) + '%', style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, y: { formatter: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' } },
  })} />;
}

// ─── 투자자별 누적 순매수 ─────────────────────────────────────────────────────
function InvestorsChart({ height, themeKey, onSource }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true; setD(null);
    fetchJSON('/api/investors')
      .then(r => { if (!alive) return; if (r.source === 'live') { setD(r); onSource && onSource('live'); } else throw 0; })
      .catch(() => { if (!alive) return; setD(buildSampleInvestors()); onSource && onSource('sample'); });
    return () => { alive = false; };
  }, []);
  const t = apexTheme();
  return d == null ? <ChartLoading height={height} /> : <ApexBase height={height} deps={[d, themeKey]} build={() => ({
    series: [
      { name: '개인', data: d.individual }, { name: '외국인', data: d.foreigner },
      { name: '기관', data: d.institution }, { name: '연기금', data: d.pension },
    ],
    chart: { type: 'line', height: '100%', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit' },
    colors: ['#2A9D6E', '#E5484D', '#3B6EF5', '#7A5AE0'],
    stroke: { curve: 'smooth', width: 2.5 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 } },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 } } },
    yaxis: { labels: { formatter: v => v.toFixed(1) + '조', style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, y: { formatter: v => v.toFixed(2) + '조원' } },
  })} />;
}

// ─── 외국인 누적 순매수 vs KOSPI (이중축) ─────────────────────────────────────
function DualChart({ height, themeKey, onSource }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true; setD(null);
    fetchJSON('/api/investors')
      .then(r => { if (!alive) return; if (r.source === 'live' && r.kospi.some(x => x != null)) { setD(r); onSource && onSource('live'); } else throw 0; })
      .catch(() => { if (!alive) return; setD(buildSampleInvestors()); onSource && onSource('sample'); });
    return () => { alive = false; };
  }, []);
  const t = apexTheme();
  return d == null ? <ChartLoading height={height} /> : <ApexBase height={height} deps={[d, themeKey]} build={() => ({
    series: [
      { name: '외국인 누적 순매수', type: 'column', data: d.foreignerCum },
      { name: 'KOSPI 지수', type: 'line', data: d.kospi },
    ],
    chart: { type: 'line', height: '100%', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit' },
    colors: ['rgba(229,72,77,0.55)', '#3B6EF5'],
    stroke: { width: [0, 3], curve: 'smooth' },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 } },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 } } },
    yaxis: [
      { title: { text: '누적 순매수(조)', style: { color: '#E5484D' } }, labels: { formatter: v => v.toFixed(1), style: { colors: t.text3 } } },
      { opposite: true, title: { text: 'KOSPI', style: { color: '#3B6EF5' } }, labels: { formatter: v => v.toFixed(0), style: { colors: t.text3 } } },
    ],
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode },
  })} />;
}

// ─── 투자자 수급 종합 보드 (예시 "외인, N주 연속 매도 중" 재현) ───────────────
// 좌: 4개 누적 순매수 라인 / 우: 외국인 누적 vs KOSPI 이중축 + 자동 헤드라인
// 데이터: ① /api/investors/weekly (주간 집계 라이브, 최근 2년)
//        ② /api/investors (일별 라이브, 최근 1개월) ③ 합성 샘플
function foreignSellStreak(cumForeign, weekly) {
  let neg = 0;
  for (let i = cumForeign.length - 1; i >= 1; i--) {
    if (cumForeign[i] - cumForeign[i - 1] < 0) neg++; else break;
  }
  return weekly ? neg : Math.max(0, Math.round(neg / 5)); // 일별이면 주 환산
}
// 소스별 응답 → 보드 공통 형태 {freq, dates, cum:{4주체}, net?, kospi, streak:{weeks,direction}}
function weeklyAsBoard(r) {
  return { freq: 'weekly', dates: r.dates, cum: r.cum, net: r.net, kospi: r.kospi, streak: r.streak };
}
function dailyAsBoard(r) {
  const weeks = foreignSellStreak(r.foreigner, false);
  const n = r.foreigner.length;
  const lastDiff = r.foreigner[n - 1] - (r.foreigner[n - 2] != null ? r.foreigner[n - 2] : r.foreigner[n - 1]);
  return {
    freq: 'daily', dates: r.dates,
    cum: { individual: r.individual, foreigner: r.foreigner, institution: r.institution, pension: r.pension },
    kospi: r.kospi, streak: { weeks, direction: lastDiff < 0 ? 'sell' : 'buy' },
  };
}
function sampleAsBoard() {
  const s = buildSampleFlowBoard();
  return {
    freq: 'weekly', dates: s.dates,
    cum: { individual: s.individual, foreigner: s.foreigner, institution: s.institution, pension: s.pension },
    kospi: s.kospi, streak: { weeks: foreignSellStreak(s.foreigner, true), direction: 'sell' },
  };
}
// 축 라벨: 'YYYY-MM-DD'→'YY.MM' · 'YY.MM.DD'→'MM.DD' · 그 외 원본
function fbAxisLabel(s) {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(2, 7).replace('-', '.');
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(s)) return s.slice(3);
  return s;
}
function FlowBoardChart({ height, themeKey, onSource }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true; setD(null);
    (async () => {
      try {
        const w = await fetchJSON('/api/investors/weekly?weeks=104');
        if (w && w.source === 'live' && w.cum && w.cum.foreigner && w.cum.foreigner.length > 8) {
          if (alive) { setD(weeklyAsBoard(w)); onSource && onSource('live'); }
          return;
        }
        throw 0;
      } catch (_) { if (!alive) return; }
      try {
        const r = await fetchJSON('/api/investors');
        if (r && r.source === 'live' && r.foreigner && r.foreigner.length > 2) {
          if (alive) { setD(dailyAsBoard(r)); onSource && onSource('live'); }
          return;
        }
        throw 0;
      } catch (_) { if (!alive) return; }
      setD(sampleAsBoard()); onSource && onSource('sample');
    })();
    return () => { alive = false; };
  }, []);
  const t = apexTheme();
  if (d == null) return <ChartLoading height={height} />;
  const { weeks, direction } = d.streak;
  const selling = direction === 'sell';
  const lastNet = d.net ? d.net.foreigner[d.net.foreigner.length - 1] : null;
  const chH = Math.max(220, height - 16);

  const leftBuild = () => ({
    series: [
      { name: '개인', data: d.cum.individual }, { name: '외국인', data: d.cum.foreigner },
      { name: '기관', data: d.cum.institution }, { name: '연기금', data: d.cum.pension },
    ],
    chart: { type: 'line', height: '100%', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit', animations: { enabled: false } },
    colors: ['#2A9D6E', '#E5484D', '#3B6EF5', '#8B95A1'],
    stroke: { curve: 'straight', width: 2 },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '11px', markers: { width: 8, height: 8 } },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: fbAxisLabel } },
    yaxis: { labels: { formatter: v => v.toFixed(0) + '조', style: { colors: t.text3 } } },
    grid: { borderColor: t.line, strokeDashArray: 4 },
    tooltip: { theme: t.mode, y: { formatter: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '조원' } },
  });
  const rightBuild = () => ({
    series: [
      { name: '외국인 누적 순매수', type: 'line', data: d.cum.foreigner },
      { name: 'KOSPI', type: 'line', data: d.kospi },
    ],
    chart: { type: 'line', height: '100%', toolbar: { show: false }, background: 'transparent', fontFamily: 'inherit', animations: { enabled: false } },
    colors: ['#E5484D', '#3B6EF5'],
    stroke: { width: [2, 2], curve: 'straight', dashArray: [5, 0] },
    markers: { size: [2.5, 0], strokeWidth: 0, hover: { sizeOffset: 1 } },
    theme: { mode: t.mode },
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: t.text3 }, fontSize: '11px' },
    dataLabels: { enabled: false },
    xaxis: { categories: d.dates, tickAmount: 8, labels: { style: { colors: t.text3 }, rotate: 0, formatter: fbAxisLabel } },
    yaxis: [
      { seriesName: '외국인 누적 순매수', labels: { formatter: v => v.toFixed(1) + '조', style: { colors: '#E5484D' } }, title: { text: '외국인 누적(조)', style: { color: '#E5484D' } } },
      { opposite: true, seriesName: 'KOSPI', labels: { formatter: v => v.toFixed(0), style: { colors: '#3B6EF5' } }, title: { text: 'KOSPI', style: { color: '#3B6EF5' } } },
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
          <span className="fb-meta">이번 주 {lastNet >= 0 ? '+' : ''}{lastNet.toFixed(2)}조{d.freq === 'weekly' ? '' : ' (일별 환산)'}</span>
        )}
      </div>
      <div className="flowboard-grid">
        <div className="flowboard-cell">
          <div className="flowboard-sub">투자자별 누적 순매수{d.freq === 'weekly' ? ' (주간 · 최근 2년)' : ' (일별 · 최근 1개월)'}</div>
          <ApexBase height={chH} deps={[d, themeKey]} build={leftBuild} />
        </div>
        <div className="flowboard-cell">
          <div className="flowboard-sub">외국인 누적 순매수 vs KOSPI</div>
          <ApexBase height={chH} deps={[d, themeKey]} build={rightBuild} />
        </div>
      </div>
    </div>
  );
}

function ChartLoading({ height }) {
  return <div className="chart-loading" style={{ height }}>
    <span className="spinner"></span> 데이터 불러오는 중…
  </div>;
}

// ── 합성 폴백 빌더 (서버 미가동/실패 시 디자인 유지용) ─────────────────────────
function buildSampleTreemap(market) {
  const seeds = market === 'kosdaq'
    ? [['에코프로비엠', 11, 2.1], ['알테오젠', 7, -1.4], ['HLB', 5, 3.2], ['에코프로', 6, 0.8], ['엔켐', 3, -2.1], ['휴젤', 4, 1.1], ['클래시스', 3, -0.5], ['JYP', 2, 0.9], ['크래프톤', 8, -1.8], ['에스엠', 2, 0.4]]
    : [['삼성전자', 480, 1.2], ['SK하이닉스', 160, 2.4], ['LG에너지솔루션', 95, -1.1], ['삼성바이오', 70, 0.6], ['현대차', 55, -0.8], ['기아', 42, 0.3], ['NAVER', 38, -1.6], ['카카오', 30, 1.9], ['KB금융', 35, 0.5], ['셀트리온', 33, -2.2]];
  return [{ name: market === 'kosdaq' ? '코스닥 상위' : '코스피 상위',
    data: seeds.map(([x, y, value]) => ({ x, y, value, fillColor: value > 0 ? '#E5484D' : value < 0 ? '#3B6EF5' : '#64748B' })) }];
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
  const dates = DATES_5Y.slice(-n).map(d => `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`);
  const acc = (seed, drift, v) => { const r = mulberry32(seed); let s = 0; return Array.from({ length: n }, (_, i) => +(s += drift + (r() - 0.5) * v).toFixed(2)); };
  const foreigner = acc(51, -1.6, 1.2);
  const kbase = genSeries(99, 3050, 3052, 12, n).map(v => +v.toFixed(2));
  return {
    dates, individual: acc(53, 1.5, 1.0), foreigner, institution: acc(52, 0.2, 0.6), pension: acc(54, 0.1, 0.3),
    foreignerCum: foreigner, kospi: kbase,
  };
}

// 2년 주간 수급 보드 샘플 (예시 형태: 외국인 후반 연속 순매도, 기관·개인 누적, KOSPI 상승 발산)
function buildSampleFlowBoard() {
  const n = 104;                       // 2년 주간
  const lateK = 19;                    // 최근 19주 외국인 순매도 (예시: "19주 연속")
  const r = mulberry32(719);
  const dates = [];
  const base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(base); dt.setDate(dt.getDate() - i * 7);
    dates.push(`${String(dt.getFullYear()).slice(2)}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
  }
  const individual = [], foreigner = [], institution = [], pension = [], kospi = [];
  let ai = 0, af = 0, an = 0, ap = 0;
  for (let i = 0; i < n; i++) {
    const late = i >= n - lateK;
    const fNet = late ? -(0.5 + r() * 0.6) : (r() - 0.42) * 0.7;   // 후반 강한 순매도
    const iNet = late ? (0.25 + r() * 0.4) : (r() - 0.45) * 0.5;
    const nNet = (r() - 0.5) * 0.25 + (late ? 0.12 : 0.04);
    const pNet = (r() - 0.5) * 0.12 + 0.03;
    af += fNet; ai += iNet; an += nNet; ap += pNet;
    foreigner.push(+af.toFixed(2)); institution.push(+ai.toFixed(2));
    pension.push(+an.toFixed(2)); individual.push(+(-af * 0.9 + ap + (r() - 0.5)).toFixed(2)); // 개인은 외국인 매도 흡수
    // KOSPI: 전반 약세→후반 강세 (외국인 매도와 발산)
    const prog = i / (n - 1);
    kospi.push(+(2400 + prog * prog * 5200 + Math.sin(i / 9) * 180 + (r() - 0.5) * 120).toFixed(2));
  }
  return { dates, individual, foreigner, institution, pension, foreignerCum: foreigner, kospi, weekly: true };
}

Object.assign(window, {
  LineChart, BarChart, Gauge, SectorList, useWidth,
  TreemapChart, MultiLineChart, InvestorsChart, DualChart, FlowBoardChart, ChartLoading,
});
