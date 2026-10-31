// ─────────────────────────────────────────────────────────────────────────────
// widgets.jsx — 위젯 카드(실시간 시세 + 히스토리 + 소스 배지) · 위젯 추가 모달
//   라인/막대 위젯: REST 히스토리 위에 SSE 로 들어오는 시세를 마지막 점으로 실시간 병합
//   패널 위젯: panels.jsx / charts.jsx 컴포넌트가 스토어를 직접 구독
// ─────────────────────────────────────────────────────────────────────────────
const { useState: wState, useEffect: wEffect, useMemo: wMemo, useRef: wRef, useContext: wContext } = React;

const CAT_LABELS = {
  market: '시장', global: '글로벌', rates: '금리', fx: '환율', commodity: '원자재',
  flow: '수급', sentiment: '심리', macro: '매크로', watch: '관심', dollar: '달러',
};

function DiffArrow({ up }) { return <span className="diff-arrow">{up ? '▲' : '▼'}</span>; }

const BADGES = {
  live: <span className="src-badge live"><span className="src-dot"></span>LIVE</span>,
  stale: <span className="src-badge stale" title="업스트림 응답이 없어 마지막 정상값을 표시 중">지연</span>,
  sample: <span className="src-badge sample">샘플</span>,
  none: <span className="src-badge sample">데이터 없음</span>,
};

// 값이 바뀌면 잠깐 상승/하락 색으로 깜빡인다
function useFlash(value) {
  const prev = wRef(value);
  const [cls, setCls] = wState('');
  wEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before == null || value == null || before === value) return;
    setCls(value > before ? 'flash-up' : 'flash-down');
    const t = setTimeout(() => setCls(''), 900);
    return () => clearTimeout(t);
  }, [value]);
  return cls;
}

const isRate = ind => ind.unit === '%' || ind.unit === '%p';
const WIDE_KINDS = new Set(['treemap', 'multiline', 'investors', 'dual', 'flowboard', 'score']);
const SERIES_KINDS = new Set([undefined, 'line', 'bars']);

const WIDE_SUB = {
  treemap: '크기=시가총액 · 색상=등락률 · 타일을 누르면 종목 차트',
  multiline: '기간 시작점=0% 정규화 비교 · 휴장일은 직전 값',
  investors: '단위: 조원 · 누적 순매수 (오늘은 장중 잠정)',
  dual: '좌축=외국인 누적 순매수(조) · 우축=KOSPI',
  flowboard: '주간 수급 집계(최근 2년) · 투자자별 누적 순매수 + 외국인 vs 지수 · 연속 매도/매수 주 자동 산출',
  score: 'SOX·환율·외국인·추세·나스닥·미 10년물·VIX 7개 팩터를 1년 분포 대비 표준화한 가중 점수',
};
const PANEL_SUB = {
  board: '52주 범위 · 이동평균 · 실현변동성 · 수급 (장중 잠정)',
  breadth: '전 종목 기준 상승/하락/보합 · 52주 신고가/신저가 종목 수',
  sectors: '네이버 업종 79개 등락률 (상위 6 · 하위 6)',
  themes: '오늘 등락률 상위 테마',
  movers: 'ETF·ETN 제외 개별 종목 거래대금 순위',
  program: '프로그램 순매수 (억원) · 차익/비차익',
  curve: '만기별 국채 금리 (한국 vs 미국)',
  gauge: '시장 폭 · 신고가/신저가 · 125일선 이격 · 변동성 · 환율 합성 (0~100)',
  signals: '환율·변동성·외국인·추세·낙폭·시장 폭·신용·금리차 자동 점검',
  summary: '지금 시장을 한눈에 — 데이터로 자동 생성',
  correlation: 'KOSPI 와 함께 움직이는 정도 · 오늘 영향 추정',
  watchlist: '검색해서 추가 · 서버가 모든 관심종목을 한 번에 조회해 실시간 푸시',
};

// ─── 라인 위젯 본문 ───────────────────────────────────────────────────────────
function LineBody({ ind, periodKey, colors, compact, csvRef }) {
  const id = ind.src || ind.id;
  const sample = useLive((s, i) => i.sample);
  const quote = useLive(s => s.quotes[id]);
  const intra = useLive(s => (ind.intraday ? s.intraday[id] : null));
  const version = useLive(s => (s.series ? s.series.version : 0));
  const wantIntraday = periodKey === '1d' && ind.intraday;
  const range = periodKey === '1d' ? '1w' : periodKey;
  const res = useResource(sample || wantIntraday || ind.noHistory ? null : `/api/history/${id}?range=${range}`, version);
  const rows = res.data && res.data.rows;

  const data = wMemo(() => {
    if (sample) return ind.noHistory ? null : sliceSeries(ind, range);
    if (wantIntraday) return intradayData(intra, quote);
    const merged = mergeLiveRows(rows, quote);
    return merged && merged.length ? { values: merged.map(r => r.close), dates: merged.map(r => r.date) } : null;
  }, [sample, wantIntraday, intra, rows, quote, range]);

  // 표시 시세: 실시간 > 히스토리 마지막 두 점 > 샘플
  let q = null;
  if (sample) q = getQuote(ind);
  else if (quote && quote.price != null) q = { value: quote.price, diff: quote.change, pct: quote.change_percent };
  else if (rows && rows.length > 1) {
    const last = rows[rows.length - 1].close, prev = rows[rows.length - 2].close;
    q = { value: last, diff: last - prev, pct: prev ? ((last - prev) / prev) * 100 : null };
  }
  const flash = useFlash(q ? q.value : null);
  if (csvRef) csvRef.current = data ? { header: ['date', ind.name], rows: data.dates.map((d, i) => [d instanceof Date ? d.toISOString().slice(0, 10) : d, data.values[i]]) } : null;

  const up = q && (q.diff || 0) >= 0;
  const diffColor = q && q.diff ? (up ? colors.up : colors.down) : 'var(--text-3)';
  const chartH = compact ? 120 : 168;
  const baseline = wantIntraday && quote && quote.price != null && quote.change != null ? quote.price - quote.change : null;
  const meta = [];
  if (!sample && quote) {
    if (quote.as_of) meta.push(fmtAsOf(quote.as_of));
    if (quote.prev_session) meta.push('직전 거래일');
    if (quote.delayed) meta.push(`${quote.delayed}분 지연`);
  }
  if (periodKey === '1d' && !wantIntraday) meta.push('1주 표시');

  return (
    <>
      {q && (
        <div className="quote-row">
          <span className={`quote-value ${flash}`}>
            {fmtNum(q.value, ind.dec)}
            {ind.unit && <span className="quote-unit">{ind.unit === '$' ? '' : ind.unit}</span>}
          </span>
          {q.diff === 0 && <span className="quote-diff" style={{ color: 'var(--text-3)' }}>보합</span>}
          {q.diff != null && q.diff !== 0 && (
            <span className="quote-diff" style={{ color: diffColor }}>
              <DiffArrow up={up} /> {isRate(ind) ? `${Math.abs(q.diff * 100).toFixed(1)}bp` : fmtNum(Math.abs(q.diff), ind.dec)}
              {q.pct != null && !isRate(ind) && <span className="quote-pct">({up ? '+' : '-'}{Math.abs(q.pct).toFixed(2)}%)</span>}
            </span>
          )}
          {meta.length > 0 && <span className="quote-meta">{meta.join(' · ')}</span>}
        </div>
      )}
      <div className="widget-body">
        {ind.noHistory && !sample
          ? <div className="chart-empty" style={{ height: chartH }}>
              {quote && quote.as_of ? `최근 결정 ${String(quote.as_of).slice(0, 10).replace(/-/g, '.')}${quote.change === 0 ? ' · 동결' : ''}` : '데이터 없음'}
              <small>일별 히스토리는 무료 소스가 없어 현재값만 실시간으로 표시해요</small>
            </div>
          : res.loading && !data ? <ChartLoading height={chartH} />
          : <LineChart data={data} height={chartH} color="var(--accent)" dec={ind.dec} unit={ind.unit} indId={ind.id}
                       periodKey={wantIntraday ? '1d' : range} baseline={baseline} upColor={colors.up} downColor={colors.down}
                       live={!sample && quote && quote.market_status === 'OPEN'} />}
      </div>
    </>
  );
}

// ─── 수급 막대 위젯 본문 (오늘은 장중 잠정치로 실시간 교체) ─────────────────────
function BarsBody({ ind, periodKey, colors, compact, csvRef }) {
  const sample = useLive((s, i) => i.sample);
  const version = useLive(s => (s.series ? s.series.version : 0));
  const today = useLive(s => s.boards.KOSPI && s.boards.KOSPI.flows);
  const krx = useLive(s => s.meta && s.meta.session.krx);
  const range = periodKey === '1d' ? '1w' : periodKey;
  const res = useResource(sample ? null : `/api/history/${ind.id}?range=${range}`, version);
  const rows = res.data && res.data.rows;
  const data = wMemo(() => {
    if (sample) return sliceSeries(ind, range);
    if (!rows || !rows.length) return null;
    let merged = rows;
    const v = today && today[ind.field];
    if (v != null) merged = mergeLiveRows(rows, { day: today.date, price: v });
    return { values: merged.map(r => r.close), dates: merged.map(r => r.date) };
  }, [sample, rows, today, range]);
  if (csvRef) csvRef.current = data ? { header: ['date', `${ind.name}(억원)`], rows: data.dates.map((d, i) => [d instanceof Date ? d.toISOString().slice(0, 10) : d, data.values[i]]) } : null;

  const last = data ? data.values[data.values.length - 1] : null;
  const sum20 = data ? data.values.slice(-20).reduce((s, v) => s + v, 0) : null;
  const flash = useFlash(last);
  const provisional = !sample && today && data && data.dates[data.dates.length - 1] === today.date && krx === 'open';
  return (
    <>
      {last != null && (
        <div className="quote-row">
          <span className={`quote-value ${flash}`} style={{ color: signColor(last, colors) }}>{fmtEok(last, true)}<span className="quote-unit">원</span></span>
          <span className="quote-diff" style={{ color: signColor(sum20, colors) }}>20일 누적 {fmtEok(sum20, true)}</span>
          <span className="quote-meta">{provisional ? '오늘 장중 잠정' : data && typeof data.dates[data.dates.length - 1] === 'string' ? fmtAsOf(data.dates[data.dates.length - 1]) : ''}</span>
        </div>
      )}
      <div className="widget-body">
        {res.loading && !data ? <ChartLoading height={compact ? 120 : 168} />
          : <BarChart data={data} height={compact ? 120 : 168} upColor={colors.up} downColor={colors.down} periodKey={range} unit="억원" />}
      </div>
    </>
  );
}

// ─── 패널 본문 ────────────────────────────────────────────────────────────────
function SectorsBody({ colors }) {
  const sample = useLive((s, i) => i.sample);
  const sectors = useLive(s => s.sectors);
  const rows = wMemo(() => (sample ? SECTOR_ROWS : sectors.map(g => ({ name: g.name, chg: g.change }))), [sample, sectors]);
  if (!rows.length) return <ChartEmpty height={200} />;
  return <SectorList rows={rows} upColor={colors.up} downColor={colors.down} split={sample ? null : 6} />;
}

function PanelBody({ ind, periodKey, colors, compact, themeKey }) {
  const ui = wContext(UiContext);
  const wideH = compact ? 300 : 360;
  const panelH = compact ? 190 : 230;
  const range = periodKey === '1d' ? '1w' : periodKey;
  switch (ind.kind) {
    case 'treemap': return <TreemapChart market={ind.market} weekly={periodKey === '1w'} height={wideH} themeKey={themeKey} colors={colors} onSelect={ui.openStock} />;
    case 'multiline': return <MultiLineChart range={range} height={wideH} themeKey={themeKey} colors={colors} />;
    case 'investors': return <InvestorsChart periodKey={periodKey} height={wideH} themeKey={themeKey} colors={colors} />;
    case 'dual': return <DualChart periodKey={periodKey} height={wideH} themeKey={themeKey} colors={colors} />;
    case 'flowboard': return <FlowBoardChart height={wideH} themeKey={themeKey} colors={colors} />;
    case 'score': return <ScorePanel height={wideH - 40} colors={colors} />;
    case 'gauge': return <FearGreedPanel height={compact ? 150 : 180} colors={colors} />;
    case 'sectors': return <SectorsBody colors={colors} />;
    case 'board': return <IndexBoardPanel market={ind.market} colors={colors} />;
    case 'breadth': return <BreadthPanel colors={colors} />;
    case 'movers': return <MoversPanel colors={colors} />;
    case 'themes': return <ThemesPanel colors={colors} />;
    case 'program': return <ProgramPanel colors={colors} />;
    case 'curve': return <YieldCurvePanel height={panelH} themeKey={themeKey} colors={colors} />;
    case 'signals': return <SignalsPanel />;
    case 'summary': return <SummaryPanel />;
    case 'correlation': return <CorrelationPanel colors={colors} />;
    case 'watchlist': return <WatchlistPanel colors={colors} />;
    default: return window.DollarPanels && window.DollarPanels[ind.kind]
      ? React.createElement(window.DollarPanels[ind.kind], { ind, periodKey, colors, compact, themeKey })
      : <ChartEmpty height={panelH} />;
  }
}

// ─── 위젯 카드 ────────────────────────────────────────────────────────────────
function WidgetCard({ ind, periodKey, colors, compact, onRemove, themeKey, dragProps, dragging, dragOver }) {
  const isWide = WIDE_KINDS.has(ind.kind) || ind.span === 2;
  const isSeries = SERIES_KINDS.has(ind.kind);
  const csvRef = wRef(null);
  const badge = useLive((s, i) => {
    if (i.sample) return 'sample';
    if (!i.everConnected) return null;
    if (isSeries && ind.kind !== 'bars') {
      const q = s.quotes[ind.src || ind.id];
      if (q) return q.stale && q.price != null ? 'stale' : q.price == null && ind.noHistory ? 'none' : 'live';
    }
    return 'live';
  });
  const exportCsv = () => {
    if (csvRef.current) downloadCsv(`${ind.name}_${periodKey}.csv`, csvRef.current.header, csvRef.current.rows);
  };

  return (
    <article className={`widget ${isWide ? 'wide' : ''} ${dragging ? 'dragging' : ''} ${dragOver ? 'drag-over' : ''}`}
             data-screen-label={ind.name} {...dragProps}>
      <header className="widget-head">
        <span className="drag-handle" title="드래그하여 위치 변경">
          <svg width="10" height="14" viewBox="0 0 10 14">
            {[0, 1, 2].map(r => [0, 1].map(c =>
              <circle key={`${r}${c}`} cx={2.5 + c * 5} cy={2.5 + r * 4.5} r="1.3" fill="currentColor"></circle>
            ))}
          </svg>
        </span>
        <h3 className="widget-title">{ind.name}</h3>
        <span className="widget-cat">{CAT_LABELS[ind.cat]}</span>
        {badge && BADGES[badge]}
        {isSeries && (
          <button className="icon-btn widget-action" title="CSV 다운로드" onClick={exportCsv}>
            <svg width="13" height="13" viewBox="0 0 14 14"><path d="M7 2 V9 M4 6.5 L7 9.5 L10 6.5 M2.5 12 H11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"></path></svg>
          </button>
        )}
        <button className={`icon-btn widget-remove ${isSeries ? '' : 'solo'}`} title="위젯 삭제" onClick={() => onRemove(ind.id)}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path>
          </svg>
        </button>
      </header>

      {ind.kind === 'bars'
        ? <BarsBody ind={ind} periodKey={periodKey} colors={colors} compact={compact} csvRef={csvRef} />
        : isSeries
          ? <LineBody ind={ind} periodKey={periodKey} colors={colors} compact={compact} csvRef={csvRef} />
          : <>
              <div className="quote-row"><span className="quote-sub">{WIDE_SUB[ind.kind] || PANEL_SUB[ind.kind] || ind.sub || ''}</span></div>
              <div className={`widget-body ${isWide ? '' : 'top'}`}><PanelBody ind={ind} periodKey={periodKey} colors={colors} compact={compact} themeKey={themeKey} /></div>
            </>}
    </article>
  );
}

// ─── 위젯 추가 모달 ───────────────────────────────────────────────────────────
function AddWidgetModal({ activeIds, onAdd, onClose }) {
  const [q, setQ] = wState('');
  const [cat, setCat] = wState('all');
  const cats = ['all', ...Object.keys(CAT_LABELS).filter(c => INDICATORS.some(i => i.cat === c))];
  // 검색: 대소문자·공백 무시 + 별칭(alias) 포함 ("코스피변동지수" ↔ "코스피 변동성지수(VKOSPI)" 매칭)
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
  const nq = norm(q);
  const list = INDICATORS.filter(ind =>
    (cat === 'all' || ind.cat === cat) &&
    (!nq || norm(ind.name).includes(nq) || norm(ind.alias).includes(nq) || ind.id.includes(nq)));
  wEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="위젯 추가" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>위젯 추가</h2>
          <button className="icon-btn" onClick={onClose} title="닫기">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path>
            </svg>
          </button>
        </header>
        <div className="modal-search">
          <input type="text" placeholder={`지표 검색 (${INDICATORS.length}종)`} value={q} onChange={e => setQ(e.target.value)} autoFocus={true} />
        </div>
        <div className="modal-cats">
          {cats.map(c => (
            <button key={c} className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>
              {c === 'all' ? '전체' : CAT_LABELS[c]}
            </button>
          ))}
        </div>
        <div className="modal-list">
          {list.map(ind => {
            const added = activeIds.includes(ind.id);
            return (
              <div key={ind.id} className="modal-item">
                <div className="modal-item-info">
                  <span className="modal-item-name">{ind.name}</span>
                  <span className="modal-item-cat">{CAT_LABELS[ind.cat]}{(ind.span === 2 || WIDE_KINDS.has(ind.kind)) ? ' · 와이드' : ''}{ind.intraday ? ' · 1일 분봉' : ''}</span>
                </div>
                <button className={`add-btn ${added ? 'added' : ''}`} disabled={added} onClick={() => onAdd(ind.id)}>
                  {added ? '추가됨' : '+ 추가'}
                </button>
              </div>
            );
          })}
          {list.length === 0 && <p className="modal-empty">검색 결과가 없어요</p>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WidgetCard, AddWidgetModal, CAT_LABELS, useFlash });
