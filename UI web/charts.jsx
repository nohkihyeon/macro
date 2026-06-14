// 차트 컴포넌트: LineChart(크로스헤어), BarChart, Gauge, SectorList
const { useState, useRef, useEffect, useMemo, useCallback } = React;

// 컨테이너 폭 측정 훅 (RO + resize + 매 렌더 보정)
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  const measure = useCallback(() => {
    if (ref.current) setW(ref.current.clientWidth);
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    let ro = null;
    if (window.ResizeObserver && ref.current) {
      ro = new ResizeObserver(measure);
      ro.observe(ref.current);
    }
    return () => { window.removeEventListener('resize', measure); if (ro) ro.disconnect(); };
  }, []);
  useEffect(measure); // 밀도 변경 등 레이아웃 변화 보정 (동일 값이면 no-op)
  return [ref, w];
}

// ─── 라인 차트 (크로스헤어 + 영역 그라디언트) ─────────────────
function LineChart({ data, height, color, dec, unit, periodKey, indId }) {
  const [wrapRef, W] = useWidth();
  const H = height;
  const [hover, setHover] = useState(null); // index
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
    const px = e.clientX - rect.left;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }, [W, n]);

  // 눈금 (y축 2개, x축 양끝)
  const yTicks = [lo + range * 0.15, lo + range * 0.85];
  const gid = `g-${indId}`;
  const hv = hover != null ? values[hover] : null;
  const tipLeft = hover != null && W ? Math.min(Math.max(x(hover), 56), W - 56) : 0;

  return (
    <div ref={wrapRef} className="chart-wrap" style={{ height: H, position: 'relative' }}
         onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {W > 0 && (
        <svg width={W} height={H} style={{ display: 'block' }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18"></stop>
              <stop offset="100%" stopColor={color} stopOpacity="0"></stop>
            </linearGradient>
          </defs>
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

// ─── 막대 차트 (수급 순매수, +/-) ────────────────────────────
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
    const px = e.clientX - rect.left;
    const i = Math.floor(((px - PAD.l) / innerW) * n);
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
              rx={bw > 3 ? 1.5 : 0}
              fill={v >= 0 ? upColor : downColor}
              opacity={hover == null || hover === i ? 0.92 : 0.35}></rect>
          ))}
          <text x={PAD.l} y={H - 6} className="tick-label">{fmtDate(dates[0], periodKey)}</text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="tick-label">{fmtDate(dates[n - 1], periodKey)}</text>
          {hover != null && (
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair"></line>
          )}
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

// ─── 게이지 (공포·탐욕) ─────────────────────────────────────
function Gauge({ value, height, upColor, downColor }) {
  const [wrapRef, W] = useWidth();
  const H = height;
  const cx = W / 2, cy = H - 26, R = Math.min(W / 2 - 24, H - 56);
  const a = Math.PI * (1 - value / 100); // 180°→0°
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

// ─── 업종별 등락 리스트 ─────────────────────────────────────
function SectorList({ rows, upColor, downColor, compact }) {
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.chg)));
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

Object.assign(window, { LineChart, BarChart, Gauge, SectorList, useWidth });
