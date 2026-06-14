// ─────────────────────────────────────────────────────────────────────────────
// widgets.jsx — 위젯 카드(라이브 페치 + 소스 배지) + 위젯 추가 모달
// ─────────────────────────────────────────────────────────────────────────────
const { useState: wState, useEffect: wEffect, useMemo: wMemo, useCallback: wCb } = React;

const CAT_LABELS = {
  market: '시장', rates: '금리', fx: '환율',
  commodity: '원자재', flow: '수급', sentiment: '심리',
};

function DiffArrow({ up }) { return <span className="diff-arrow">{up ? '▲' : '▼'}</span>; }

// 라이브/샘플 배지
function SourceBadge({ source }) {
  if (!source) return null;
  if (source === 'live') return <span className="src-badge live"><span className="src-dot"></span>LIVE</span>;
  return <span className="src-badge sample">샘플</span>;
}

// 와이드 패널(트리맵/멀티라인/수급/이중축)인지
const WIDE_KINDS = new Set(['treemap', 'multiline', 'investors', 'dual', 'flowboard']);

// ─── 위젯 카드 ────────────────────────────────────────────────────────────────
function WidgetCard({ ind, periodKey, colors, compact, onRemove, themeKey, dragProps, dragging, dragOver }) {
  const isWide = WIDE_KINDS.has(ind.kind);
  const chartH = compact ? 120 : 168;
  const wideH = compact ? 300 : 360;

  // 단순 시계열/리스트 위젯의 라이브 상태
  const [live, setLive] = wState(null);       // { values, dates, quote } | null
  const [sectors, setSectors] = wState(null);  // sectors rows | null
  const [gaugeVal, setGaugeVal] = wState(null);// 라이브 게이지 값 | null
  const [source, setSource] = wState(null);    // 'live' | 'sample' | null

  // line/bars: 기간 변경마다 라이브 시도
  wEffect(() => {
    if (isWide || ind.kind === 'gauge') return;
    let alive = true;
    if (ind.kind === 'sectors') {
      fetchSeries('sectors', periodKey).then(d => {
        if (!alive) return;
        if (d && d.rows) { setSectors(d.rows); setSource('live'); }
        else { setSectors(null); setSource('sample'); }
      });
      return () => { alive = false; };
    }
    setSource(null);
    fetchSeries(ind.id, periodKey).then(d => {
      if (!alive) return;
      if (d && d.values && d.values.length) { setLive(d); setSource('live'); }
      else { setLive(null); setSource('sample'); }
    });
    return () => { alive = false; };
  }, [ind.id, periodKey]);

  // 와이드 패널 소스 표시
  const onWideSource = wCb(s => setSource(s), []);
  // 게이지: 라이브 값 시도
  wEffect(() => {
    if (ind.kind !== 'gauge') return;
    let alive = true;
    fetchSeries(ind.id, periodKey).then(d => {
      if (!alive) return;
      if (d && typeof d.value === 'number') { setGaugeVal(d.value); setSource('live'); }
      else setSource('sample');
    });
    return () => { alive = false; };
  }, [ind.id]);

  // 표시 데이터 결정 (라이브 우선, 없으면 합성)
  const synthetic = wMemo(() => sliceSeries(ind, periodKey), [ind, periodKey]);
  const data = (live && live.values) ? sliceLive(live, periodKey) : synthetic;
  const quote = ind.kind === 'gauge' ? getQuote(ind)
    : (live && live.quote) ? live.quote
    : getQuote(ind);

  // ── 본문 ──
  let body = null;
  if (ind.kind === 'treemap') {
    const tperiod = periodKey === '1w' ? 'weekly' : 'daily';
    body = <TreemapChart market={ind.market} period={tperiod} height={wideH} themeKey={themeKey} onSource={onWideSource} />;
  } else if (ind.kind === 'multiline') {
    body = <MultiLineChart range={periodKey} height={wideH} themeKey={themeKey} onSource={onWideSource} />;
  } else if (ind.kind === 'investors') {
    body = <InvestorsChart height={wideH} themeKey={themeKey} onSource={onWideSource} />;
  } else if (ind.kind === 'dual') {
    body = <DualChart height={wideH} themeKey={themeKey} onSource={onWideSource} />;
  } else if (ind.kind === 'flowboard') {
    body = <FlowBoardChart height={wideH} themeKey={themeKey} onSource={onWideSource} />;
  } else if (ind.kind === 'bars') {
    body = <BarChart data={data} height={chartH} upColor={colors.up} downColor={colors.down} periodKey={periodKey} unit={ind.unit} />;
  } else if (ind.kind === 'gauge') {
    body = <Gauge value={gaugeVal != null ? gaugeVal : ind.value} height={chartH + 36} upColor={colors.up} downColor={colors.down} />;
  } else if (ind.kind === 'sectors') {
    body = <SectorList rows={sectors || SECTOR_ROWS} upColor={colors.up} downColor={colors.down} />;
  } else {
    body = <LineChart data={data} height={chartH} color="var(--accent)" dec={ind.dec} unit={ind.unit} periodKey={periodKey} indId={ind.id} />;
  }

  const up = quote && quote.diff >= 0;
  const diffColor = quote ? (up ? colors.up : colors.down) : null;

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
        <SourceBadge source={source} />
        <button className="icon-btn widget-remove" title="위젯 삭제" onClick={() => onRemove(ind.id)}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path>
          </svg>
        </button>
      </header>

      {quote && ind.kind !== 'gauge' && !isWide && (
        <div className="quote-row">
          <span className="quote-value">
            {fmtNum(quote.value, ind.dec)}
            {ind.unit && <span className="quote-unit">{ind.unit === '$' ? '' : ind.unit}</span>}
          </span>
          <span className="quote-diff" style={{ color: diffColor }}>
            <DiffArrow up={up} /> {fmtNum(Math.abs(quote.diff), ind.dec)}
            {quote.pct != null && <span className="quote-pct">({up ? '+' : '-'}{Math.abs(quote.pct).toFixed(2)}%)</span>}
          </span>
        </div>
      )}
      {ind.kind === 'sectors' && (
        <div className="quote-row"><span className="quote-sub">전일 대비 업종 평균 등락률 (상위 시총 종목 기준)</span></div>
      )}
      {isWide && (
        <div className="quote-row"><span className="quote-sub">{WIDE_SUB[ind.kind]}</span></div>
      )}

      <div className="widget-body">{body}</div>
    </article>
  );
}

const WIDE_SUB = {
  treemap: '크기=시가총액 · 색상=등락률 (상승 빨강 · 하락 파랑)',
  multiline: '기간 시작점=0% 정규화 비교',
  investors: '단위: 조원 · 누적 순매수',
  dual: '좌축=외국인 누적 순매수(조) · 우축=KOSPI',
  flowboard: '주간 수급 집계(최근 2년) · 투자자별 누적 순매수 + 외국인 vs KOSPI · 연속 매도/매수 주 자동 산출',
};

// 라이브 응답을 기간 길이에 맞춰 자르기
function sliceLive(live, periodKey) {
  const p = PERIODS.find(p => p.key === periodKey) || PERIODS[2];
  const v = live.values.slice(-p.n);
  const d = (live.dates || []).slice(-p.n).map(s => new Date(s));
  return { values: v, dates: d.length === v.length ? d : DATES_5Y.slice(-v.length) };
}

// ─── 위젯 추가 모달 ───────────────────────────────────────────────────────────
function AddWidgetModal({ activeIds, onAdd, onClose }) {
  const [q, setQ] = wState('');
  const [cat, setCat] = wState('all');
  const cats = ['all', ...Object.keys(CAT_LABELS)];
  // 검색: 대소문자·공백 무시 + 별칭(alias) 포함 ("코스피변동지수" ↔ "코스피 변동성지수(VKOSPI)" 매칭)
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
  const nq = norm(q);
  const list = INDICATORS.filter(ind =>
    (cat === 'all' || ind.cat === cat) &&
    (!nq || norm(ind.name).includes(nq) || norm(ind.alias).includes(nq) || ind.id.includes(nq)));
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
          <input type="text" placeholder="지표 검색" value={q} onChange={e => setQ(e.target.value)} autoFocus={true} />
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
                  <span className="modal-item-cat">{CAT_LABELS[ind.cat]}{ind.span === 2 ? ' · 와이드' : ''}</span>
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

Object.assign(window, { WidgetCard, AddWidgetModal, CAT_LABELS });
