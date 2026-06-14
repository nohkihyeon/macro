// 위젯 카드 + 위젯 추가 모달
const { useState: wUseState, useMemo: wUseMemo } = React;

const CAT_LABELS = {
  market: '시장', rates: '금리', fx: '환율',
  commodity: '원자재', flow: '수급', sentiment: '심리',
};

// 등락 화살표
function DiffArrow({ up }) {
  return <span className="diff-arrow">{up ? '▲' : '▼'}</span>;
}

// ─── 위젯 카드 ─────────────────────────────────────────────
function WidgetCard({ ind, periodKey, colors, compact, onRemove,
                      dragProps, dragging, dragOver }) {
  const quote = getQuote(ind);
  const chartH = compact ? 120 : 168;
  const up = quote && quote.diff >= 0;
  const diffColor = quote ? (up ? colors.up : colors.down) : null;
  const data = wUseMemo(() => sliceSeries(ind, periodKey), [ind, periodKey]);

  let body = null;
  if (ind.kind === 'bars') {
    body = <BarChart data={data} height={chartH} upColor={colors.up} downColor={colors.down}
             periodKey={periodKey} unit={ind.unit} />;
  } else if (ind.kind === 'gauge') {
    body = <Gauge value={ind.value} height={chartH + 36} upColor={colors.up} downColor={colors.down} />;
  } else if (ind.kind === 'sectors') {
    body = <SectorList rows={SECTOR_ROWS} upColor={colors.up} downColor={colors.down} compact={compact} />;
  } else {
    body = <LineChart data={data} height={chartH} color="var(--accent)" dec={ind.dec}
             unit={ind.unit} periodKey={periodKey} indId={ind.id} />;
  }

  return (
    <article className={`widget ${dragging ? 'dragging' : ''} ${dragOver ? 'drag-over' : ''}`}
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
        <button className="icon-btn widget-remove" title="위젯 삭제"
                onClick={() => onRemove(ind.id)}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"></path>
          </svg>
        </button>
      </header>

      {quote && ind.kind !== 'gauge' && (
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
        <div className="quote-row">
          <span className="quote-sub">전일 대비 등락률 · 거래대금 상위 업종</span>
        </div>
      )}

      <div className="widget-body">{body}</div>
    </article>
  );
}

// ─── 위젯 추가 모달 ────────────────────────────────────────
function AddWidgetModal({ activeIds, onAdd, onClose }) {
  const [q, setQ] = wUseState('');
  const [cat, setCat] = wUseState('all');
  const cats = ['all', ...Object.keys(CAT_LABELS)];
  const list = INDICATORS.filter(ind =>
    (cat === 'all' || ind.cat === cat) &&
    (!q || ind.name.includes(q))
  );
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
                  <span className="modal-item-cat">{CAT_LABELS[ind.cat]}</span>
                </div>
                <button className={`add-btn ${added ? 'added' : ''}`} disabled={added}
                        onClick={() => onAdd(ind.id)}>
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
