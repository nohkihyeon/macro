// ─────────────────────────────────────────────────────────────────────────────
// panels.jsx — 실시간 스토어를 읽는 패널 위젯 · 종목 상세 모달 · 알림
//   지수 보드 · 시장 폭 · 거래대금/테마 · 프로그램 매매 · 수익률 곡선 · 공포탐욕
//   MacroScore · 위험 신호 · 시장 요약 · 상관/베타 · 관심종목
// ─────────────────────────────────────────────────────────────────────────────
const { useState: pState, useEffect: pEffect, useMemo: pMemo, useRef: pRef, useContext: pContext } = React;

// 앱 전역 동작 (종목 상세 열기 · 관심종목) — App 이 값을 채운다
const UiContext = React.createContext({ openStock() {}, watch: [], addWatch() {}, removeWatch() {}, addAlert() {} });

const LEVEL_COLORS = { ok: '#16A34A', warn: '#D97706', danger: '#DC2626', na: 'var(--text-3)' };
const LEVEL_LABELS = { ok: '정상', warn: '주의', danger: '경고', na: '확인 불가' };
const signColor = (v, colors) => (v == null || v === 0 ? 'var(--text-2)' : v > 0 ? colors.up : colors.down);
const tradingEok = v => (v == null ? null : v / 100);   // 백만원 → 억원

function NeedServer({ height = 160 }) {
  return <ChartEmpty height={height} text="서버 연결 시 실시간 데이터가 표시돼요" />;
}

// ─── 지수 보드 (52주 위치 · 낙폭 · 이평 · 변동성 · 수급) ───────────────────────
function IndexBoardPanel({ market, colors }) {
  const sample = useLive((s, i) => i.sample);
  const b = useLive(s => s.boards[market]);
  if (sample) return <NeedServer />;
  if (!b || b.quote.price == null) return <ChartEmpty height={180} />;
  const price = b.quote.price;
  const pos = b.range_position;
  const f = b.flows;
  return (
    <div className="board">
      {b.low_52w != null && (
        <div className="board-range">
          <div className="board-range-labels"><span>52주 최저 {fmtNum(b.low_52w, 2)}</span><span>최고 {fmtNum(b.high_52w, 2)}</span></div>
          <div className="board-range-track">
            <div className="board-range-fill" style={{ width: `${(pos || 0) * 100}%` }}></div>
            <div className="board-range-marker" style={{ left: `${(pos || 0) * 100}%` }}></div>
          </div>
          <div className="board-range-sub">52주 범위의 {pos != null ? Math.round(pos * 100) : '–'}% 위치 · 고점 대비 <b style={{ color: signColor(b.drawdown_pct, colors) }}>{fmtPct(b.drawdown_pct, 1)}</b></div>
        </div>
      )}
      <div className="board-ma">
        {['ma5', 'ma20', 'ma60', 'ma120'].map(k => {
          const v = b.ma[k];
          const above = v != null && price >= v;
          return (
            <div key={k} className="board-ma-item">
              <span className="board-k">{k.slice(2)}일선</span>
              <span className="board-v">{fmtNum(v, 0)}</span>
              {v != null && <span className="board-chip" style={{ color: above ? colors.up : colors.down }}>{above ? '위' : '아래'}</span>}
            </div>
          );
        })}
      </div>
      <div className="board-rows">
        <div><span className="board-k">실현변동성(20일)</span><span>{b.rv20 != null ? `${b.rv20.toFixed(1)}%` : '–'}{b.rv_pct != null && <em> · 1년 백분위 {Math.round(b.rv_pct)}</em>}</span></div>
        {b.breadth && <div><span className="board-k">등락 종목</span><span><b style={{ color: colors.up }}>▲{b.breadth.rising + b.breadth.upper}</b> · <b style={{ color: colors.down }}>▼{b.breadth.falling + b.breadth.lower}</b> · 보합 {b.breadth.unchanged}</span></div>}
        {b.program && <div><span className="board-k">프로그램 순매수</span><span style={{ color: signColor(b.program.total, colors) }}>{fmtEok(b.program.total, true)}</span></div>}
        {b.trading_value != null && <div><span className="board-k">거래대금</span><span>{fmtEok(tradingEok(b.trading_value))}</span></div>}
      </div>
      {f && (
        <div className="board-flows" title={f.date ? `${f.date} 기준 (장중에는 잠정치)` : ''}>
          {[['외국인', f.foreign], ['기관', f.institution], ['개인', f.individual]].map(([k, v]) => (
            <div key={k} className="board-ma-item">
              <span className="board-k">{k}</span>
              <span className="board-v" style={{ color: signColor(v, colors) }}>{fmtEok(v, true)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 시장 폭 · 52주 신고가/신저가 ─────────────────────────────────────────────
function BreadthPanel({ colors }) {
  const sample = useLive((s, i) => i.sample);
  const boards = useLive(s => s.boards);
  if (sample) return <NeedServer />;
  const rows = ['KOSPI', 'KOSDAQ'].map(m => [m, boards[m]]).filter(([, b]) => b && b.breadth);
  if (!rows.length) return <ChartEmpty height={180} />;
  return (
    <div className="breadth">
      {rows.map(([m, b]) => {
        const br = b.breadth;
        const up = br.rising + br.upper, down = br.falling + br.lower, total = up + down + br.unchanged || 1;
        return (
          <div key={m} className="breadth-block">
            <div className="breadth-head">
              <span className="breadth-name">{m === 'KOSPI' ? '코스피' : '코스닥'}</span>
              <span className="breadth-adr">상승 비율 <b>{Math.round((up / (up + down || 1)) * 100)}%</b></span>
            </div>
            <div className="breadth-bar">
              <div style={{ width: `${(up / total) * 100}%`, background: colors.up }}></div>
              <div style={{ width: `${(br.unchanged / total) * 100}%`, background: 'var(--line)' }}></div>
              <div style={{ width: `${(down / total) * 100}%`, background: colors.down }}></div>
            </div>
            <div className="breadth-nums">
              <span style={{ color: colors.up }}>상승 {up.toLocaleString('ko-KR')}{br.upper ? ` (상한 ${br.upper})` : ''}</span>
              <span>보합 {br.unchanged}</span>
              <span style={{ color: colors.down }}>하락 {down.toLocaleString('ko-KR')}{br.lower ? ` (하한 ${br.lower})` : ''}</span>
            </div>
            {b.highs != null && (
              <div className="breadth-hl">52주 신고가 <b style={{ color: colors.up }}>{b.highs}</b> · 신저가 <b style={{ color: colors.down }}>{b.lows}</b></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── 거래대금 상위 ────────────────────────────────────────────────────────────
function MoversPanel({ colors }) {
  const [market, setMarket] = pState('KOSPI');
  const sample = useLive((s, i) => i.sample);
  const list = useLive(s => s.movers[market]);
  const ui = pContext(UiContext);
  if (sample) return <NeedServer />;
  return (
    <div className="rank">
      <div className="mini-seg rank-seg">
        {['KOSPI', 'KOSDAQ'].map(m => <button key={m} className={market === m ? 'active' : ''} onClick={() => setMarket(m)}>{m === 'KOSPI' ? '코스피' : '코스닥'}</button>)}
      </div>
      {!list || !list.length ? <ChartEmpty height={160} /> : list.map((s, i) => (
        <button key={s.code} className="rank-row" onClick={() => ui.openStock(s.code, s.name)}>
          <span className="rank-no">{i + 1}</span>
          <span className="rank-name">{s.name}</span>
          <span className="rank-sub">{fmtEok(tradingEok(s.trading_value))}</span>
          <span className="rank-chg" style={{ color: signColor(s.change_percent, colors) }}>{fmtPct(s.change_percent)}</span>
        </button>
      ))}
    </div>
  );
}

// ─── 테마 상위 ────────────────────────────────────────────────────────────────
function ThemesPanel({ colors }) {
  const sample = useLive((s, i) => i.sample);
  const themes = useLive(s => s.themes);
  if (sample) return <NeedServer />;
  if (!themes || !themes.length) return <ChartEmpty height={180} />;
  return (
    <div className="rank">
      {themes.slice(0, 10).map((g, i) => (
        <div key={g.no} className="rank-row static">
          <span className="rank-no">{i + 1}</span>
          <span className="rank-name">{g.name}</span>
          <span className="rank-sub"><span style={{ color: colors.up }}>▲{g.rising}</span> <span style={{ color: colors.down }}>▼{g.falling}</span></span>
          <span className="rank-chg" style={{ color: signColor(g.change, colors) }}>{fmtPct(g.change)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── 프로그램 매매 (억원) ─────────────────────────────────────────────────────
function ProgramPanel({ colors }) {
  const sample = useLive((s, i) => i.sample);
  const boards = useLive(s => s.boards);
  if (sample) return <NeedServer />;
  const rows = ['KOSPI', 'KOSDAQ'].map(m => [m, boards[m] && boards[m].program]).filter(([, p]) => p);
  if (!rows.length) return <ChartEmpty height={160} />;
  const all = rows.flatMap(([, p]) => [p.arbitrage, p.non_arbitrage, p.total]).filter(v => v != null);
  const max = Math.max(...all.map(Math.abs)) || 1;
  const bar = (label, v) => (
    <div className="prog-row" key={label}>
      <span className="prog-k">{label}</span>
      <div className="sector-bar-track">
        {v != null && <div className="sector-bar" style={{ width: `${(Math.abs(v) / max) * 50}%`, [v >= 0 ? 'left' : 'right']: '50%', background: signColor(v, colors) }}></div>}
      </div>
      <span className="prog-v" style={{ color: signColor(v, colors) }}>{fmtEok(v, true)}</span>
    </div>
  );
  return (
    <div className="prog">
      {rows.map(([m, p]) => (
        <div key={m} className="prog-block">
          <div className="breadth-name">{m === 'KOSPI' ? '코스피' : '코스닥'}{p.date ? <em> · {p.date.slice(5).replace('-', '.')}</em> : null}</div>
          {bar('차익', p.arbitrage)}{bar('비차익', p.non_arbitrage)}{bar('합계', p.total)}
        </div>
      ))}
    </div>
  );
}

// ─── 국채 수익률 곡선 ─────────────────────────────────────────────────────────
const CURVE_TENORS = ['1년', '2년', '3년', '5년', '10년', '30년'];
const CURVE_IDS = { kr: ['ktb1', 'ktb2', 'ktb3', 'ktb5', 'ktb10', 'ktb30'], us: [null, 'us2y', null, 'us5y', 'us10y', 'us30y'] };
function YieldCurvePanel({ height, themeKey, colors }) {
  const sample = useLive((s, i) => i.sample);
  const quotes = useLive(s => s.quotes);
  const curve = pMemo(() => {
    const pick = ids => ids.map(id => (id && quotes[id] && quotes[id].price != null ? quotes[id].price : null));
    return { kr: pick(CURVE_IDS.kr), us: pick(CURVE_IDS.us) };
  }, [quotes]);
  if (sample) return <NeedServer height={height} />;
  if (!curve.kr.some(v => v != null)) return <ChartEmpty height={height} />;
  const sp = id => quotes[id] && quotes[id].price;
  const chip = (label, v) => v != null && <span className="curve-chip" key={label}>{label} <b style={{ color: v < 0 ? colors.down : 'var(--text)' }}>{v >= 0 ? '+' : ''}{v.toFixed(2)}%p</b></span>;
  return (
    <div>
      <div className="curve-chart" style={{ height: height - 44 }}>
        <YieldCurveChart tenors={CURVE_TENORS} kr={curve.kr} us={curve.us} height={height - 44} themeKey={themeKey} colors={colors} />
      </div>
      <div className="curve-chips">{chip('국고 10-3년', sp('kr-term'))}{chip('미 10-2년', sp('us-term'))}{chip('한미 10년', sp('uskr10y'))}</div>
    </div>
  );
}

// ─── 공포·탐욕 지수 ───────────────────────────────────────────────────────────
function FearGreedPanel({ height, colors }) {
  const sample = useLive((s, i) => i.sample);
  const fg = useLive(s => s.insights && s.insights.feargreed);
  const value = sample ? 62 : fg && fg.value;
  if (value == null) return <ChartEmpty height={height} text="계산에 필요한 데이터 수집 중" />;
  return (
    <div>
      <Gauge value={value} height={height} upColor={colors.up} downColor={colors.down} />
      {fg && fg.components && (
        <div className="fg-parts">
          {fg.components.map(c => (
            <div key={c.id} className="fg-part" title={c.display}>
              <span className="fg-k">{c.label}</span>
              <div className="fg-track"><div style={{ width: `${c.value}%`, background: c.value >= 55 ? colors.up : c.value <= 45 ? colors.down : 'var(--gauge-mid)' }}></div></div>
              <span className="fg-v">{c.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MacroScore ───────────────────────────────────────────────────────────────
function ScorePanel({ height, colors }) {
  const sample = useLive((s, i) => i.sample);
  const score = useLive(s => s.insights && s.insights.score);
  const history = useLive(s => s.series && s.series.score_history);
  const hist = pMemo(() => (history && history.length > 1 ? { values: history.map(p => p.score), dates: history.map(p => p.date) } : null), [history]);
  if (sample) return <NeedServer height={height} />;
  if (!score) return <ChartEmpty height={height} />;
  const toneColor = score.tone === 'risk_on' ? colors.up : score.tone === 'risk_off' ? colors.down : 'var(--gauge-mid)';
  return (
    <div className="score">
      <div className="score-left">
        <div className="score-big">
          <span className="score-num" style={{ color: toneColor }}>{score.score != null ? Math.round(score.score) : '–'}</span>
          <span className="score-label" style={{ color: toneColor }}>{score.label}</span>
        </div>
        <div className="score-sub">0~100 · 높을수록 한국 증시에 우호적 · 팩터 반영 {Math.round(score.coverage * 100)}%</div>
        {hist && <LineChart data={hist} height={Math.max(120, height - 120)} color={toneColor} dec={0} unit="점" periodKey="1y" indId="macroscore" />}
      </div>
      <div className="score-factors">
        {score.factors.map(f => (
          <div key={f.id} className="score-factor" title={f.description}>
            <div className="sf-head">
              <span className="sf-label">{f.label} <em>{f.weight}%</em></span>
              <span className="sf-score" style={{ color: f.score == null ? 'var(--text-3)' : f.score >= 55 ? colors.up : f.score <= 45 ? colors.down : 'var(--text-2)' }}>{f.score != null ? Math.round(f.score) : '–'}</span>
            </div>
            <div className="fg-track"><div style={{ width: `${f.score || 0}%`, background: f.score >= 55 ? colors.up : f.score <= 45 ? colors.down : 'var(--gauge-mid)' }}></div></div>
            <div className="sf-display">{f.display}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 위험 신호 ────────────────────────────────────────────────────────────────
function SignalsPanel() {
  const sample = useLive((s, i) => i.sample);
  const signals = useLive(s => s.insights && s.insights.signals);
  if (sample) return <NeedServer />;
  if (!signals) return <ChartEmpty height={180} />;
  return (
    <div className="signals">
      {signals.map(s => (
        <div key={s.id} className="signal-row">
          <span className="signal-dot" style={{ background: LEVEL_COLORS[s.level] }} title={LEVEL_LABELS[s.level]}></span>
          <span className="signal-label">{s.label}</span>
          <span className="signal-msg">{s.message}</span>
        </div>
      ))}
    </div>
  );
}

// ─── 시장 요약 ────────────────────────────────────────────────────────────────
function SummaryPanel() {
  const sample = useLive((s, i) => i.sample);
  const lines = useLive(s => s.insights && s.insights.summary);
  if (sample) return <NeedServer />;
  if (!lines || !lines.length) return <ChartEmpty height={160} />;
  return <ul className="summary">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>;
}

// ─── KOSPI 상관·베타 ──────────────────────────────────────────────────────────
function CorrelationPanel({ colors }) {
  const sample = useLive((s, i) => i.sample);
  const rows = useLive(s => s.series && s.series.correlation);
  if (sample) return <NeedServer />;
  if (!rows || !rows.length) return <ChartEmpty height={180} />;
  return (
    <div className="corr">
      <div className="corr-row corr-head"><span>팩터</span><span>상관</span><span>베타</span><span>최근</span><span>추정 영향</span></div>
      {rows.map(r => (
        <div key={r.id} className="corr-row" title={r.lagged ? '전일 미국장 → 당일 한국장으로 시차를 두고 계산' : '같은 날짜끼리 계산'}>
          <span>{r.name}{r.lagged && <em> ⏱</em>}</span>
          <span>
            {r.correlation != null ? <span className="corr-bar"><span style={{ width: `${Math.abs(r.correlation) * 100}%`, background: r.correlation >= 0 ? colors.up : colors.down }}></span></span> : null}
            {r.correlation != null ? r.correlation.toFixed(2) : '–'}
          </span>
          <span>{r.beta != null ? r.beta.toFixed(2) : '–'}</span>
          <span>{r.last_change != null ? (r.id === 'us10y' ? `${r.last_change >= 0 ? '+' : ''}${r.last_change.toFixed(1)}bp` : fmtPct(r.last_change)) : '–'}</span>
          <span style={{ color: signColor(r.implied_move, colors) }}>{r.implied_move != null ? fmtPct(r.implied_move) : '–'}</span>
        </div>
      ))}
      <div className="corr-note">최근 60거래일 KOSPI 일간 수익률 기준 · ⏱ 미국장 시차 반영 · 추정 영향 = 베타 × 최근 변화</div>
    </div>
  );
}

// ─── 관심종목 ─────────────────────────────────────────────────────────────────
function WatchlistPanel({ colors }) {
  const ui = pContext(UiContext);
  const sample = useLive((s, i) => i.sample);
  const stocks = useLive(s => s.stocks);
  const [q, setQ] = pState('');
  const [results, setResults] = pState([]);
  pEffect(() => {
    const term = q.trim();
    if (!term || sample) { setResults([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      fetchJSON(`/api/stocks/search?q=${encodeURIComponent(term)}`).then(r => alive && setResults(r.slice(0, 8))).catch(() => alive && setResults([]));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, sample]);
  const add = item => { ui.addWatch(item); setQ(''); setResults([]); };
  return (
    <div className="watch">
      <div className="watch-search">
        <input type="text" placeholder={sample ? '서버 연결 시 검색할 수 있어요' : '종목명·코드 검색 (예: 삼성전자)'} value={q} disabled={sample}
               onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && results[0]) add(results[0]); }} />
        {results.length > 0 && (
          <div className="watch-results">
            {results.map(r => (
              <button key={r.code} className="watch-result" onClick={() => add(r)}>
                <span>{r.name}</span><span className="watch-code">{r.code} · {r.market}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!ui.watch.length && <ChartEmpty height={120} text="검색해서 관심종목을 추가하세요 — 실시간 시세가 함께 들어와요" />}
      {ui.watch.map(w => {
        const s = stocks[w.code];
        return (
          <div key={w.code} className="rank-row">
            <button className="watch-main" onClick={() => ui.openStock(w.code, w.name)}>
              <span className="rank-name">{w.name}<em className="watch-code"> {w.code}</em></span>
              <span className="rank-sub">{s ? fmtNum(s.price, 0) : '…'}</span>
              <span className="rank-chg" style={{ color: signColor(s && s.change_percent, colors) }}>{s ? fmtPct(s.change_percent) : ''}</span>
            </button>
            <button className="icon-btn watch-remove" title="관심종목에서 빼기" onClick={() => ui.removeWatch(w.code)}>
              <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── 종목 상세 모달 (캔들 + 실시간 시세) ──────────────────────────────────────
const STOCK_RANGES = [['1m', '1달'], ['3m', '3달'], ['6m', '6달'], ['1y', '1년'], ['3y', '3년']];
function StockModal({ code, name, onClose, colors, themeKey }) {
  const ui = pContext(UiContext);
  const [range, setRange] = pState('6m');
  const live = useLive(s => s.stocks[code]);
  const fromLists = useLive(s => {
    for (const m of ['KOSPI', 'KOSDAQ']) {
      const hit = (s.treemap[m] || []).find(x => x.code === code) || (s.movers[m] || []).find(x => x.code === code);
      if (hit) return hit;
    }
    return null;
  });
  const tick = useTick(60);
  const res = useResource(`/api/history/${code}?range=${range}`, tick);
  const q = live || fromLists;
  const watched = ui.watch.some(w => w.code === code);
  pEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal stock-modal" role="dialog" aria-label={`${name} 상세`} onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{name || (res.data && res.data.name) || code} <span className="watch-code">{code}</span></h2>
            {q && q.price != null && (
              <div className="stock-quote">
                <b>{fmtNum(q.price, 0)}원</b>
                <span style={{ color: signColor(q.change_percent, colors) }}>{fmtPct(q.change_percent)}</span>
                {q.market_cap != null && <span className="watch-code">시총 {fmtEok(q.market_cap)}</span>}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="닫기">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path></svg>
          </button>
        </header>
        <div className="stock-tools">
          <div className="mini-seg">
            {STOCK_RANGES.map(([k, label]) => <button key={k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>{label}</button>)}
          </div>
          <button className={`add-btn ${watched ? 'added' : ''}`} onClick={() => (watched ? ui.removeWatch(code) : ui.addWatch({ code, name: name || code }))}>
            {watched ? '관심종목 ✓' : '+ 관심종목'}
          </button>
        </div>
        <div className="stock-chart">
          {res.loading && !res.data ? <ChartLoading height={320} /> : res.error && !res.data
            ? <ChartEmpty height={320} text="차트를 불러오지 못했어요" />
            : <CandleChart rows={res.data && res.data.rows} height={320} themeKey={themeKey} colors={colors} />}
        </div>
      </div>
    </div>
  );
}

// ─── 토스트 ───────────────────────────────────────────────────────────────────
const toastListeners = new Set();
function toast(t) { const item = { id: Date.now() + Math.random(), ...t }; toastListeners.forEach(fn => fn(item)); }
function Toasts() {
  const [items, setItems] = pState([]);
  pEffect(() => {
    const fn = item => {
      setItems(xs => [...xs.slice(-3), item]);
      setTimeout(() => setItems(xs => xs.filter(x => x.id !== item.id)), 7000);
    };
    toastListeners.add(fn);
    return () => toastListeners.delete(fn);
  }, []);
  return (
    <div className="toasts">
      {items.map(t => (
        <div key={t.id} className="toast" onClick={() => setItems(xs => xs.filter(x => x.id !== t.id))}>
          <b>{t.title}</b>{t.body && <span>{t.body}</span>}
        </div>
      ))}
    </div>
  );
}

// ─── 가격 알림 ────────────────────────────────────────────────────────────────
// 조건이 '거짓 → 참'으로 바뀌는 순간에만 알린다 (같은 조건으로 반복 알림 없음)
const ALERT_METRICS = { price: '가격', change_percent: '등락률(%)' };
const describeRule = (r, name) => `${name} ${ALERT_METRICS[r.metric]} ${r.op === '>=' ? '≥' : '≤'} ${fmtNum(r.value, 2)}${r.metric === 'change_percent' ? '%' : ''}`;

function useAlerts(rules) {
  const quotes = useLive(s => s.quotes);
  const state = pRef(new Map());
  pEffect(() => {
    for (const r of rules) {
      if (!r.enabled) { state.current.delete(r.id); continue; }
      const q = quotes[r.target];
      const v = q && q[r.metric];
      if (v == null || q.stale) continue;
      const hit = r.op === '>=' ? v >= r.value : v <= r.value;
      const was = state.current.get(r.id) || false;
      state.current.set(r.id, hit);
      if (!hit || was) continue;
      const name = (IND_BY_ID[r.target] && IND_BY_ID[r.target].name) || q.name;
      const title = `알림: ${describeRule(r, name)}`;
      const body = `현재 ${name} ${r.metric === 'price' ? fmtNum(v, 2) : fmtPct(v)}`;
      toast({ title, body });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, tag: r.id });
    }
  }, [quotes, rules]);
}

function AlertsModal({ rules, setRules, onClose }) {
  const targets = INDICATORS.filter(i => !i.kind && !i.noHistory || i.id === 'baserate');
  const [form, setForm] = pState({ target: 'usdkrw', metric: 'price', op: '>=', value: '' });
  const [perm, setPerm] = pState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const add = () => {
    const value = parseFloat(form.value);
    if (!Number.isFinite(value)) return;
    setRules([...rules, { ...form, value, id: `r${Date.now()}`, enabled: true }]);
    setForm({ ...form, value: '' });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="가격 알림" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>가격 알림</h2>
          <button className="icon-btn" onClick={onClose} title="닫기">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path></svg>
          </button>
        </header>
        <div className="alert-form">
          <select value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}>
            {targets.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <select value={form.metric} onChange={e => setForm({ ...form, metric: e.target.value })}>
            {Object.entries(ALERT_METRICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={form.op} onChange={e => setForm({ ...form, op: e.target.value })}>
            <option value=">=">이상 ≥</option><option value="<=">이하 ≤</option>
          </select>
          <input type="number" step="any" placeholder="값" value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} onKeyDown={e => e.key === 'Enter' && add()} />
          <button className="primary-btn" onClick={add}>추가</button>
        </div>
        <div className="modal-list">
          {!rules.length && <p className="modal-empty">조건을 추가하면 충족되는 순간 알려드려요 (이 브라우저에 저장)</p>}
          {rules.map(r => (
            <div key={r.id} className="modal-item">
              <label className="alert-rule">
                <input type="checkbox" checked={r.enabled} onChange={() => setRules(rules.map(x => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))} />
                <span>{describeRule(r, (IND_BY_ID[r.target] || {}).name || r.target)}</span>
              </label>
              <button className="icon-btn" title="삭제" onClick={() => setRules(rules.filter(x => x.id !== r.id))}>
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path></svg>
              </button>
            </div>
          ))}
        </div>
        <div className="alert-perm">
          {perm === 'granted' ? '브라우저 알림 켜짐 — 탭이 백그라운드여도 알림이 떠요'
            : perm === 'unsupported' ? '이 브라우저는 알림을 지원하지 않아 화면 토스트로만 알려요'
            : <button className="add-btn" onClick={() => Notification.requestPermission().then(setPerm)}>브라우저 알림 허용</button>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  UiContext, IndexBoardPanel, BreadthPanel, MoversPanel, ThemesPanel, ProgramPanel, YieldCurvePanel,
  FearGreedPanel, ScorePanel, SignalsPanel, SummaryPanel, CorrelationPanel, WatchlistPanel,
  StockModal, Toasts, toast, useAlerts, AlertsModal, signColor,
});
