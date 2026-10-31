// ─────────────────────────────────────────────────────────────────────────────
// app.jsx — 시그널보드 앱 셸
//   탭 · 실시간 KPI 스트립 · 연결/장 상태 · 위젯 그리드(드래그 재배치) · 테마
//   관심종목 · 가격 알림 · 종목 상세 · Tweaks
// ─────────────────────────────────────────────────────────────────────────────
const { useState: aState, useEffect: aEffect, useCallback: aCb, useMemo: aMemo } = React;

const TABS = [
  { key: 'home',      label: '홈' },
  { key: 'market',    label: '시장' },
  { key: 'global',    label: '글로벌' },
  { key: 'ratesfx',   label: '금리·환율' },
  { key: 'dollar',    label: '달러' },
  { key: 'commodity', label: '원자재' },
  { key: 'flow',      label: '수급·심리' },
  { key: 'macro',     label: '매크로' },
  { key: 'watch',     label: '관심종목' },
];

const DEFAULT_WIDGETS = {
  home:      ['macroscore', 'kospi', 'kosdaq', 'usdkrw', 'summary', 'signals', 'feargreed', 'treemap-kospi', 'sectors', 'flow-foreign', 'breadth', 'flow-board'],
  market:    ['kospi', 'kosdaq', 'k200fut', 'board-kospi', 'board-kosdaq', 'breadth', 'sectors', 'movers', 'themes', 'program', 'treemap-kospi', 'treemap-kosdaq', 'vkospi'],
  global:    ['global', 'spx', 'ixic', 'sox', 'ndx', 'dji', 'n225', 'hsi', 'ssec', 'dax', 'sensex', 'vix'],
  ratesfx:   ['usdkrw', 'dxy', 'usdjpy', 'jpykrw', 'eurkrw', 'cnykrw', 'baserate', 'fedrate', 'policy-gap', 'ktb3', 'ktb10', 'kr-term', 'us2y', 'us10y', 'uskr10y', 'yield-curve'],
  dollar:    ['dollar-verdict', 'dollar-chart', 'dollar-signals', 'dollar-levels', 'dollar-bank', 'usdkrw', 'dxy', 'uskr10y', 'flow-foreign', 'jpykrw', 'cnykrw', 'vix'],
  commodity: ['wti', 'brent', 'gold', 'silver', 'copper', 'natgas', 'bdi'],
  flow:      ['flow-board', 'flow-foreign', 'flow-inst', 'flow-retail', 'flow-pension', 'credit', 'deposit', 'feargreed', 'vkospi', 'vix', 'flow-cum', 'foreign-kospi'],
  macro:     ['macroscore', 'signals', 'summary', 'correlation', 'yield-curve', 'uskr10y', 'us-term', 'feargreed'],
  watch:     ['watchlist', 'movers', 'themes', 'breadth'],
};

// v2: 탭·위젯 구성이 바뀌어 레이아웃은 새 기본값으로, 테마·기간·탭은 v1 에서 이어받는다
const LS_KEY = 'signalboard-state-v2';
function loadState() {
  const v2 = loadLocal(LS_KEY, null);
  if (v2) return v2;
  const v1 = loadLocal('signalboard-state-v1', {});
  return { theme: v1.theme, period: v1.period, tab: v1.tab };
}
function saveState(patch) { saveLocal(LS_KEY, { ...loadState(), ...patch }); }

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "기본",
  "colorRule": "한국식",
  "accent": "#3B6EF5"
}/*EDITMODE-END*/;

// ─── 상단 KPI 스트립 ──────────────────────────────────────────────────────────
const KPI_ITEMS = [
  { id: 'kospi', label: 'KOSPI', dec: 2 },
  { id: 'kosdaq', label: 'KOSDAQ', dec: 2 },
  { id: 'spx', label: 'S&P 500', dec: 2 },
  { id: 'ixic', label: 'NASDAQ', dec: 2 },
  { id: 'usdkrw', label: '원/달러', dec: 1 },
];

function KpiCard({ k, colors }) {
  const sample = useLive((s, i) => i.sample);
  const q = useLive(s => s.quotes[k.id]);
  const ind = IND_BY_ID[k.id];
  const value = sample ? getQuote(ind) : q && q.price != null ? { value: q.price, pct: q.change_percent } : null;
  const flash = useFlash(value ? value.value : null);
  const up = value && (value.pct || 0) >= 0;
  return (
    <div className="kpi-card" title={q && q.as_of ? `기준 ${fmtAsOf(q.as_of)}${q.delayed ? ` · ${q.delayed}분 지연` : ''}` : ''}>
      <span className="kpi-title">{k.label}{q && q.market_status === 'OPEN' && <span className="kpi-open" title="장중"></span>}</span>
      <span className={`kpi-value ${flash}`}>{value ? fmtNum(value.value, k.dec) : '–'}</span>
      <span className="kpi-change" style={{ color: value && value.pct != null ? (up ? colors.up : colors.down) : 'var(--text-3)' }}>
        {value && value.pct != null ? `${up ? '▲' : '▼'} ${Math.abs(value.pct).toFixed(2)}%` : '대기'}
      </span>
    </div>
  );
}

function ScoreKpi({ colors }) {
  const score = useLive(s => s.insights && s.insights.score);
  const flash = useFlash(score ? score.score : null);
  const tone = score && score.tone === 'risk_on' ? colors.up : score && score.tone === 'risk_off' ? colors.down : 'var(--text-2)';
  return (
    <div className="kpi-card" title="MacroScore — 한국 증시 매크로 환경 종합 점수 (0~100)">
      <span className="kpi-title">MacroScore</span>
      <span className={`kpi-value ${flash}`} style={{ color: tone }}>{score && score.score != null ? Math.round(score.score) : '–'}</span>
      <span className="kpi-change" style={{ color: tone }}>{score ? score.label : '대기'}</span>
    </div>
  );
}

const CONN_LABELS = {
  live: ['실시간', 'ok'], polling: ['폴링', 'info'], connecting: ['연결 중', 'warn'],
  reconnecting: ['재연결 중', 'warn'], offline: ['오프라인', 'bad'], paused: ['일시정지', 'muted'], sample: ['샘플', 'muted'],
};
function ConnPill() {
  const conn = useLive((s, i) => (i.sample ? 'sample' : i.conn));
  const [label, tone] = CONN_LABELS[conn] || CONN_LABELS.connecting;
  const tip = conn === 'live' ? '서버가 바뀐 데이터만 실시간으로 밀어줍니다 (SSE)'
    : conn === 'polling' ? '실시간 스트림을 쓸 수 없어 장 상태에 맞춘 주기로 확인합니다'
    : conn === 'paused' ? '실시간 갱신을 멈췄습니다' : '';
  return <span className={`conn-pill ${tone}`} title={tip}><span className="conn-dot"></span>{label}</span>;
}

function SessionMeta() {
  const meta = useLive(s => s.meta);
  const receivedAt = useLive((s, i) => i.receivedAt);
  if (!meta) return <div className="kpi-meta">연결 중…</div>;
  const s = meta.session;
  return (
    <div className="kpi-meta">
      <span>KRX <b className={s.krx === 'open' ? 'open' : ''}>{s.krx_label}</b> · 미국 <b className={s.us === 'open' ? 'open' : ''}>{s.us_label}</b></span>
      <span>{s.refresh_seconds}초 주기 · {receivedAt ? new Date(receivedAt).toLocaleTimeString('ko-KR') : ''}</span>
    </div>
  );
}

function KpiStrip({ colors }) {
  return (
    <div className="kpi-strip">
      {KPI_ITEMS.map(k => <KpiCard key={k.id} k={k} colors={colors} />)}
      <ScoreKpi colors={colors} />
      <SessionMeta />
    </div>
  );
}

function Banners() {
  const sample = useLive((s, i) => i.sample);
  const conn = useLive((s, i) => i.conn);
  const ever = useLive((s, i) => i.everConnected);
  const stale = useLive(s => (s.meta ? s.meta.stale_sources : null));
  if (sample) return <div className="banner">서버에 연결할 수 없어 <b>샘플 데이터</b>를 표시 중이에요. 터미널에서 <code>npm start</code> 로 서버를 실행하면 실시간 데이터로 바뀌어요.</div>;
  if (ever && conn === 'offline') return <div className="banner">서버 연결이 끊겨 마지막으로 받은 데이터를 표시 중이에요 — 자동으로 다시 연결합니다.</div>;
  if (stale && stale.length) return <div className="banner">일부 데이터 소스 응답이 없어 마지막 정상값을 표시 중이에요 ({stale.join(', ')})</div>;
  return null;
}

// 브라우저 탭 제목에 코스피 실시간 표시 (알림이 켜져 있으면 백그라운드에서도 갱신)
function useTitle() {
  const q = useLive(s => s.quotes.kospi);
  aEffect(() => {
    document.title = q && q.price != null && q.change_percent != null
      ? `코스피 ${fmtNum(q.price, 2)} ${q.change_percent >= 0 ? '▲' : '▼'}${Math.abs(q.change_percent).toFixed(2)}% · 시그널보드`
      : '시그널보드 — 실시간 국내·글로벌 증시 지표 대시보드';
  }, [q]);
}

function App() {
  const saved = loadState();
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const hashTab = (location.hash || '').replace('#', '');
  const [tab, setTab] = aState(TABS.some(x => x.key === hashTab) ? hashTab : (TABS.some(x => x.key === saved.tab) ? saved.tab : 'home'));
  const [theme, setTheme] = aState(saved.theme || 'light');
  const [period, setPeriod] = aState(PERIODS.some(p => p.key === saved.period) ? saved.period : '1y');
  const [widgets, setWidgets] = aState(() => ({ ...DEFAULT_WIDGETS, ...(saved.widgets || {}) }));
  const [modalOpen, setModalOpen] = aState(false);
  const [alertsOpen, setAlertsOpen] = aState(false);
  const [stock, setStock] = aState(null);
  const [dragIdx, setDragIdx] = aState(null);
  const [overIdx, setOverIdx] = aState(null);
  const [paused, setPaused] = aState(false);
  const [spinning, setSpinning] = aState(false);
  const [watch, setWatch] = aState(() => loadLocal('signalboard-watch-v1', []));
  const [rules, setRules] = aState(() => loadLocal('signalboard-alerts-v1', []));

  aEffect(() => { LiveStore.start(); }, []);
  aEffect(() => { document.documentElement.dataset.theme = theme; saveState({ theme }); }, [theme]);
  aEffect(() => { saveState({ tab }); if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`); }, [tab]);
  aEffect(() => { saveState({ period }); }, [period]);
  aEffect(() => { saveState({ widgets }); }, [widgets]);
  aEffect(() => { document.documentElement.style.setProperty('--accent', t.accent); }, [t.accent]);
  aEffect(() => { saveLocal('signalboard-watch-v1', watch); LiveStore.setWatch(watch.map(w => w.code)); }, [watch]);
  aEffect(() => { saveLocal('signalboard-alerts-v1', rules); LiveStore.setBackground(rules.some(r => r.enabled)); }, [rules]);
  aEffect(() => { LiveStore.setPaused(paused); }, [paused]);
  aEffect(() => {
    const onHash = () => { const h = location.hash.replace('#', ''); if (TABS.some(x => x.key === h)) setTab(h); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useAlerts(rules);
  useTitle();

  const kr = t.colorRule === '한국식';
  const colors = aMemo(() => ({ up: kr ? 'var(--kr-up)' : 'var(--us-up)', down: kr ? 'var(--kr-down)' : 'var(--us-down)' }), [kr]);
  const compact = t.density === '컴팩트';
  const themeKey = `${theme}|${t.accent}|${t.colorRule}`;

  const ui = aMemo(() => ({
    openStock: (code, name) => setStock({ code, name }),
    watch,
    addWatch: item => setWatch(ws => (ws.some(w => w.code === item.code) ? ws : [...ws, { code: item.code, name: item.name }])),
    removeWatch: code => setWatch(ws => ws.filter(w => w.code !== code)),
    addAlert: (rule, message) => {
      setRules(rs => [...rs, { id: `r${Date.now()}`, enabled: true, ...rule }]);
      toast({ title: '알림을 추가했어요', body: message || '' });
    },
  }), [watch]);

  const ids = widgets[tab] || [];
  const inds = ids.map(id => IND_BY_ID[id]).filter(Boolean);
  const setIds = next => setWidgets(w => ({ ...w, [tab]: next }));
  const removeWidget = id => setIds(ids.filter(x => x !== id));
  const addWidget = id => { if (!ids.includes(id)) setIds([...ids, id]); };
  const resetTab = () => setIds(DEFAULT_WIDGETS[tab] || []);

  const refresh = () => {
    setSpinning(true);
    LiveStore.refresh().finally(() => setTimeout(() => setSpinning(false), 400));
  };

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
  const tabLabel = (TABS.find(x => x.key === tab) || TABS[0]).label;
  const activeRules = rules.filter(r => r.enabled).length;

  return (
    <UiContext.Provider value={ui}>
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
              <ConnPill />
              <button className={`icon-btn ${paused ? 'auto-on' : ''}`} title={paused ? '실시간 갱신 다시 시작' : '실시간 갱신 일시정지'} onClick={() => setPaused(p => !p)}>
                {paused
                  ? <svg width="16" height="16" viewBox="0 0 16 16"><path d="M5 3.5 L12.5 8 L5 12.5 Z" fill="currentColor"></path></svg>
                  : <svg width="16" height="16" viewBox="0 0 16 16"><rect x="4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"></rect><rect x="9.4" y="3.5" width="2.6" height="9" rx="1" fill="currentColor"></rect></svg>}
              </button>
              <button className={`icon-btn ${spinning ? 'spinning' : ''}`} title="지금 새로고침" onClick={refresh}>
                <svg width="17" height="17" viewBox="0 0 17 17">
                  <path d="M14 8.5a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"></path>
                  <path d="M14 3 L14 6 L11 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"></path>
                </svg>
              </button>
              <button className={`icon-btn bell ${activeRules ? 'auto-on' : ''}`} title="가격 알림" onClick={() => setAlertsOpen(true)}>
                <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2.2a4 4 0 0 0-4 4v2.6L2.8 11h10.4L12 8.8V6.2a4 4 0 0 0-4-4Z M6.4 12.6a1.7 1.7 0 0 0 3.2 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"></path></svg>
                {activeRules > 0 && <span className="bell-count">{activeRules}</span>}
              </button>
              <button className="icon-btn theme-btn" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                      title={theme === 'light' ? '다크 모드' : '라이트 모드'}>
                {theme === 'light' ? (
                  <svg width="17" height="17" viewBox="0 0 17 17"><path d="M14 10.2 A6.3 6.3 0 1 1 7 3 A5 5 0 0 0 14 10.2 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"></path></svg>
                ) : (
                  <svg width="17" height="17" viewBox="0 0 17 17">
                    <circle cx="8.5" cy="8.5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5"></circle>
                    {[0, 45, 90, 135, 180, 225, 270, 315].map(a => { const r = a * Math.PI / 180; return <line key={a} x1={8.5 + Math.cos(r) * 5.4} y1={8.5 + Math.sin(r) * 5.4} x2={8.5 + Math.cos(r) * 7} y2={8.5 + Math.sin(r) * 7} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"></line>; })}
                  </svg>
                )}
              </button>
              <button className="primary-btn" onClick={() => setModalOpen(true)}>+ 위젯 추가</button>
            </div>
          </div>
        </header>

        <KpiStrip colors={colors} />
        <Banners />

        <div className="control-row">
          <h1 className="page-title">{tabLabel}</h1>
          <div className="control-right">
            <button className="text-btn" onClick={resetTab} title="이 탭을 기본 위젯 구성으로">기본 구성</button>
            <div className="seg" role="tablist" aria-label="기간">
              {PERIODS.map(p => (
                <button key={p.key} className={`seg-btn ${period === p.key ? 'active' : ''}`} onClick={() => setPeriod(p.key)}
                        title={p.key === '1d' ? '코스피·코스닥·코스피200·선물은 1분봉, 나머지는 1주' : ''}>{p.label}</button>
              ))}
            </div>
          </div>
        </div>

        <main className="grid" data-screen-label={`${tabLabel} 탭`}>
          {inds.map((ind, i) => (
            <WidgetCard key={ind.id} ind={ind} periodKey={period} colors={colors}
              compact={compact} onRemove={removeWidget} themeKey={themeKey}
              dragging={dragIdx === i} dragOver={overIdx === i}
              dragProps={{ draggable: true, onDragStart: e => onDragStart(i, e), onDragOver: e => onDragOver(i, e), onDrop: e => onDrop(i, e), onDragEnd }} />
          ))}
          <button className="empty-add" onClick={() => setModalOpen(true)}>
            <span className="empty-add-plus">+</span><span>위젯 추가하기</span>
          </button>
        </main>

        <footer className="foot-note">
          데이터: 네이버 증권(지수·환율·금리·원자재·수급·업종·종목) · TradingView(V-KOSPI 선물, 20분 지연) · Yahoo(히스토리 백업).
          <strong> LIVE</strong>는 실시간 데이터, <strong>지연</strong>은 소스 장애로 마지막 정상값, <strong>샘플</strong>은 서버 미연결 시 합성 데이터입니다.
          해외 지수는 거래소 규정상 일부 15분 지연될 수 있어요. 투자 판단의 책임은 본인에게 있습니다.
        </footer>

        {modalOpen && <AddWidgetModal activeIds={ids} onAdd={addWidget} onClose={() => setModalOpen(false)} />}
        {alertsOpen && <AlertsModal rules={rules} setRules={setRules} onClose={() => setAlertsOpen(false)} />}
        {stock && <StockModal code={stock.code} name={stock.name} onClose={() => setStock(null)} colors={colors} themeKey={themeKey} />}
        <Toasts />

        <TweaksPanel>
          <TweakSection label="레이아웃" />
          <TweakRadio label="카드 밀도" value={t.density} options={['기본', '컴팩트']} onChange={v => setTweak('density', v)} />
          <TweakSection label="컬러" />
          <TweakRadio label="등락 색상" value={t.colorRule} options={['한국식', '미국식']} onChange={v => setTweak('colorRule', v)} />
          <TweakColor label="액센트" value={t.accent} options={['#3B6EF5', '#2A9D6E', '#7A5AE0', '#E8772E']} onChange={v => setTweak('accent', v)} />
        </TweaksPanel>
      </div>
    </UiContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
