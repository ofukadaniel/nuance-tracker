// PWA: register service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      // Keep your original scope behavior. Adjust path if your app is not hosted at domain root.
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch (e) {
      console.error("Service worker registration failed:", e);
    }
  });
}

(function(){
  // ---------- Helpers ----------
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const round1 = (n) => Math.round(n * 10) / 10;

  function scoreToColor(score){
    if (score <= 54) return "#ef4444";
    if (score <= 64) return "#f97316";
    if (score <= 74) return "#eab308";
    return "#22c55e";
  }

  function isoDate(d){
    const x = new Date(d);
    x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
    return x.toISOString().slice(0,10);
  }

  function safeParseJSON(s, fallback){
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  const $ = (id) => document.getElementById(id);

  // ---------- Storage key ----------
  const LS_KEY = "nuance_tracker_v2_full";
  const THEME_KEY = "nuance_theme_v1";

  // ---------- Theme ----------
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  const metaScheme = document.querySelector('meta[name="color-scheme"]');

  function applyTheme(theme){
    const t = (theme === "light") ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);

    const themeLabel = $("themeLabel");
    if (themeLabel) themeLabel.textContent = (t === "light") ? "Light" : "Dark";

    // Update meta for better OS integration
    if (metaScheme) metaScheme.setAttribute("content", t);
    if (metaTheme) metaTheme.setAttribute("content", (t === "light") ? "#f6f8fc" : "#071426");

    localStorage.setItem(THEME_KEY, t);
  }

  function initTheme(){
    const saved = localStorage.getItem(THEME_KEY);
    applyTheme(saved || "dark");
  }

  // ---------- Confirm modal ----------
  let _confirmResolve = null;
  function openConfirm({ title="Confirm", body="Continue?", okText="Continue", danger=false }){
    $("confirmTitle").textContent = title;
    $("confirmBody").textContent = body;
    $("btnConfirmOk").textContent = okText;
    $("btnConfirmOk").classList.toggle("btn-danger", !!danger);
    $("btnConfirmOk").classList.toggle("btn-primary", !danger);
    $("confirmModal").classList.remove("hidden");
    return new Promise((resolve)=>{ _confirmResolve = resolve; });
  }
  function closeConfirm(result){
    $("confirmModal").classList.add("hidden");
    const r = _confirmResolve;
    _confirmResolve = null;
    if (r) r(result);
  }
  $("btnCloseConfirm").addEventListener("click", ()=>closeConfirm(false));
  $("btnConfirmCancel").addEventListener("click", ()=>closeConfirm(false));
  $("btnConfirmOk").addEventListener("click", ()=>closeConfirm(true));
  $("confirmModal").addEventListener("click", (e)=>{ if (e.target && e.target.id==="confirmModal") closeConfirm(false); });

  // ---------- Tier gating ----------
  const TIER_ORDER = ["Free","Pro","Elite"];
  const TAB_ORDER = ["dashboard","tutorial","analytics","builders","coach"];

  const TAB_REQUIREMENTS = {
    dashboard: "Free",
    tutorial: "Free",
    analytics: "Pro",
    builders: "Elite",
    coach: "Elite"
  };

  function tierRank(t){ return Math.max(0, TIER_ORDER.indexOf(t || "Free")); }
  function meetsTier(userTier, requiredTier){
    return tierRank(userTier) >= tierRank(requiredTier);
  }
  function requiredTierForTab(tab){
    return TAB_REQUIREMENTS[tab] || "Elite";
  }
  function tabLabel(tab){
    const map = { dashboard:"Dashboard", tutorial:"Tutorial", analytics:"Analytics", builders:"Builders", coach:"Consistency Coach" };
    return map[tab] || tab;
  }

  function openTierModal(tab){
    const sub = $("tierModalSub");
    const req = requiredTierForTab(tab);
    const t = state.userTier || "Free";
    sub.textContent = `“${tabLabel(tab)}” requires ${req}. Your tier is ${t}.`;
    $("tierModal").classList.remove("hidden");
  }
  function closeTierModal(){ $("tierModal").classList.add("hidden"); }
  $("btnCloseTierModal").addEventListener("click", closeTierModal);
  $("tierModal").addEventListener("click", (e)=>{ if (e.target && e.target.id==="tierModal") closeTierModal(); });

  document.querySelectorAll(".tierPick").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.userTier = btn.dataset.tier || "Free";
      saveState();
      syncTierUI();
      renderTabLocks();
      closeTierModal();
      if (!hasAccess(state.tab)) setTab("dashboard", { bypassGate:true });
    });
  });

  function syncTierUI(){
    const tierLabelEl = $("tierLabel");
    if (tierLabelEl) tierLabelEl.textContent = state.userTier || "Free";
  }

  // Owner override PIN hash
  async function sha256Hex(str){
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const bytes = Array.from(new Uint8Array(hash));
    return bytes.map(b=>b.toString(16).padStart(2,"0")).join("");
  }

  async function ensureOwnerPin(){
    if (state.ownerPinHash) return true;
    const pin = prompt("Set Owner PIN (4-12 digits). This unlocks Owner override on this device.");
    if (!pin) return false;
    if (!/^\d{4,12}$/.test(pin)){
      alert("PIN must be 4 to 12 digits.");
      return false;
    }
    state.ownerPinHash = await sha256Hex(pin);
    saveState();
    return true;
  }

  async function verifyOwnerPin(){
    if (!state.ownerPinHash){
      const ok = await ensureOwnerPin();
      return ok;
    }
    const pin = prompt("Enter Owner PIN:");
    if (!pin) return false;
    const h = await sha256Hex(pin);
    return h === state.ownerPinHash;
  }

  function hasAccess(tab){
    if (state.ownerOverride) return true;
    const req = requiredTierForTab(tab);
    return meetsTier(state.userTier || "Free", req);
  }

  function syncOwnerUI(){
    const ownerLabelEl = $("ownerLabel");
    const btnOwner = $("btnOwner");
    const btnChange = $("btnChangeOwnerPin");

    if (ownerLabelEl) ownerLabelEl.textContent = state.ownerOverride ? "On" : "Off";
    if (btnOwner) btnOwner.classList.toggle("btn-primary", !!state.ownerOverride);
    if (btnChange) btnChange.classList.toggle("hidden", !state.ownerOverride);
  }

  function renderTabLocks(){
    document.querySelectorAll(".tabBtn").forEach(b=>{
      const tab = b.dataset.tab;
      const req = requiredTierForTab(tab);
      const locked = !hasAccess(tab);

      const existing = b.querySelector(".lock-badge");
      if (existing) existing.remove();

      b.classList.toggle("locked-tab", locked);

      if (!state.ownerOverride && req !== "Free"){
        const badge = document.createElement("span");
        badge.className = "lock-badge";
        badge.textContent = req;
        b.appendChild(badge);
      }

      const t = state.userTier || "Free";
      b.title = state.ownerOverride ? "Owner override enabled" : (locked ? `Locked. Requires ${req}. Your tier is ${t}.` : `Unlocked. Tier: ${t}.`);
    });
  }

  $("btnTier").addEventListener("click", ()=> openTierModal(state.tab || "dashboard"));

  $("btnOwner").addEventListener("click", async ()=>{
    if (!state.ownerOverride){
      const ok = await verifyOwnerPin();
      if (!ok){ alert("Owner PIN incorrect."); return; }
      state.ownerOverride = true;
      saveState();
      syncOwnerUI();
      renderTabLocks();
      return;
    }
    const ok = await verifyOwnerPin();
    if (!ok){ alert("Owner PIN incorrect."); return; }
    state.ownerOverride = false;
    saveState();
    syncOwnerUI();
    renderTabLocks();
    if (!hasAccess(state.tab)) setTab("dashboard", { bypassGate:true });
  });

  $("btnChangeOwnerPin").addEventListener("click", async ()=>{
    const ok = await verifyOwnerPin();
    if (!ok){ alert("Owner PIN incorrect."); return; }
    const pin = prompt("Enter new Owner PIN (4-12 digits):");
    if (!pin) return;
    if (!/^\d{4,12}$/.test(pin)){ alert("PIN must be 4 to 12 digits."); return; }
    state.ownerPinHash = await sha256Hex(pin);
    saveState();
    alert("Owner PIN updated.");
  });

  // ---------- Defaults ----------
  function baseSliders(){
    return [
      { id:"fastingHours", name:"Fasting (11-24h)", type:"slider", completionType:"linear", min:11, max:24, step:0.5, perfWeight:24, recoveryWeight:8, impact:"both", onDashboard:true, order:1 },
      { id:"resistanceSets", name:"Resistance Training (8-30 sets)", type:"slider", completionType:"linear", min:8, max:30, step:1, perfWeight:30, recoveryWeight:18, impact:"both", onDashboard:true, order:2 },
      { id:"sleepHours", name:"Sleep (0-7h, credit at 5-7h)", type:"slider", completionType:"sleepCredit", min:0, max:7, step:0.25, creditMin:5, creditMax:7, perfWeight:25, recoveryWeight:22, impact:"both", onDashboard:true, order:3 },
      { id:"vestSets", name:"Body or Vest Weighted Exercise (8-30 sets)", type:"slider", completionType:"linear", min:8, max:30, step:1, perfWeight:15, recoveryWeight:6, impact:"both", onDashboard:true, order:4 }
    ];
  }

  function basePerfToggles(){
    return [
      { id:"cardio", name:"Cardio", type:"toggle", perfWeight:30, recoveryWeight:14, impact:"both", onDashboard:true, order:1 },
      { id:"steps", name:"Steps", type:"toggle", perfWeight:10, recoveryWeight:10, impact:"both", onDashboard:true, order:2 },
      { id:"protein", name:"Daily Protein REQ", type:"toggle", perfWeight:15, recoveryWeight:10, impact:"both", onDashboard:true, order:3 },
      { id:"omega3", name:"Omega-3", type:"toggle", perfWeight:15, recoveryWeight:10, impact:"both", onDashboard:true, order:4 },
      { id:"lowCarb", name:"Low Carb", type:"toggle", perfWeight:20, recoveryWeight:10, impact:"both", onDashboard:true, order:5 },
      { id:"suppStack", name:"Supplement Stack", type:"toggle", perfWeight:10, recoveryWeight:10, impact:"both", onDashboard:true, order:6 },
      { id:"deepWork", name:"Deep Work", type:"toggle", perfWeight:15, recoveryWeight:0, impact:"performance", onDashboard:true, order:7 },
      { id:"fiber", name:"Fiber", type:"toggle", perfWeight:10, recoveryWeight:0, impact:"performance", onDashboard:true, order:8 },
      { id:"sunlight", name:"Sunlight", type:"toggle", perfWeight:10, recoveryWeight:10, impact:"both", onDashboard:true, order:9 },
      { id:"stretching", name:"Stretching", type:"toggle", perfWeight:10, recoveryWeight:10, impact:"both", onDashboard:true, order:10 }
    ];
  }

  function basePenalties(){
    return [
      { id:"binge", name:"Binge Eating", type:"penaltyToggle", multiplier:0.80, impact:"both", onDashboard:true, order:1 },
      { id:"ultra", name:"Ultra Processed", type:"penaltyToggle", multiplier:0.80, impact:"both", onDashboard:true, order:2 },
      { id:"grazing", name:"Grazing", type:"penaltyToggle", multiplier:0.85, impact:"both", onDashboard:true, order:3 },
      { id:"late", name:"Late Eating", type:"penaltyToggle", multiplier:0.80, impact:"both", onDashboard:true, order:4 }
    ];
  }

  // ---------- PLACEHOLDERS (MODIFIED) ----------
  function performancePlaceholders(startOrder){
    const names = [
      "Journaling Session",
      "Meditation Practice",
      "Breathwork Session",
      "Red Light Therapy",
      "Cold Plunge Exposure",
      "Sauna Session",
      "Grounding",
      "Nature Walk",
      "Yoga Session",
      "Mobility Flow",
      "Skill Practice",
      "Creative Work",
      "Public Speaking Practice",
      "Reading for Growth",
      "Strategic Planning"
    ];

    return names.map((name, i)=>({
      id: "pf_ext_" + i,
      name,
      type:"toggle",
      perfWeight:10,
      recoveryWeight:5,
      impact:"both",
      onDashboard:false,
      order:startOrder + i
    }));
  }

  function penaltyPlaceholders(startOrder){
    const names = [
      "Doomscrolling",
      "Late Night Screen Use",
      "Missed Workout Commitment",
      "Emotional Eating",
      "High Sugar Intake",
      "Ultra High Sodium Meal",
      "Skipped Hydration",
      "Conflict Escalation",
      "Sleep Schedule Drift",
      "Social Isolation",
      "Excessive Caffeine",
      "Missed Morning Routine",
      "Poor Posture All Day",
      "Multitasking Overload",
      "No Outdoor Exposure"
    ];

    return names.map((name, i)=>({
      id: "pn_ext_" + i,
      name,
      type:"penaltyToggle",
      multiplier:0.90,
      impact:"both",
      onDashboard:false,
      order:startOrder + i
    }));
  }

  /* slider placeholder names replaced with your 10 new slider inputs */
  function sliderPlaceholders(startOrder){
    const names = [
      "Water Intake (Liters)",
      "Zone 2 Cardio Minutes",
      "Total Active Minutes",
      "Standing Hours",
      "Outdoor Time (Minutes)",
      "Protein Per Meal (Grams)",
      "Resistance Training Volume (Sets)",
      "Deep Work Duration (Minutes)",
      "Morning Routine Completion (%)",
      "Evening Routine Completion (%)"
    ];

    return names.map((name, i)=>({
      id: "sl_ext_" + i,
      name,
      type:"slider",
      completionType:"linear",
      min:0,
      max:10,
      step:1,
      perfWeight:10,
      recoveryWeight:5,
      impact:"both",
      onDashboard:false,
      order:startOrder + i
    }));
  }
  // ---------- END PLACEHOLDERS (MODIFIED) ----------

  const defaultState = {
    tab:"dashboard",
    tabIndex: 0,
    buildersSub:"sliders",
    date: isoDate(new Date()),
    mode:"High",
    personalizationMode:false,
    disableDriftTriggers:false,

    alcohol:"None",
    stress:"None",

    userTier:"Free",
    ownerOverride:false,
    ownerPinHash:"",

    catalogs: {
      sliders: [...baseSliders(), ...sliderPlaceholders(100)],
      perf:    [...basePerfToggles(), ...performancePlaceholders(100)],
      pen:     [...basePenalties(), ...penaltyPlaceholders(100)]
    },

    sliderValues: {},
    toggles: {},
    penalties: {},
    history: {},

    selected: { sliders:[], perf:[], pen:[] },
    builderSelected: { sliders:[], perf:[], pen:[] },

    undoStack: []
  };

  const alcoholMap = { None:1.00, Low:0.95, Med:0.85, High:0.60 };
  const stressMap  = { None:1.00, Low:0.95, Med:0.85, High:0.60 };

  function reviveSets(state){
    state.selected = {
      sliders: new Set(state.selected?.sliders || []),
      perf: new Set(state.selected?.perf || []),
      pen: new Set(state.selected?.pen || [])
    };
    state.builderSelected = {
      sliders: new Set(state.builderSelected?.sliders || []),
      perf: new Set(state.builderSelected?.perf || []),
      pen: new Set(state.builderSelected?.pen || [])
    };
    state.undoStack = Array.isArray(state.undoStack) ? state.undoStack : [];
    return state;
  }

  function stripSetsForSave(state){
    return {
      ...state,
      selected: { sliders:[...state.selected.sliders], perf:[...state.selected.perf], pen:[...state.selected.pen] },
      builderSelected: { sliders:[...state.builderSelected.sliders], perf:[...state.builderSelected.perf], pen:[...state.builderSelected.pen] }
    };
  }

  function hydrate(s){
    s.catalogs.sliders.forEach(item=>{
      if (s.sliderValues[item.id] === undefined){
        s.sliderValues[item.id] = (item.id === "sleepHours") ? 7 : item.min;
      }
    });
    s.catalogs.perf.forEach(item=>{
      if (s.toggles[item.id] === undefined) s.toggles[item.id] = 0;
    });
    s.catalogs.pen.forEach(item=>{
      if (s.penalties[item.id] === undefined) s.penalties[item.id] = 0;
    });
    return s;
  }

  function loadState(){
    const raw = localStorage.getItem(LS_KEY);
    const saved = raw ? safeParseJSON(raw, null) : null;
    if (!saved) return hydrate(reviveSets(structuredClone(defaultState)));
    const merged = { ...structuredClone(defaultState), ...saved };
    merged.catalogs = merged.catalogs || structuredClone(defaultState.catalogs);
    merged.sliderValues = merged.sliderValues || {};
    merged.toggles = merged.toggles || {};
    merged.penalties = merged.penalties || {};
    merged.history = merged.history || {};
    if (!merged.userTier) merged.userTier = "Free";
    if (merged.ownerOverride === undefined) merged.ownerOverride = false;
    if (!merged.ownerPinHash) merged.ownerPinHash = "";
    if (!merged.buildersSub) merged.buildersSub = "sliders";
    return hydrate(reviveSets(merged));
  }

  function saveState(){
    localStorage.setItem(LS_KEY, JSON.stringify(stripSetsForSave(state)));
  }

  function byOrder(a,b){
    return (Number(a.order||0) - Number(b.order||0)) || String(a.id).localeCompare(String(b.id));
  }

  function getCompletion(item, v){
    if (item.completionType === "sleepCredit"){
      const creditMin = Number(item.creditMin ?? 5);
      const creditMax = Number(item.creditMax ?? 7);
      if (v < creditMin) return 0;
      return clamp((v - creditMin) / (creditMax - creditMin), 0, 1);
    }
    const min = Number(item.min);
    const max = Number(item.max);
    if (!(max > min)) return 0;
    return clamp((v - min) / (max - min), 0, 1);
  }

  function isRecoveryCredit(id){
    return ["sleepHours","steps","stretching","omega3","protein","lowCarb","suppStack","sunlight"].includes(id);
  }
  function isRecoveryLoad(id){
    return ["resistanceSets","cardio"].includes(id);
  }

  // ---------- Init ----------
  let state = loadState();

  // Theme boot
  initTheme();
  $("btnTheme").addEventListener("click", ()=>{
    const next = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
    applyTheme(next);
  });

  // Date picker range
  const datePicker = $("datePicker");
  const today = new Date();
  const minDate = new Date(today); minDate.setFullYear(minDate.getFullYear() - 5);
  const maxDate = new Date(today); maxDate.setFullYear(maxDate.getFullYear() + 50);
  datePicker.min = isoDate(minDate);
  datePicker.max = isoDate(maxDate);
  datePicker.value = state.date;

  // ---------- Navigation ----------
  const deck = $("tabDeck");

  document.querySelectorAll(".tabBtn").forEach(btn=>{
    btn.addEventListener("click", ()=> setTab(btn.dataset.tab));
  });

  function setDeckIndex(idx){
    deck.style.transform = `translateX(${-idx * 100}%)`;
  }

  function setTab(tab, opts){
    const bypassGate = !!opts?.bypassGate;

    if (!bypassGate && !hasAccess(tab)){
      openTierModal(tab);
      return;
    }

    state.tab = tab;
    state.tabIndex = Math.max(0, TAB_ORDER.indexOf(tab));
    if (state.tabIndex < 0) state.tabIndex = 0;

    document.querySelectorAll(".tabBtn").forEach(b=>{
      b.classList.toggle("tab-on", b.dataset.tab === tab);
    });

    setDeckIndex(state.tabIndex);
    saveState();

    if (tab === "analytics") updateAnalytics(currentPeriodDays);
    if (tab === "coach") updateCoach();
    if (tab === "builders") renderBuilders();
  }

  function setBuildersSub(sub){
    state.buildersSub = sub;
    document.querySelectorAll(".subTabBtn").forEach(b=>{
      b.classList.toggle("subtab-on", b.dataset.sub === sub);
    });
    $("builders-sliders").classList.toggle("hidden", sub !== "sliders");
    $("builders-performance").classList.toggle("hidden", sub !== "performance");
    $("builders-penalties").classList.toggle("hidden", sub !== "penalties");
    saveState();
  }
  document.querySelectorAll(".subTabBtn").forEach(btn=>{
    btn.addEventListener("click", ()=> setBuildersSub(btn.dataset.sub));
  });

  // Tier UI boot
  syncTierUI();
  syncOwnerUI();
  renderTabLocks();
  setDeckIndex(state.tabIndex || 0);

  // Theme label boot (after state)
  const themeLabel = $("themeLabel");
  if (themeLabel) themeLabel.textContent = (document.documentElement.getAttribute("data-theme")==="light") ? "Light" : "Dark";

  // ---------- Mode buttons ----------
  document.querySelectorAll(".modeBtn").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const nextMode = btn.dataset.mode;
      if (nextMode === state.mode) return;

      const ok = await openConfirm({
        title: "Change Day Performance Mode",
        body: "This changes how the app interprets your status labels. Continue?",
        okText: "Change Mode"
      });
      if (!ok) return;

      state.mode = nextMode;
      syncModeUI();
      saveState();
      recalcIfAllowed();
    });
  });

  function syncModeUI(){
    document.querySelectorAll(".modeBtn").forEach(b=>{
      b.classList.toggle("chip-on", b.dataset.mode === state.mode);
    });
  }

  // Personalization Mode
  $("btnPersonalize").addEventListener("click", ()=>{
    state.personalizationMode = !state.personalizationMode;
    $("btnPersonalize").textContent = state.personalizationMode ? "On" : "Off";
    $("btnPersonalize").classList.toggle("btn-primary", state.personalizationMode);
    state.selected.sliders.clear();
    state.selected.perf.clear();
    state.selected.pen.clear();
    saveState();
    renderDashboard();
  });

  // Disable drift triggers
  $("btnDisableDrift").addEventListener("click", async ()=>{
    const next = !state.disableDriftTriggers;
    if (next){
      const ok = await openConfirm({
        title: "Disable Drift Triggers",
        body: "With drift triggers disabled, DRIFT will be forced only by low score. Alcohol, high stress, and binge triggers will no longer force DRIFT. Continue?",
        okText: "Disable"
      });
      if (!ok) return;
    }
    state.disableDriftTriggers = next;
    $("btnDisableDrift").textContent = state.disableDriftTriggers ? "On" : "Off";
    $("btnDisableDrift").classList.toggle("btn-primary", state.disableDriftTriggers);
    saveState();
    recalcIfAllowed();
  });

  // Segments
  document.querySelectorAll(".segAlcohol").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.alcohol = btn.dataset.val;
      syncSegments();
      saveState();
      recalcIfAllowed();
    });
  });
  document.querySelectorAll(".segStress").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.stress = btn.dataset.val;
      syncSegments();
      saveState();
      recalcIfAllowed();
    });
  });
  function syncSegments(){
    document.querySelectorAll(".segAlcohol").forEach(b=> b.classList.toggle("chip-on", b.dataset.val === state.alcohol));
    document.querySelectorAll(".segStress").forEach(b=> b.classList.toggle("chip-on", b.dataset.val === state.stress));
  }

  // Date change
  datePicker.addEventListener("change", ()=>{
    state.date = datePicker.value;
    loadDayIntoInputs(state.date);
    saveState();
  });

  function resetInputsForNewDate(){
    state.alcohol = "None";
    state.stress = "None";
    state.catalogs.sliders.forEach(s=>{ state.sliderValues[s.id] = (s.id==="sleepHours") ? 7 : s.min; });
    state.catalogs.perf.forEach(p=> state.toggles[p.id] = 0);
    state.catalogs.pen.forEach(p=> state.penalties[p.id] = 0);
    state.selected.sliders.clear(); state.selected.perf.clear(); state.selected.pen.clear();
    state.builderSelected.sliders.clear(); state.builderSelected.perf.clear(); state.builderSelected.pen.clear();
  }

  function loadDayIntoInputs(dateISO){
    const entry = state.history?.[dateISO];
    if (!entry){
      resetInputsForNewDate();
      renderDashboard();
      return;
    }
    state.mode = entry.mode || state.mode;
    state.alcohol = entry.alcohol || state.alcohol;
    state.stress = entry.stress || state.stress;
    state.sliderValues = { ...state.sliderValues, ...(entry.sliderValues || {}) };
    state.toggles = { ...state.toggles, ...(entry.toggles || {}) };
    state.penalties = { ...state.penalties, ...(entry.penalties || {}) };
    hydrate(state);
    renderDashboard();
  }

  // Save Day
  $("btnSave").addEventListener("click", ()=>{
    const snap = computeScores();
    state.history[state.date] = {
      date: state.date,
      mode: state.mode,
      alcohol: state.alcohol,
      stress: state.stress,
      sliderValues: { ...state.sliderValues },
      toggles: { ...state.toggles },
      penalties: { ...state.penalties },
      baseScore: snap.baseScore,
      score: snap.score,
      baseRecovery: snap.baseRecovery,
      recovery: snap.recovery,
      status: snap.status
    };
    saveState();
    renderHistoryTable();
    if (state.tab === "analytics") updateAnalytics(currentPeriodDays);
    if (state.tab === "coach") updateCoach();
  });

  // Clear History
  $("btnClearHistory").addEventListener("click", async ()=>{
    const hasAny = !!Object.keys(state.history || {}).length;
    if (!hasAny){
      await openConfirm({ title:"Clear History", body:"No history to clear.", okText:"OK" });
      return;
    }
    const ok = await openConfirm({
      title: "Clear History",
      body: "This permanently deletes all saved days on this device. Continue?",
      okText: "Delete",
      danger: true
    });
    if (!ok) return;

    state.history = {};
    saveState();
    renderHistoryTable();
    if (state.tab === "analytics") updateAnalytics(currentPeriodDays);
    if (state.tab === "coach") updateCoach();
  });

  // ---------- Undo ----------
  function snapshotForUndo(){
    state.undoStack.push({
      catalogs: structuredClone(state.catalogs),
      sliderValues: structuredClone(state.sliderValues),
      toggles: structuredClone(state.toggles),
      penalties: structuredClone(state.penalties)
    });
    if (state.undoStack.length > 20) state.undoStack.shift();
    saveState();
  }

  $("btnUndo").addEventListener("click", ()=>{
    const last = state.undoStack.pop();
    if (!last){ alert("Nothing to undo."); return; }
    state.catalogs = last.catalogs;
    state.sliderValues = last.sliderValues;
    state.toggles = last.toggles;
    state.penalties = last.penalties;
    saveState();
    renderDashboard();
    renderBuilders();
    if (state.tab === "coach") updateCoach();
    if (state.tab === "analytics") updateAnalytics(currentPeriodDays);
  });

  async function requirePersonalizationOrExplain(){
    if (state.personalizationMode) return true;
    await openConfirm({
      title:"Personalization Mode Required",
      body:"Enable Personalization Mode to move items between Dashboard and Builders.",
      okText:"OK"
    });
    return false;
  }

  // ---------- Move to Builders (Dashboard -> Builders) ----------
  $("btnMoveSliders").addEventListener("click", async ()=>{
    if (!(await requirePersonalizationOrExplain())) return;
    if (!state.selected.sliders.size){ alert("No sliders selected."); return; }

    const ok = await openConfirm({
      title:"Move Selected Sliders",
      body:"This moves selected sliders off the Dashboard into Builders. Continue?",
      okText:"Move"
    });
    if (!ok) return;

    snapshotForUndo();
    state.selected.sliders.forEach(id=>{
      const item = state.catalogs.sliders.find(x=>x.id===id);
      if (item) item.onDashboard = false;
    });
    state.selected.sliders.clear();
    saveState();
    renderDashboard();
    renderBuilders();
  });

  $("btnMovePerformance").addEventListener("click", async ()=>{
    if (!(await requirePersonalizationOrExplain())) return;
    if (!state.selected.perf.size){ alert("No performance items selected."); return; }

    const ok = await openConfirm({
      title:"Move Selected Performance Items",
      body:"This moves selected performance items off the Dashboard into Builders. Continue?",
      okText:"Move"
    });
    if (!ok) return;

    snapshotForUndo();
    state.selected.perf.forEach(id=>{
      const item = state.catalogs.perf.find(x=>x.id===id);
      if (item) item.onDashboard = false;
    });
    state.selected.perf.clear();
    saveState();
    renderDashboard();
    renderBuilders();
  });

  $("btnMovePenalties").addEventListener("click", async ()=>{
    if (!(await requirePersonalizationOrExplain())) return;
    if (!state.selected.pen.size){ alert("No penalties selected."); return; }

    const ok = await openConfirm({
      title:"Move Selected Penalties",
      body:"This moves selected penalty toggles off the Dashboard into Builders. Continue?",
      okText:"Move"
    });
    if (!ok) return;

    snapshotForUndo();
    state.selected.pen.forEach(id=>{
      const item = state.catalogs.pen.find(x=>x.id===id);
      if (item) item.onDashboard = false;
    });
    state.selected.pen.clear();
    saveState();
    renderDashboard();
    renderBuilders();
  });

  // ---------- Add to Dashboard (Builders -> Dashboard) ----------
  async function addSelectedToDashboard(kind){
    if (!(await requirePersonalizationOrExplain())) return;

    const map = {
      sliders: { set: state.builderSelected.sliders, list: state.catalogs.sliders, label:"Sliders" },
      perf:    { set: state.builderSelected.perf,    list: state.catalogs.perf,    label:"Performance Items" },
      pen:     { set: state.builderSelected.pen,     list: state.catalogs.pen,     label:"Penalties" }
    };
    const cfg = map[kind];
    if (!cfg.set.size){ alert(`No ${cfg.label.toLowerCase()} selected.`); return; }

    const duplicates = [];
    cfg.set.forEach(id=>{
      const item = cfg.list.find(x=>x.id===id);
      if (item && item.onDashboard) duplicates.push(item.name);
    });

    const body = duplicates.length
      ? `Some selected items are already on the Dashboard and will be skipped: ${duplicates.slice(0,6).join(", ")}${duplicates.length>6?"...":""}. Continue adding the rest?`
      : `This adds selected ${cfg.label.toLowerCase()} to the Dashboard. Continue?`;

    const ok = await openConfirm({
      title:`Add Selected to Dashboard`,
      body,
      okText:"Add"
    });
    if (!ok) return;

    snapshotForUndo();
    cfg.set.forEach(id=>{
      const item = cfg.list.find(x=>x.id===id);
      if (item) item.onDashboard = true;
    });
    cfg.set.clear();
    saveState();
    renderDashboard();
    renderBuilders();
  }

  $("btnAddSelectedSlidersToDash").addEventListener("click", ()=>addSelectedToDashboard("sliders"));
  $("btnAddSelectedPerfToDash").addEventListener("click", ()=>addSelectedToDashboard("perf"));
  $("btnAddSelectedPenToDash").addEventListener("click", ()=>addSelectedToDashboard("pen"));

  // ---------- Add items ----------
  $("btnAddSliderItem").addEventListener("click", ()=>{
    const name = prompt("Slider name?");
    if (!name) return;
    snapshotForUndo();
    const id = "sl_custom_" + Math.random().toString(16).slice(2);
    const nextOrder = Math.max(...state.catalogs.sliders.map(x=>Number(x.order||0)), 0) + 1;
    state.catalogs.sliders.push({ id, name, type:"slider", completionType:"linear", min:0, max:10, step:1, perfWeight:10, recoveryWeight:5, impact:"both", onDashboard:false, order: nextOrder });
    state.sliderValues[id] = 0;
    saveState();
    renderBuilders();
  });

  $("btnAddPerfItem").addEventListener("click", ()=>{
    const name = prompt("Performance indicator name?");
    if (!name) return;
    snapshotForUndo();
    const id = "pf_custom_" + Math.random().toString(16).slice(2);
    const nextOrder = Math.max(...state.catalogs.perf.map(x=>Number(x.order||0)), 0) + 1;
    state.catalogs.perf.push({ id, name, type:"toggle", perfWeight:10, recoveryWeight:5, impact:"both", onDashboard:false, order: nextOrder });
    state.toggles[id] = 0;
    saveState();
    renderBuilders();
  });

  $("btnAddPenItem").addEventListener("click", ()=>{
    const name = prompt("Penalty name?");
    if (!name) return;
    snapshotForUndo();
    const id = "pn_custom_" + Math.random().toString(16).slice(2);
    const nextOrder = Math.max(...state.catalogs.pen.map(x=>Number(x.order||0)), 0) + 1;
    state.catalogs.pen.push({ id, name, type:"penaltyToggle", multiplier:0.90, impact:"both", onDashboard:false, order: nextOrder });
    state.penalties[id] = 0;
    saveState();
    renderBuilders();
  });

  // ---------- Dashboard rendering ----------
  function setInputsEnabled(enabled){
    const dash = $("tab-dashboard");
    const controls = dash.querySelectorAll("input,button.segAlcohol,button.segStress,.toggleBtn,.sliderEl");

    controls.forEach(el=>{
      const isAlwaysAllowed =
        el.id === "btnPersonalize" ||
        el.id === "btnDisableDrift" ||
        el.id === "btnSave" ||
        el.id === "btnClearHistory" ||
        el.id === "datePicker" ||
        el.id === "btnMoveSliders" ||
        el.id === "btnMovePerformance" ||
        el.id === "btnMovePenalties";

      const isSelectableDashboardControl =
        el.classList.contains("toggleBtn") ||
        el.classList.contains("sliderEl") ||
        el.classList.contains("segAlcohol") ||
        el.classList.contains("segStress");

      if (!enabled){
        if (isAlwaysAllowed) return;

        if (isSelectableDashboardControl){
          el.removeAttribute("disabled");
          el.classList.remove("disabled");
          return;
        }

        el.setAttribute("disabled","disabled");
        el.classList.add("disabled");
        return;
      }

      el.removeAttribute("disabled");
      el.classList.remove("disabled");
    });

    $("btnMoveSliders").classList.toggle("btn-primary", state.personalizationMode);
    $("btnMovePerformance").classList.toggle("btn-primary", state.personalizationMode);
    $("btnMovePenalties").classList.toggle("btn-primary", state.personalizationMode);
  }

  function renderDashboard(){
    hydrate(state);
    renderSliders();
    renderPerformanceToggles();
    renderPenaltyToggles();
    syncModeUI();
    syncSegments();
    $("btnPersonalize").textContent = state.personalizationMode ? "On" : "Off";
    $("btnPersonalize").classList.toggle("btn-primary", state.personalizationMode);
    $("btnDisableDrift").textContent = state.disableDriftTriggers ? "On" : "Off";
    $("btnDisableDrift").classList.toggle("btn-primary", state.disableDriftTriggers);

    setInputsEnabled(!state.personalizationMode);

    renderHistoryTable();
    recalcIfAllowed();
  }

  function renderSliders(){
    const wrap = $("sliderInputs");
    wrap.innerHTML = "";
    const items = state.catalogs.sliders.filter(x=>x.onDashboard && x.type==="slider").slice().sort(byOrder);
    items.forEach(item=>{
      const selected = state.selected.sliders.has(item.id);
      const row = document.createElement("div");
      row.className = "card rounded-xl p-3 " + (state.personalizationMode ? "selectable " : "");
      if (state.personalizationMode && selected) row.classList.add("selected-outline");

      row.addEventListener("click", (e)=>{
        if (!state.personalizationMode) return;
        if (e.target && e.target.type === "range") return;
        if (state.selected.sliders.has(item.id)) state.selected.sliders.delete(item.id);
        else state.selected.sliders.add(item.id);
        saveState();
        renderSliders();
      });

      const v = Number(state.sliderValues[item.id] ?? item.min);

      const top = document.createElement("div");
      top.className = "flex items-center justify-between gap-2";
      top.innerHTML = `
        <div>
          <div class="text-sky-200 text-sm font-semibold">${escapeHtml(item.name)}</div>
          <div class="text-blue-200/70 text-xs">Perf weight: <span class="mono">${item.perfWeight}</span> | Recovery weight: <span class="mono">${item.recoveryWeight}</span></div>
        </div>
        <div class="mono text-white font-semibold">${formatSliderValue(item, v)}</div>
      `;

      const slider = document.createElement("input");
      slider.className = "sliderEl mt-3 w-full";
      slider.type = "range";
      slider.min = item.min;
      slider.max = item.max;
      slider.step = item.step;
      slider.value = v;

      slider.addEventListener("input", ()=>{
        state.sliderValues[item.id] = parseFloat(slider.value);
        saveState();
        if (!state.personalizationMode){
          renderSliders();
          recalcIfAllowed();
        } else {
          top.querySelector(".mono.text-white").textContent = formatSliderValue(item, state.sliderValues[item.id]);
        }
      });

      row.appendChild(top);
      row.appendChild(slider);
      wrap.appendChild(row);
    });
  }

  function formatSliderValue(item, v){
    const isHours = item.id.includes("Hours") || item.name.includes("Sleep") || item.name.includes("Fasting");
    if (isHours) return `${round1(v)}h`;
    return `${Math.round(v)} sets`;
  }

  function renderPerformanceToggles(){
    const wrap = $("performanceToggles");
    wrap.innerHTML = "";
    const items = state.catalogs.perf.filter(x=>x.onDashboard && x.type==="toggle").slice().sort(byOrder);
    items.forEach(item=>{
      const on = !!state.toggles[item.id];
      const selected = state.selected.perf.has(item.id);

      const btn = document.createElement("button");
      btn.className = "toggleBtn rounded-xl px-3 py-3 text-left text-sm font-semibold chip " + (on ? "chip-on" : "");
      if (state.personalizationMode) btn.classList.add("selectable");
      if (state.personalizationMode && selected) btn.classList.add("selected-outline");
      btn.innerHTML = `
        <div class="text-sky-200">${escapeHtml(item.name)}</div>
        <div class="text-blue-200/70 text-xs">Perf <span class="mono">${item.perfWeight}</span> | Rec <span class="mono">${item.recoveryWeight}</span></div>
      `;

      btn.addEventListener("click", ()=>{
        if (state.personalizationMode){
          if (state.selected.perf.has(item.id)) state.selected.perf.delete(item.id);
          else state.selected.perf.add(item.id);
          saveState();
          renderPerformanceToggles();
          return;
        }
        state.toggles[item.id] = on ? 0 : 1;
        saveState();
        renderPerformanceToggles();
        recalcIfAllowed();
      });

      wrap.appendChild(btn);
    });
  }

  function renderPenaltyToggles(){
    const wrap = $("penaltyToggles");
    wrap.innerHTML = "";
    const items = state.catalogs.pen.filter(x=>x.onDashboard && x.type==="penaltyToggle").slice().sort(byOrder);
    items.forEach(item=>{
      const on = !!state.penalties[item.id];
      const selected = state.selected.pen.has(item.id);

      const btn = document.createElement("button");
      btn.className = "toggleBtn rounded-xl px-3 py-3 text-left text-sm font-semibold chip " + (on ? "pen-on" : "");
      if (state.personalizationMode) btn.classList.add("selectable");
      if (state.personalizationMode && selected) btn.classList.add("selected-outline");
      btn.innerHTML = `
        <div class="text-sky-200">${escapeHtml(item.name)}</div>
        <div class="text-blue-200/70 text-xs">Multiplier <span class="mono">${Number(item.multiplier).toFixed(2)}</span></div>
      `;

      btn.addEventListener("click", ()=>{
        if (state.personalizationMode){
          if (state.selected.pen.has(item.id)) state.selected.pen.delete(item.id);
          else state.selected.pen.add(item.id);
          saveState();
          renderPenaltyToggles();
          return;
        }
        state.penalties[item.id] = on ? 0 : 1;
        saveState();
        renderPenaltyToggles();
        recalcIfAllowed();
      });

      wrap.appendChild(btn);
    });
  }

  // ---------- Scoring ----------
  function computeBaseScore(){
    const perfItems = [];
    state.catalogs.sliders.filter(x=>x.onDashboard && x.type==="slider").forEach(item=>{
      const v = Number(state.sliderValues[item.id] ?? item.min);
      perfItems.push({ w:Number(item.perfWeight)||0, c:getCompletion(item, v), id:item.id });
    });
    state.catalogs.perf.filter(x=>x.onDashboard && x.type==="toggle").forEach(item=>{
      perfItems.push({ w:Number(item.perfWeight)||0, c:(state.toggles[item.id] ? 1 : 0), id:item.id });
    });
    const wSum = perfItems.reduce((a,x)=>a + x.w, 0);
    const contrib = perfItems.reduce((a,x)=>a + x.w * clamp(x.c,0,1), 0);
    const base = wSum > 0 ? (contrib / wSum) * 100 : 0;
    return clamp(base, 0, 100);
  }

  function computePenaltyProduct(){
    let prod = 1.0;
    prod *= alcoholMap[state.alcohol] ?? 1.0;
    prod *= stressMap[state.stress] ?? 1.0;
    state.catalogs.pen.forEach(item=>{
      if (item.type !== "penaltyToggle") return;
      if (state.penalties[item.id]) prod *= Number(item.multiplier) || 1.0;
    });
    const sh = Number(state.sliderValues.sleepHours ?? 0);
    if (sh < 4) prod *= 0.80;
    return prod;
  }

  function computeRecoveryWeightsNormalized(){
    const contributors = [];

    state.catalogs.sliders.forEach(item=>{
      if ((item.impact === "recovery" || item.impact === "both") && Number(item.recoveryWeight) > 0) contributors.push(item);
    });
    state.catalogs.perf.forEach(item=>{
      if ((item.impact === "recovery" || item.impact === "both") && Number(item.recoveryWeight) > 0) contributors.push(item);
    });

    const sum = contributors.reduce((a,x)=>a + (Number(x.recoveryWeight)||0), 0);
    if (sum <= 0) return { contributors, norm: ()=>0 };
    return { contributors, norm: (item)=> (Number(item.recoveryWeight)||0) * (100 / sum) };
  }

  function computeRecovery(){
    const { contributors, norm } = computeRecoveryWeightsNormalized();
    let credits = 0;
    let load = 0;

    contributors.forEach(item=>{
      const w = norm(item);
      let c = 0;

      if (item.type === "slider"){
        const v = Number(state.sliderValues[item.id] ?? item.min);
        c = getCompletion(item, v);
      } else if (item.type === "toggle"){
        c = state.toggles[item.id] ? 1 : 0;
      }

      if (isRecoveryLoad(item.id)) load += w * c;
      else if (isRecoveryCredit(item.id)) credits += w * c;
      else credits += w * c;
    });

    const baseRecovery = clamp(credits - load, 0, 100);

    const stressMult = stressMap[state.stress] ?? 1.0;
    let penProd = 1.0;
    penProd *= alcoholMap[state.alcohol] ?? 1.0;
    state.catalogs.pen.forEach(item=>{
      if (item.type !== "penaltyToggle") return;
      if (state.penalties[item.id]) penProd *= Number(item.multiplier) || 1.0;
    });
    const sh = Number(state.sliderValues.sleepHours ?? 0);
    if (sh < 4) penProd *= 0.80;

    const recovery = clamp(baseRecovery * stressMult * penProd, 0, 100);
    return { baseRecovery, recovery };
  }

  function determineStatus(score){
    const driftForcedByScore = score < 55;
    const highAlcohol = state.alcohol === "High";
    const highStress = state.stress === "High";
    const binge = !!state.penalties["binge"];
    const driftTriggersEnabled = !state.disableDriftTriggers;
    const driftForcedByTriggers = driftTriggersEnabled && (highAlcohol || highStress || binge);
    if (driftForcedByScore || driftForcedByTriggers) return "DRIFT";

    if (state.mode === "High"){
      if (score >= 80) return "HIGH OUTPUT";
      if (score >= 65) return "ON TRACK";
      return "HOLD";
    }
    if (state.mode === "Medium"){
      if (score >= 75) return "SOLID";
      if (score >= 60) return "ON TRACK";
      return "HOLD";
    }
    if (score >= 70) return "RECOVERY-READY";
    if (score >= 55) return "MAINTENANCE";
    return "HOLD";
  }

  function computeScores(){
    const baseScore = computeBaseScore();
    const penaltyProduct = computePenaltyProduct();
    const score = clamp(baseScore * penaltyProduct, 0, 100);
    const rec = computeRecovery();
    const status = determineStatus(score);
    return { baseScore, penaltyProduct, score, baseRecovery: rec.baseRecovery, recovery: rec.recovery, status };
  }

  function recalcIfAllowed(){
    if (state.personalizationMode) return;
    renderResults(computeScores());
  }

  function ringSVG(value, color){
    const pct = clamp(value,0,100);
    const r = 62;
    const c = 2 * Math.PI * r;
    const off = c - (pct/100) * c;
    return `
      <svg viewBox="0 0 160 160" class="w-[152px] h-[152px]">
        <circle cx="80" cy="80" r="${r}" fill="none" stroke="#143457" stroke-width="12"></circle>
        <circle cx="80" cy="80" r="${r}" fill="none" stroke="${color}" stroke-width="12"
                stroke-linecap="round"
                stroke-dasharray="${c}"
                stroke-dashoffset="${off}"
                transform="rotate(-90 80 80)"></circle>
        <text x="80" y="78" text-anchor="middle" class="mono" font-size="28" font-weight="700" fill="${color}">${Math.round(pct)}</text>
        <text x="80" y="102" text-anchor="middle" font-size="12" font-weight="600" fill="rgba(191,219,254,0.85)">percent</text>
      </svg>
    `;
  }

  function renderResults(snap){
    $("penaltyProduct").textContent = snap.penaltyProduct.toFixed(2);
    $("baseScore").textContent = round1(snap.baseScore).toFixed(1);
    $("finalScore").textContent = round1(snap.score).toFixed(1);
    $("baseRecovery").textContent = round1(snap.baseRecovery).toFixed(1);
    $("finalRecovery").textContent = round1(snap.recovery).toFixed(1);
    const perfColor = scoreToColor(snap.score);
    const recColor  = scoreToColor(snap.recovery);
    $("perfRing").innerHTML = ringSVG(snap.score, perfColor);
    $("recoveryRing").innerHTML = ringSVG(snap.recovery, recColor);
    const badge = $("statusBadge");
    badge.textContent = snap.status;
    badge.style.borderColor = perfColor;
    badge.style.background = "rgba(11,31,58,0.65)";
    badge.style.color = perfColor;
  }

  // ---------- History ----------
  function getHistoryArray(){
    return Object.values(state.history || {}).sort((a,b)=> a.date.localeCompare(b.date));
  }

  function renderHistoryTable(){
    const tbody = $("historyTable");
    tbody.innerHTML = "";
    const arr = getHistoryArray();
    const last7 = arr.slice(-7).reverse();
    last7.forEach(e=>{
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="py-2 pr-2">${e.date}</td>
        <td class="py-2 px-2 text-right mono text-white font-semibold" style="color:${scoreToColor(e.score)}">${Math.round(e.score)}</td>
        <td class="py-2 px-2 text-right mono text-white font-semibold" style="color:${scoreToColor(e.recovery)}">${Math.round(e.recovery)}</td>
        <td class="py-2 pl-2 text-right"><span class="mono" style="color:${scoreToColor(e.score)}">${escapeHtml(e.status || "")}</span></td>
      `;
      tbody.appendChild(tr);
    });
    if (last7.length === 0){
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="py-2 text-blue-200/70" colspan="4">No saved entries.</td>`;
      tbody.appendChild(tr);
    }
  }

  // ---------- Builders ----------
  function renderBuilders(){
    setBuildersSub(state.buildersSub || "sliders");
    renderSliderBuilder();
    renderPerformanceBuilder();
    renderPenaltiesBuilder();
  }

  function toggleBuilderSelection(kind, id){
    const set = state.builderSelected[kind];
    if (set.has(id)) set.delete(id);
    else set.add(id);
    saveState();
    renderBuilders();
  }

  function makeImpactSelect(current, onChange){
    const sel = document.createElement("select");
    sel.className = "table-input table-input-wide";
    ["both","performance","recovery"].forEach(v=>{
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if (v === (current || "both")) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", ()=>onChange(sel.value));
    return sel;
  }

  function makeDashboardToggle(current, onChange){
    const sel = document.createElement("select");
    sel.className = "table-input";
    ["true","false"].forEach(v=>{
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v === "true" ? "Yes" : "No";
      if ((current ? "true" : "false") === v) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", ()=>onChange(sel.value === "true"));
    return sel;
  }

  function makeRowActions({ onUp, onDown, onDelete }){
    const wrap = document.createElement("div");
    wrap.className = "flex justify-end gap-2";
    const up = document.createElement("button");
    up.className = "mini-btn";
    up.textContent = "Up";
    up.addEventListener("click", onUp);

    const down = document.createElement("button");
    down.className = "mini-btn";
    down.textContent = "Down";
    down.addEventListener("click", onDown);

    const del = document.createElement("button");
    del.className = "mini-btn mini-danger";
    del.textContent = "Delete";
    del.addEventListener("click", onDelete);

    wrap.appendChild(up);
    wrap.appendChild(down);
    wrap.appendChild(del);
    return wrap;
  }

  function swapOrder(list, idxA, idxB){
    if (idxA < 0 || idxB < 0 || idxA >= list.length || idxB >= list.length) return;
    const a = list[idxA];
    const b = list[idxB];
    const ao = Number(a.order || 0);
    const bo = Number(b.order || 0);
    a.order = bo;
    b.order = ao;
  }

  function renderSliderBuilder(){
    const tbody = $("sliderBuilderTable");
    tbody.innerHTML = "";
    const items = state.catalogs.sliders.slice().sort(byOrder);

    items.forEach((item)=>{
      const selected = state.builderSelected.sliders.has(item.id);

      const tr = document.createElement("tr");
      tr.className = "border-t border-[#143457]";

      const tdSel = document.createElement("td");
      tdSel.className = "py-2 pr-2";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected;
      cb.addEventListener("change", ()=>toggleBuilderSelection("sliders", item.id));
      tdSel.appendChild(cb);

      const tdOrder = document.createElement("td");
      tdOrder.className = "py-2 px-2";
      const inOrder = document.createElement("input");
      inOrder.type = "number";
      inOrder.className = "table-input";
      inOrder.value = Number(item.order || 0);
      inOrder.addEventListener("change", ()=>{
        snapshotForUndo();
        item.order = Number(inOrder.value || 0);
        saveState();
        renderBuilders();
        renderDashboard();
      });
      tdOrder.appendChild(inOrder);

      const tdName = document.createElement("td");
      tdName.className = "py-2 px-2";
      const inName = document.createElement("input");
      inName.type = "text";
      inName.className = "table-input table-input-wide";
      inName.value = item.name || "";
      inName.addEventListener("change", ()=>{
        snapshotForUndo();
        item.name = inName.value || item.name;
        saveState();
        renderBuilders();
        renderDashboard();
      });
      tdName.appendChild(inName);

      const tdPW = document.createElement("td");
      tdPW.className = "py-2 px-2 text-right";
      const inPW = document.createElement("input");
      inPW.type = "number";
      inPW.className = "table-input";
      inPW.value = Number(item.perfWeight || 0);
      inPW.addEventListener("change", ()=>{
        snapshotForUndo();
        item.perfWeight = Number(inPW.value || 0);
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      });
      tdPW.appendChild(inPW);

      const tdRW = document.createElement("td");
      tdRW.className = "py-2 px-2 text-right";
      const inRW = document.createElement("input");
      inRW.type = "number";
      inRW.className = "table-input";
      inRW.value = Number(item.recoveryWeight || 0);
      inRW.addEventListener("change", ()=>{
        snapshotForUndo();
        item.recoveryWeight = Number(inRW.value || 0);
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      });
      tdRW.appendChild(inRW);

      const tdImpact = document.createElement("td");
      tdImpact.className = "py-2 px-2";
      tdImpact.appendChild(makeImpactSelect(item.impact, (val)=>{
        snapshotForUndo();
        item.impact = val;
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      }));

      const tdDash = document.createElement("td");
      tdDash.className = "py-2 px-2";
      tdDash.appendChild(makeDashboardToggle(!!item.onDashboard, (val)=>{
        snapshotForUndo();
        item.onDashboard = val;
        saveState();
        renderDashboard();
        renderBuilders();
      }));

      const tdAct = document.createElement("td");
      tdAct.className = "py-2 pl-2";
      tdAct.appendChild(makeRowActions({
        onUp: ()=>{
          snapshotForUndo();
          const sorted = state.catalogs.sliders.slice().sort(byOrder);
          const pos = sorted.findIndex(x=>x.id===item.id);
          if (pos <= 0) return;
          const prevId = sorted[pos-1].id;
          const aIdx = state.catalogs.sliders.findIndex(x=>x.id===item.id);
          const bIdx = state.catalogs.sliders.findIndex(x=>x.id===prevId);
          swapOrder(state.catalogs.sliders, aIdx, bIdx);
          saveState();
          renderBuilders();
          renderDashboard();
        },
        onDown: ()=>{
          snapshotForUndo();
          const sorted = state.catalogs.sliders.slice().sort(byOrder);
          const pos = sorted.findIndex(x=>x.id===item.id);
          if (pos < 0 || pos >= sorted.length-1) return;
          const nextId = sorted[pos+1].id;
          const aIdx = state.catalogs.sliders.findIndex(x=>x.id===item.id);
          const bIdx = state.catalogs.sliders.findIndex(x=>x.id===nextId);
          swapOrder(state.catalogs.sliders, aIdx, bIdx);
          saveState();
          renderBuilders();
          renderDashboard();
        },
        onDelete: async ()=>{
          const ok = await openConfirm({
            title:"Delete Slider Item",
            body:`Delete “${item.name}”? This cannot be undone except via Undo.`,
            okText:"Delete",
            danger:true
          });
          if (!ok) return;
          snapshotForUndo();
          state.catalogs.sliders = state.catalogs.sliders.filter(x=>x.id!==item.id);
          delete state.sliderValues[item.id];
          state.builderSelected.sliders.delete(item.id);
          state.selected.sliders.delete(item.id);
          saveState();
          renderBuilders();
          renderDashboard();
        }
      }));

      tr.appendChild(tdSel);
      tr.appendChild(tdOrder);
      tr.appendChild(tdName);
      tr.appendChild(tdPW);
      tr.appendChild(tdRW);
      tr.appendChild(tdImpact);
      tr.appendChild(tdDash);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    });
  }

  function renderPerformanceBuilder(){
    const tbody = $("performanceBuilderTable");
    tbody.innerHTML = "";
    const items = state.catalogs.perf.slice().sort(byOrder);

    items.forEach((item)=>{
      const selected = state.builderSelected.perf.has(item.id);

      const tr = document.createElement("tr");
      tr.className = "border-t border-[#143457]";

      const tdSel = document.createElement("td");
      tdSel.className = "py-2 pr-2";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected;
      cb.addEventListener("change", ()=>toggleBuilderSelection("perf", item.id));
      tdSel.appendChild(cb);

      const tdOrder = document.createElement("td");
      tdOrder.className = "py-2 px-2";
      const inOrder = document.createElement("input");
      inOrder.type = "number";
      inOrder.className = "table-input";
      inOrder.value = Number(item.order || 0);
      inOrder.addEventListener("change", ()=>{
        snapshotForUndo();
        item.order = Number(inOrder.value || 0);
        saveState();
        renderBuilders();
        renderDashboard();
      });
      tdOrder.appendChild(inOrder);

      const tdName = document.createElement("td");
      tdName.className = "py-2 px-2";
      const inName = document.createElement("input");
      inName.type = "text";
      inName.className = "table-input table-input-wide";
      inName.value = item.name || "";
      inName.addEventListener("change", ()=>{
        snapshotForUndo();
        item.name = inName.value || item.name;
        saveState();
        renderBuilders();
        renderDashboard();
      });
      tdName.appendChild(inName);

      const tdPW = document.createElement("td");
      tdPW.className = "py-2 px-2 text-right";
      const inPW = document.createElement("input");
      inPW.type = "number";
      inPW.className = "table-input";
      inPW.value = Number(item.perfWeight || 0);
      inPW.addEventListener("change", ()=>{
        snapshotForUndo();
        item.perfWeight = Number(inPW.value || 0);
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      });
      tdPW.appendChild(inPW);

      const tdRW = document.createElement("td");
      tdRW.className = "py-2 px-2 text-right";
      const inRW = document.createElement("input");
      inRW.type = "number";
      inRW.className = "table-input";
      inRW.value = Number(item.recoveryWeight || 0);
      inRW.addEventListener("change", ()=>{
        snapshotForUndo();
        item.recoveryWeight = Number(inRW.value || 0);
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      });
      tdRW.appendChild(inRW);

      const tdImpact = document.createElement("td");
      tdImpact.className = "py-2 px-2";
      tdImpact.appendChild(makeImpactSelect(item.impact, (val)=>{
        snapshotForUndo();
        item.impact = val;
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      }));

      const tdDash = document.createElement("td");
      tdDash.className = "py-2 px-2";
      tdDash.appendChild(makeDashboardToggle(!!item.onDashboard, (val)=>{
        snapshotForUndo();
        item.onDashboard = val;
        saveState();
        renderDashboard();
        renderBuilders();
      }));

      const tdAct = document.createElement("td");
      tdAct.className = "py-2 pl-2";
      tdAct.appendChild(makeRowActions({
        onUp: ()=>{
          snapshotForUndo();
          const sorted = state.catalogs.perf.slice().sort(byOrder);
          const pos = sorted.findIndex(x=>x.id===item.id);
          if (pos <= 0) return;
          const prevId = sorted[pos-1].id;
          const aIdx = state.catalogs.perf.findIndex(x=>x.id===item.id);
          const bIdx = state.catalogs.perf.findIndex(x=>x.id===prevId);
          swapOrder(state.catalogs.perf, aIdx, bIdx);
          saveState();
          renderBuilders();
          renderDashboard();
        },
        onDown: ()=>{
          snapshotForUndo();
          const sorted = state.catalogs.perf.slice().sort(byOrder);
          const pos = sorted.findIndex(x=>x.id===item.id);
          if (pos < 0 || pos >= sorted.length-1) return;
          const nextId = sorted[pos+1].id;
          const aIdx = state.catalogs.perf.findIndex(x=>x.id===item.id);
          const bIdx = state.catalogs.perf.findIndex(x=>x.id===nextId);
          swapOrder(state.catalogs.perf, aIdx, bIdx);
          saveState();
          renderBuilders();
          renderDashboard();
        },
        onDelete: async ()=>{
          const ok = await openConfirm({
            title:"Delete Performance Item",
            body:`Delete “${item.name}”? This cannot be undone except via Undo.`,
            okText:"Delete",
            danger:true
          });
          if (!ok) return;
          snapshotForUndo();
          state.catalogs.perf = state.catalogs.perf.filter(x=>x.id!==item.id);
          delete state.toggles[item.id];
          state.builderSelected.perf.delete(item.id);
          state.selected.perf.delete(item.id);
          saveState();
          renderBuilders();
          renderDashboard();
        }
      }));

      tr.appendChild(tdSel);
      tr.appendChild(tdOrder);
      tr.appendChild(tdName);
      tr.appendChild(tdPW);
      tr.appendChild(tdRW);
      tr.appendChild(tdImpact);
      tr.appendChild(tdDash);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    });
  }

  function renderPenaltiesBuilder(){
    const tbody = $("penaltiesBuilderTable");
    tbody.innerHTML = "";
    const items = state.catalogs.pen.slice().sort(byOrder);

    items.forEach((item)=>{
      const selected = state.builderSelected.pen.has(item.id);

      const tr = document.createElement("tr");
      tr.className = "border-t border-[#143457]";

      const tdSel = document.createElement("td");
      tdSel.className = "py-2 pr-2";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected;
      cb.addEventListener("change", ()=>toggleBuilderSelection("pen", item.id));
      tdSel.appendChild(cb);

      const tdOrder = document.createElement("td");
      tdOrder.className = "py-2 px-2";
      const inOrder = document.createElement("input");
      inOrder.type = "number";
      inOrder.className = "table-input";
      inOrder.value = Number(item.order || 0);
      inOrder.addEventListener("change", ()=>{
        snapshotForUndo();
        item.order = Number(inOrder.value || 0);
        saveState();
        renderBuilders();
        renderDashboard();
      });
      tdOrder.appendChild(inOrder);

      const tdName = document.createElement("td");
      tdName.className = "py-2 px-2";
      const inName = document.createElement("input");
      inName.type = "text";
      inName.className = "table-input table-input-wide";
      inName.value = item.name || "";
      inName.addEventListener("change", ()=>{
        snapshotForUndo();
        item.name = inName.value || item.name;
        saveState();
        renderBuilders();
        renderDashboard();
      });
      tdName.appendChild(inName);

      const tdMult = document.createElement("td");
      tdMult.className = "py-2 px-2 text-right";
      const inM = document.createElement("input");
      inM.type = "number";
      inM.step = "0.01";
      inM.min = "0";
      inM.max = "1";
      inM.className = "table-input";
      inM.value = Number(item.multiplier || 1).toFixed(2);
      inM.addEventListener("change", ()=>{
        snapshotForUndo();
        item.multiplier = clamp(Number(inM.value || 1), 0, 1);
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      });
      tdMult.appendChild(inM);

      const tdImpact = document.createElement("td");
      tdImpact.className = "py-2 px-2";
      tdImpact.appendChild(makeImpactSelect(item.impact, (val)=>{
        snapshotForUndo();
        item.impact = val;
        saveState();
        renderBuilders();
        if (!state.personalizationMode) recalcIfAllowed();
      }));

      const tdDash = document.createElement("td");
      tdDash.className = "py-2 px-2";
      tdDash.appendChild(makeDashboardToggle(!!item.onDashboard, (val)=>{
        snapshotForUndo();
        item.onDashboard = val;
        saveState();
        renderDashboard();
        renderBuilders();
      }));

      const tdAct = document.createElement("td");
      tdAct.className = "py-2 pl-2";
      tdAct.appendChild(makeRowActions({
        onUp: ()=>{
          snapshotForUndo();
          const sorted = state.catalogs.pen.slice().sort(byOrder);
          const pos = sorted.findIndex(x=>x.id===item.id);
          if (pos <= 0) return;
          const prevId = sorted[pos-1].id;
          const aIdx = state.catalogs.pen.findIndex(x=>x.id===item.id);
          const bIdx = state.catalogs.pen.findIndex(x=>x.id===prevId);
          swapOrder(state.catalogs.pen, aIdx, bIdx);
          saveState();
          renderBuilders();
          renderDashboard();
        },
        onDown: ()=>{
          snapshotForUndo();
          const sorted = state.catalogs.pen.slice().sort(byOrder);
          const pos = sorted.findIndex(x=>x.id===item.id);
          if (pos < 0 || pos >= sorted.length-1) return;
          const nextId = sorted[pos+1].id;
          const aIdx = state.catalogs.pen.findIndex(x=>x.id===item.id);
          const bIdx = state.catalogs.pen.findIndex(x=>x.id===nextId);
          swapOrder(state.catalogs.pen, aIdx, bIdx);
          saveState();
          renderBuilders();
          renderDashboard();
        },
        onDelete: async ()=>{
          const ok = await openConfirm({
            title:"Delete Penalty Item",
            body:`Delete “${item.name}”? This cannot be undone except via Undo.`,
            okText:"Delete",
            danger:true
          });
          if (!ok) return;
          snapshotForUndo();
          state.catalogs.pen = state.catalogs.pen.filter(x=>x.id!==item.id);
          delete state.penalties[item.id];
          state.builderSelected.pen.delete(item.id);
          state.selected.pen.delete(item.id);
          saveState();
          renderBuilders();
          renderDashboard();
        }
      }));

      tr.appendChild(tdSel);
      tr.appendChild(tdOrder);
      tr.appendChild(tdName);
      tr.appendChild(tdMult);
      tr.appendChild(tdImpact);
      tr.appendChild(tdDash);
      tr.appendChild(tdAct);

      tbody.appendChild(tr);
    });
  }

  // ---------- Analytics ----------
  let currentPeriodDays = 7;
  document.querySelectorAll(".periodBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".periodBtn").forEach(b=>b.classList.toggle("tab-on", b===btn));
      currentPeriodDays = parseInt(btn.dataset.period,10);
      updateAnalytics(currentPeriodDays);
    });
  });

  function parseISODateToLocal(d){
    const [y,m,dd] = d.split("-").map(Number);
    return new Date(y, m-1, dd);
  }

  function withinDays(dateISO, endISO, days){
    const d = parseISODateToLocal(dateISO);
    const end = parseISODateToLocal(endISO);
    const ms = end.getTime() - d.getTime();
    const diffDays = ms / (1000*60*60*24);
    return diffDays >= 0 && diffDays <= days-1;
  }

  function updateAnalytics(days=7){
    const endISO = state.date || isoDate(new Date());
    const all = getHistoryArray();
    const filtered = all.filter(e=>withinDays(e.date, endISO, days));

    const avg = (key)=>{
      if (!filtered.length) return 0;
      const sum = filtered.reduce((a,x)=>a + Number(x[key]||0), 0);
      return sum / filtered.length;
    };

    const driftCount = filtered.filter(e=>String(e.status||"") === "DRIFT").length;
    const driftRate = filtered.length ? (driftCount / filtered.length) : 0;

    $("aPerf").textContent = round1(avg("score")).toFixed(1);
    $("aRec").textContent = round1(avg("recovery")).toFixed(1);
    $("aDrift").textContent = `${Math.round(driftRate*100)}%`;

    const streaks = computeStreaks(all, endISO);
    $("aStreak").textContent = String(streaks.current);
    $("aBest").textContent = String(streaks.best);

    const tops = computeTopCounts(filtered);
    $("topBehaviors").innerHTML = tops.behaviors.length
      ? tops.behaviors.map(x=>`<div class="flex justify-between gap-2"><span>${escapeHtml(x.name)}</span><span class="mono text-white font-semibold">${x.count}</span></div>`).join("")
      : `<div class="text-blue-200/70">No data in this period.</div>`;

    $("topPenalties").innerHTML = tops.penalties.length
      ? tops.penalties.map(x=>`<div class="flex justify-between gap-2"><span>${escapeHtml(x.name)}</span><span class="mono text-white font-semibold">${x.count}</span></div>`).join("")
      : `<div class="text-blue-200/70">No data in this period.</div>`;

    drawChart(filtered, days, endISO);
  }

  function computeStreaks(all, endISO){
    if (!all.length) return { current:0, best:0 };
    const set = new Set(all.map(x=>x.date));
    const sorted = all.slice().sort((a,b)=>a.date.localeCompare(b.date));
    let best = 0;
    let cur = 0;

    for (let i=0;i<sorted.length;i++){
      const d = parseISODateToLocal(sorted[i].date);
      const prev = i>0 ? parseISODateToLocal(sorted[i-1].date) : null;
      if (!prev){
        cur = 1;
      } else {
        const diff = (d.getTime() - prev.getTime()) / (1000*60*60*24);
        if (diff === 1) cur += 1;
        else cur = 1;
      }
      if (cur > best) best = cur;
    }

    let c = 0;
    let cursor = parseISODateToLocal(endISO);
    while (true){
      const key = isoDate(cursor);
      if (!set.has(key)) break;
      c += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return { current:c, best };
  }

  function computeTopCounts(filtered){
    const behaviorCounts = new Map();
    const penaltyCounts = new Map();

    const perfCatalog = new Map(state.catalogs.perf.map(x=>[x.id, x.name]));
    const penCatalog = new Map(state.catalogs.pen.map(x=>[x.id, x.name]));

    filtered.forEach(e=>{
      const t = e.toggles || {};
      Object.keys(t).forEach(id=>{
        if (t[id]) behaviorCounts.set(id, (behaviorCounts.get(id)||0)+1);
      });
      const p = e.penalties || {};
      Object.keys(p).forEach(id=>{
        if (p[id]) penaltyCounts.set(id, (penaltyCounts.get(id)||0)+1);
      });
    });

    const behaviors = [...behaviorCounts.entries()]
      .map(([id,count])=>({ id, name: perfCatalog.get(id) || id, count }))
      .sort((a,b)=>b.count - a.count)
      .slice(0,8);

    const penalties = [...penaltyCounts.entries()]
      .map(([id,count])=>({ id, name: penCatalog.get(id) || id, count }))
      .sort((a,b)=>b.count - a.count)
      .slice(0,8);

    return { behaviors, penalties };
  }

  function drawChart(filtered, days, endISO){
    const canvas = $("chart");
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0,0,W,H);

    ctx.strokeStyle = "rgba(20,52,87,0.7)";
    ctx.lineWidth = 1;
    for (let i=0;i<=4;i++){
      const y = 20 + i * ((H-40)/4);
      ctx.beginPath();
      ctx.moveTo(40, y);
      ctx.lineTo(W-15, y);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(191,219,254,0.75)";
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    [100,75,50,25,0].forEach((val, i)=>{
      const y = 20 + i * ((H-40)/4);
      ctx.fillText(String(val), 10, y+4);
    });

    const pointsForKey = (key)=>{
      const pts = [];
      for (let i=days-1;i>=0;i--){
        const d = parseISODateToLocal(endISO);
        d.setDate(d.getDate() - i);
        const dISO = isoDate(d);
        const e = filtered.find(x=>x.date===dISO);
        const v = e ? Number(e[key]||0) : null;
        pts.push({ date:dISO, value:v });
      }
      return pts;
    };

    const perfPts = pointsForKey("score");
    const recPts = pointsForKey("recovery");

    const x0 = 40, x1 = W-15;
    const y0 = H-20, y1 = 20;

    const xStep = days > 1 ? (x1-x0) / (days-1) : 0;
    const mapY = (v)=> y0 - (clamp(v,0,100)/100) * (y0-y1);

    function drawSeries(pts, stroke){
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      pts.forEach((p, idx)=>{
        if (p.value === null) return;
        const x = x0 + idx * xStep;
        const y = mapY(p.value);
        if (!started){
          ctx.moveTo(x,y);
          started = true;
        } else {
          ctx.lineTo(x,y);
        }
      });
      ctx.stroke();

      ctx.fillStyle = stroke;
      pts.forEach((p, idx)=>{
        if (p.value === null) return;
        const x = x0 + idx * xStep;
        const y = mapY(p.value);
        ctx.beginPath();
        ctx.arc(x,y,3,0,Math.PI*2);
        ctx.fill();
      });
    }

    drawSeries(perfPts, "rgba(56,189,248,0.95)");
    drawSeries(recPts, "rgba(34,197,94,0.95)");

    ctx.fillStyle = "rgba(191,219,254,0.75)";
    ctx.fillText(perfPts[0]?.date || "", x0, H-5);
    const endLabel = perfPts[perfPts.length-1]?.date || "";
    const tw = ctx.measureText(endLabel).width;
    ctx.fillText(endLabel, x1 - tw, H-5);
  }

  // ---------- Coach ----------
  let coachPlan = null;

  function updateCoach(){
    const all = getHistoryArray();
    if (!all.length){
      $("coachText").innerHTML = `<div class="text-blue-200/70">No saved entries yet. Save at least 7 days to get meaningful recommendations.</div>`;
      coachPlan = null;
      return;
    }

    const endISO = state.date || isoDate(new Date());
    const periodDays = 30;
    const filtered = all.filter(e=>withinDays(e.date, endISO, periodDays));
    if (filtered.length < 7){
      $("coachText").innerHTML = `<div class="text-blue-200/70">Not enough data in the last ${periodDays} days. Save at least 7 days to get recommendations.</div>`;
      coachPlan = null;
      return;
    }

    const togglesCount = new Map();
    const penaltiesCount = new Map();

    filtered.forEach(e=>{
      const t = e.toggles || {};
      Object.keys(t).forEach(id=>{
        if (t[id]) togglesCount.set(id, (togglesCount.get(id)||0)+1);
      });
      const p = e.penalties || {};
      Object.keys(p).forEach(id=>{
        if (p[id]) penaltiesCount.set(id, (penaltiesCount.get(id)||0)+1);
      });
    });

    const freqThreshold = Math.ceil(filtered.length * 0.65);
    const rareThreshold = Math.floor(filtered.length * 0.20);

    const raise = [];
    const lower = [];

    state.catalogs.perf.forEach(item=>{
      const c = togglesCount.get(item.id)||0;
      if (c >= freqThreshold){
        raise.push({ kind:"perf", id:item.id, name:item.name, delta: +2, basis:`Completed ${c}/${filtered.length} days` });
      } else if (c <= rareThreshold && item.onDashboard){
        lower.push({ kind:"perf", id:item.id, name:item.name, delta: -2, basis:`Completed ${c}/${filtered.length} days` });
      }
    });

    state.catalogs.sliders.forEach(item=>{
      const vals = filtered.map(e=>Number((e.sliderValues||{})[item.id] ?? null)).filter(v=>Number.isFinite(v));
      if (!vals.length) return;
      const avgVal = vals.reduce((a,v)=>a+v,0)/vals.length;
      const comp = getCompletion(item, avgVal);
      if (comp >= 0.7){
        raise.push({ kind:"sliders", id:item.id, name:item.name, delta:+2, basis:`Average completion ${(comp*100).toFixed(0)}%` });
      } else if (comp <= 0.2 && item.onDashboard){
        lower.push({ kind:"sliders", id:item.id, name:item.name, delta:-2, basis:`Average completion ${(comp*100).toFixed(0)}%` });
      }
    });

    const penaltyTighten = [];
    state.catalogs.pen.forEach(item=>{
      const c = penaltiesCount.get(item.id)||0;
      if (c >= freqThreshold){
        penaltyTighten.push({ id:item.id, name:item.name, delta:-0.02, basis:`Triggered ${c}/${filtered.length} days` });
      }
    });

    const topRaise = raise.sort((a,b)=>b.delta - a.delta).slice(0,5);
    const topLower = lower.sort((a,b)=>a.delta - b.delta).slice(0,3);
    const topPen = penaltyTighten.slice(0,4);

    coachPlan = { raise: topRaise, lower: topLower, penalties: topPen };

    const parts = [];
    parts.push(`<div class="text-blue-200/80"><span class="text-cyan-200 font-semibold">Period:</span> last ${periodDays} days ending ${endISO}. Entries used: <span class="mono text-white font-semibold">${filtered.length}</span>.</div>`);

    if (!topRaise.length && !topLower.length && !topPen.length){
      parts.push(`<div class="text-blue-200/70">No strong signals detected. Keep collecting data.</div>`);
      $("coachText").innerHTML = parts.join("");
      return;
    }

    if (topRaise.length){
      parts.push(`<div class="text-cyan-200 font-semibold">Increase weights (reward consistency)</div>`);
      parts.push(`<ul class="list-disc pl-6 space-y-1">` +
        topRaise.map(x=>`<li>${escapeHtml(x.name)}: <span class="mono text-white font-semibold">+${x.delta}</span> (${escapeHtml(x.basis)})</li>`).join("") +
      `</ul>`);
    }

    if (topLower.length){
      parts.push(`<div class="text-cyan-200 font-semibold mt-2">Decrease weights (reduce noise)</div>`);
      parts.push(`<ul class="list-disc pl-6 space-y-1">` +
        topLower.map(x=>`<li>${escapeHtml(x.name)}: <span class="mono text-white font-semibold">${x.delta}</span> (${escapeHtml(x.basis)})</li>`).join("") +
      `</ul>`);
    }

    if (topPen.length){
      parts.push(`<div class="text-cyan-200 font-semibold mt-2">Tighten penalties (reduce tolerance)</div>`);
      parts.push(`<ul class="list-disc pl-6 space-y-1">` +
        topPen.map(x=>`<li>${escapeHtml(x.name)}: multiplier <span class="mono text-white font-semibold">${x.delta}</span> (${escapeHtml(x.basis)})</li>`).join("") +
      `</ul>`);
    }

    parts.push(`<div class="text-blue-200/70 text-xs mt-2">Apply only if Personalization Mode is On.</div>`);
    $("coachText").innerHTML = parts.join("");
  }

  function applyCoachSuggestions(){
    if (!coachPlan) return;

    snapshotForUndo();

    coachPlan.raise.forEach(x=>{
      if (x.kind === "perf"){
        const item = state.catalogs.perf.find(i=>i.id===x.id);
        if (item) item.perfWeight = Number(item.perfWeight||0) + x.delta;
      } else if (x.kind === "sliders"){
        const item = state.catalogs.sliders.find(i=>i.id===x.id);
        if (item) item.perfWeight = Number(item.perfWeight||0) + x.delta;
      }
    });

    coachPlan.lower.forEach(x=>{
      if (x.kind === "perf"){
        const item = state.catalogs.perf.find(i=>i.id===x.id);
        if (item) item.perfWeight = Math.max(0, Number(item.perfWeight||0) + x.delta);
      } else if (x.kind === "sliders"){
        const item = state.catalogs.sliders.find(i=>i.id===x.id);
        if (item) item.perfWeight = Math.max(0, Number(item.perfWeight||0) + x.delta);
      }
    });

    coachPlan.penalties.forEach(x=>{
      const item = state.catalogs.pen.find(i=>i.id===x.id);
      if (item){
        const next = clamp(Number(item.multiplier||1) + x.delta, 0.50, 1.00);
        item.multiplier = Math.round(next*100)/100;
      }
    });
  }

  $("btnApplyCoach").addEventListener("click", ()=>{
    if (!state.personalizationMode){
      alert("Enable Personalization Mode before applying suggested changes.");
      return;
    }
    if (!coachPlan){
      alert("No coach plan available.");
      return;
    }
    applyCoachSuggestions();
    saveState();
    renderBuilders();
    renderDashboard();
    updateCoach();
  });

  // ---------- Boot ----------
  syncModeUI();
  syncSegments();

  if (!TAB_ORDER.includes(state.tab)) state.tab = "dashboard";
  state.tabIndex = Math.max(0, TAB_ORDER.indexOf(state.tab));
  setTab(state.tab, { bypassGate:true });
