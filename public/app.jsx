// ─────────────────────────────────────────────────────────────────────────────
// app.jsx — 시그널보드 앱 셸
//   탭 · 라이브 KPI 스트립 · 위젯 그리드(드래그 재배치) · 테마 · 자동갱신 · Tweaks
// ─────────────────────────────────────────────────────────────────────────────
const { useState: aState, useEffect: aEffect, useCallback: aCb } = React;

const TABS = [
  { key: 'home',      label: '홈' },
  { key: 'market',    label: '시장' },
  { key: 'ratesfx',   label: '금리·환율' },
  { key: 'commodity', label: '원자재' },
  { key: 'flow',      label: '수급·심리' },
];

const DEFAULT_WIDGETS = {
  home:      ['kospi', 'kosdaq', 'usdkrw', 'wti', 'gold', 'sectors', 'flow-foreign', 'feargreed', 'treemap-kospi'],
  market:    ['kospi', 'kosdaq', 'k200fut', 'sectors', 'vkospi', 'treemap-kospi', 'treemap-kosdaq', 'global'],
  ratesfx:   ['callrate', 'ktb3', 'cd91', 'corp3', 'baserate', 'ktb10', 'usdkrw', 'jpykrw', 'eurkrw'],
  commodity: ['wti', 'gold', 'copper'],
  flow:      ['flow-board', 'flow-foreign', 'flow-inst', 'flow-retail', 'feargreed', 'vix', 'flow-cum', 'foreign-kospi'],
};

const LS_KEY = 'signalboard-state-v1';
function loadState() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } }
function saveState(patch) { const cur = loadState(); localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch })); }

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "기본",
  "colorRule": "한국식",
  "accent": "#3B6EF5"
}/*EDITMODE-END*/;

// ─── 상단 KPI 스트립 ──────────────────────────────────────────────────────────
const KPI_ITEMS = [
  { id: 'kospi', label: 'KOSPI', dec: 2 },
  { id: 'kosdaq', label: 'KOSDAQ', dec: 2 },
  { id: 'sp500', label: 'S&P 500', dec: 2 },
  { id: 'nasdaq', label: 'NASDAQ', dec: 2 },
  { id: 'usdkrw', label: '원/달러', dec: 1 },
];
function KpiStrip({ colors, nonce }) {
  const [quotes, setQuotes] = aState({});
  const [updated, setUpdated] = aState(null);
  aEffect(() => {
    let alive = true;
    fetchJSON(`/api/quotes?ids=${KPI_ITEMS.map(k => k.id).join(',')}`)
      .then(q => { if (alive) { setQuotes(q); setUpdated(new Date()); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [nonce]);
  return (
    <div className="kpi-strip">
      {KPI_ITEMS.map(k => {
        const q = quotes[k.id];
        const live = q && q.source === 'live';
        const up = q && q.diff >= 0;
        return (
          <div className="kpi-card" key={k.id}>
            <span className="kpi-title">{k.label}</span>
            <span className="kpi-value">{live ? fmtNum(q.value, k.dec) : '–'}</span>
            <span className="kpi-change" style={{ color: live ? (up ? colors.up : colors.down) : 'var(--text-3)' }}>
              {live ? `${up ? '▲' : '▼'} ${Math.abs(q.pct).toFixed(2)}%` : '대기'}
            </span>
          </div>
        );
      })}
      <div className="kpi-meta">
        {updated ? `갱신 ${updated.toLocaleTimeString('ko-KR')}` : '연결 중…'}
      </div>
    </div>
  );
}

function App() {
  const saved = loadState();
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const hashTab = (location.hash || '').replace('#', '');
  const [tab, setTab] = aState(TABS.some(x => x.key === hashTab) ? hashTab : (saved.tab || 'home'));
  const [theme, setTheme] = aState(saved.theme || 'light');
  const [period, setPeriod] = aState(saved.period || '1y');
  const [widgets, setWidgets] = aState(() => ({ ...DEFAULT_WIDGETS, ...(saved.widgets || {}) }));
  const [modalOpen, setModalOpen] = aState(false);
  const [dragIdx, setDragIdx] = aState(null);
  const [overIdx, setOverIdx] = aState(null);
  const [nonce, setNonce] = aState(0);            // 수동 갱신 키
  const [auto, setAuto] = aState(saved.auto || false);

  aEffect(() => { document.documentElement.dataset.theme = theme; saveState({ theme }); }, [theme]);
  aEffect(() => { saveState({ tab }); }, [tab]);
  aEffect(() => { saveState({ period }); }, [period]);
  aEffect(() => { saveState({ widgets }); }, [widgets]);
  aEffect(() => { saveState({ auto }); }, [auto]);
  aEffect(() => { document.documentElement.style.setProperty('--accent', t.accent); }, [t.accent]);

  // 자동 갱신 (60초) — KPI + 위젯 리프레시
  aEffect(() => {
    if (!auto) return;
    const iv = setInterval(() => setNonce(n => n + 1), 60000);
    return () => clearInterval(iv);
  }, [auto]);

  const kr = t.colorRule === '한국식';
  const colors = { up: kr ? 'var(--kr-up)' : 'var(--us-up)', down: kr ? 'var(--kr-down)' : 'var(--us-down)' };
  const compact = t.density === '컴팩트';
  const themeKey = `${theme}|${t.accent}|${t.colorRule}|${nonce}`;

  const ids = widgets[tab] || [];
  const inds = ids.map(id => IND_BY_ID[id]).filter(Boolean);
  const setIds = next => setWidgets(w => ({ ...w, [tab]: next }));
  const removeWidget = id => setIds(ids.filter(x => x !== id));
  const addWidget = id => { if (!ids.includes(id)) setIds([...ids, id]); };

  // 드래그 재배치
  const onDragStart = (i, e) => { setDragIdx(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); };
  const onDragOver = (i, e) => { e.preventDefault(); if (dragIdx == null || i === dragIdx) { setOverIdx(null); return; } setOverIdx(i); };
  const onDrop = (i, e) => {
    e.preventDefault();
    if (dragIdx == null || dragIdx === i) { setDragIdx(null); setOverIdx(null); return; }
    const next = [...ids]; const [moved] = next.splice(dragIdx, 1); next.splice(i, 0, moved);
    setIds(next); setDragIdx(null); setOverIdx(null);
  };
  const onDragEnd = () => { setDragIdx(null); setOverIdx(null); };

  return (
    <div className={`app ${compact ? 'compact' : ''}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark"></span>
            <span className="brand-name">시그널보드</span>
          </div>
          <nav className="tabs" aria-label="카테고리">
            {TABS.map(tb => (
              <button key={tb.key} className={`tab ${tab === tb.key ? 'active' : ''}`} onClick={() => setTab(tb.key)}>{tb.label}</button>
            ))}
          </nav>
          <div className="topbar-actions">
            <button className={`icon-btn ${auto ? 'auto-on' : ''}`} title={auto ? '자동 갱신 끄기' : '자동 갱신 켜기 (60초)'} onClick={() => setAuto(a => !a)}>
              <svg width="17" height="17" viewBox="0 0 17 17">
                <path d="M14 8.5a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"></path>
                <path d="M14 3 L14 6 L11 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"></path>
              </svg>
            </button>
            <button className="icon-btn" title="새로고침" onClick={() => setNonce(n => n + 1)}>
              <svg width="17" height="17" viewBox="0 0 17 17">
                <path d="M14 8.5a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"></path>
                <path d="M14 3 L14 6 L11 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"></path>
              </svg>
            </button>
            <button className="icon-btn theme-btn" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                    title={theme === 'light' ? '다크 모드' : '라이트 모드'}>
              {theme === 'light' ? (
                <svg width="17" height="17" viewBox="0 0 17 17"><path d="M14 10.2 A6.3 6.3 0 1 1 7 3 A5 5 0 0 0 14 10.2 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"></path></svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 17 17">
                  <circle cx="8.5" cy="8.5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5"></circle>
                  {[0,45,90,135,180,225,270,315].map(a => { const r = a * Math.PI / 180; return <line key={a} x1={8.5 + Math.cos(r)*5.4} y1={8.5 + Math.sin(r)*5.4} x2={8.5 + Math.cos(r)*7} y2={8.5 + Math.sin(r)*7} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"></line>; })}
                </svg>
              )}
            </button>
            <button className="primary-btn" onClick={() => setModalOpen(true)}>+ 위젯 추가</button>
          </div>
        </div>
      </header>

      <KpiStrip colors={colors} nonce={nonce} />

      <div className="control-row">
        <h1 className="page-title">{TABS.find(x => x.key === tab).label}</h1>
        <div className="seg" role="tablist" aria-label="기간">
          {PERIODS.map(p => (
            <button key={p.key} className={`seg-btn ${period === p.key ? 'active' : ''}`} onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
      </div>

      <main className="grid" data-screen-label={`${TABS.find(x => x.key === tab).label} 탭`}>
        {inds.map((ind, i) => (
          <WidgetCard key={`${ind.id}-${nonce}`} ind={ind} periodKey={period} colors={colors}
            compact={compact} onRemove={removeWidget} themeKey={themeKey}
            dragging={dragIdx === i} dragOver={overIdx === i}
            dragProps={{ draggable: true, onDragStart: e => onDragStart(i, e), onDragOver: e => onDragOver(i, e), onDrop: e => onDrop(i, e), onDragEnd }} />
        ))}
        <button className="empty-add" onClick={() => setModalOpen(true)}>
          <span className="empty-add-plus">+</span><span>위젯 추가하기</span>
        </button>
      </main>

      <footer className="foot-note">
        실시간 소스: Yahoo Finance(지수·환율·원자재) · 네이버 금융(트리맵·수급). <strong>LIVE</strong> 배지는 실데이터, <strong>샘플</strong> 배지는 합성 데이터입니다.
      </footer>

      {modalOpen && <AddWidgetModal activeIds={ids} onAdd={addWidget} onClose={() => setModalOpen(false)} />}

      <TweaksPanel>
        <TweakSection label="레이아웃" />
        <TweakRadio label="카드 밀도" value={t.density} options={['기본', '컴팩트']} onChange={v => setTweak('density', v)} />
        <TweakSection label="컬러" />
        <TweakRadio label="등락 색상" value={t.colorRule} options={['한국식', '미국식']} onChange={v => setTweak('colorRule', v)} />
        <TweakColor label="액센트" value={t.accent} options={['#3B6EF5', '#2A9D6E', '#7A5AE0', '#E8772E']} onChange={v => setTweak('accent', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
