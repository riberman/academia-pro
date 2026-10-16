document.addEventListener('DOMContentLoaded', () => {
    // Notifications: ask for permission once, on first relevant interaction.

    let notificationPermissionRequested = false;
    function ensureNotificationPermission() {
        if (notificationPermissionRequested) return;
        notificationPermissionRequested = true;
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    // Audio: iOS mutes Web Audio when the silent switch is on and can leave the
    // AudioContext "interrupted". An <audio> element playing a generated WAV
    // plays through the media channel (headphones included) regardless of the
    // switch, so it is the primary beep; Web Audio is only a fallback.
    // Both must be unlocked inside a user gesture.
    // audioSession 'ambient' mixes with other apps (Spotify, Amazon Music)
    // instead of pausing them, but it follows the silent switch.
    let audioCtx = null;
    let beepAudio = null;
    let beepUrl = null;

    function buildBeepWavUrl() {
        const rate = 22050;
        const total = Math.floor(rate * 0.7);
        const buf = new ArrayBuffer(44 + total * 2);
        const v = new DataView(buf);
        const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
        v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, total * 2, true);
        for (let i = 0; i < total; i++) {
            const t = i / rate;
            const inBeep = (t % 0.22) < 0.15 && t < 0.59;
            const env = inBeep ? Math.sin(Math.PI * ((t % 0.22) / 0.15)) : 0;
            v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * 880 * t) * env * 0.6 * 32767, true);
        }
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }

    function ensureAudioContext() {
        try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch (e) {}
        if (!beepAudio) {
            beepUrl = buildBeepWavUrl();
            beepAudio = new Audio(beepUrl);
            beepAudio.preload = 'auto';
            // Unlock playback during the gesture with a silent play.
            beepAudio.volume = 0;
            beepAudio.play().then(() => {
                beepAudio.pause();
                beepAudio.currentTime = 0;
                beepAudio.volume = 1;
            }).catch(() => { beepAudio.volume = 1; });
        }
        if (audioCtx) {
            if (audioCtx.state !== 'running') audioCtx.resume();
            return;
        }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
    }

    function playRestBeep() {
        if (beepAudio) {
            beepAudio.currentTime = 0;
            beepAudio.volume = 1;
            const p = beepAudio.play();
            if (p && p.catch) p.catch(() => playRestBeepWebAudio());
            return;
        }
        playRestBeepWebAudio();
    }

    function playRestBeepWebAudio() {
        if (!audioCtx) return;
        if (audioCtx.state !== 'running') audioCtx.resume();
        const now = audioCtx.currentTime;
        [0, 0.22, 0.44].forEach((offset) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0.0001, now + offset);
            gain.gain.exponentialRampToValueAtTime(0.3, now + offset + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(now + offset);
            osc.stop(now + offset + 0.16);
        });
    }

    // Screen Wake Lock: keeps the screen from auto-locking during rest so
    // iOS doesn't suspend JS execution before the rest timer finishes.
    let wakeLockSentinel = null;
    async function requestWakeLock() {
        if (!('wakeLock' in navigator)) return;
        try {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
        } catch (e) {}
    }
    function releaseWakeLock() {
        if (wakeLockSentinel) {
            wakeLockSentinel.release().catch(() => {});
            wakeLockSentinel = null;
        }
    }

    // iOS Safari only supports notifications for apps added to the Home Screen.
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    if (isIOS && !isStandalone) {
        const banner = document.createElement('div');
        banner.id = 'ios-install-banner';
        banner.textContent = 'Para receber avisos de descanso com a tela bloqueada, adicione este app à Tela de Início (compartilhar → Adicionar à Tela de Início).';
        document.body.appendChild(banner);
        setTimeout(() => banner.classList.add('visible'), 100);
        banner.addEventListener('click', () => banner.remove());
    }

    // ---------- Storage helpers ----------
    // localStorage holds users' workout history, so every access is guarded and
    // nothing is ever cleared wholesale.
    const HISTORY_KEY = 'academiaProWorkoutHistory';
    const SESSION_KEY = 'academiaProSession';
    const QUICK_KEY = 'academiaProQuickMode';
    const HATE_ID = '__hate__';
    const HATE_NAME = '🔥 NA FORÇA DO ÓDIO';
    // Minimum number of distinct skipped exercises for "NA FORÇA DO ÓDIO" to be offered as next.
    const MIN_HATE_EXERCISES = 3;

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function safeSet(key, value) {
        try { localStorage.setItem(key, value); return true; } catch (e) {
            console.error('Erro ao gravar ' + key, e);
            return false;
        }
    }
    function safeRemove(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    const normName = (n) => String(n || '').trim().toLowerCase();
    function parseNum(v) {
        const n = parseFloat(String(v ?? '').replace(',', '.'));
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const fmtNum = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

    let toastTimer = null;
    function showToast(msg) {
        let el = document.getElementById('app-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'app-toast';
            el.className = 'app-toast';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
    }

    // State
    let workoutData = null;
    let currentWorkout = null;
    let timerInterval = null;
    let timerTicks = 0;
    let secondsElapsed = 0; // seconds accumulated while paused
    let runStartEpoch = null; // Date.now() when the current running period started
    let isTimerRunning = false;
    let sessionChecked = false;
    let pendingUpdate = false;
    let workoutFinished = false; // set once finishWorkout ran: nothing may re-save the session
    let quickMode = safeGet(QUICK_KEY) === '1';

    function getElapsedSeconds() {
        if (isTimerRunning && runStartEpoch) {
            return secondsElapsed + Math.floor((Date.now() - runStartEpoch) / 1000);
        }
        return secondsElapsed;
    }

    const workoutStarted = () => isTimerRunning || secondsElapsed > 0;

    // DOM Elements
    const viewSelection = document.getElementById('view-selection');
    const viewWorkout = document.getElementById('view-workout');
    const viewHistory = document.getElementById('view-history');
    const viewTrophies = document.getElementById('view-trophies');
    const btnBack = document.getElementById('btn-back');
    const workoutListEl = document.getElementById('workout-list');
    const historyListEl = document.getElementById('history-list');
    const statsEl = document.getElementById('stats-dashboard');
    const methodologyContentEl = document.getElementById('methodology-content');

    // Bottom Navigation
    const btnTabTreino = document.getElementById('btn-tab-treino');
    const btnTabHistorico = document.getElementById('btn-tab-historico');
    const btnTabTrofeus = document.getElementById('btn-tab-trofeus');
    let currentTab = 'treino'; // 'treino' | 'trofeus' | 'historico'
    let treinoSubview = 'selection'; // 'selection' | 'workout'

    function activateView(viewEl) {
        [viewSelection, viewWorkout, viewHistory, viewTrophies].forEach(v => v && v.classList.remove('view-active'));
        viewEl.classList.add('view-active');
    }

    function updateTabUI() {
        btnTabTreino.classList.toggle('active', currentTab === 'treino');
        btnTabHistorico.classList.toggle('active', currentTab === 'historico');
        btnTabTrofeus.classList.toggle('active', currentTab === 'trofeus');
    }

    function showTreinoTab() {
        currentTab = 'treino';
        activateView(treinoSubview === 'workout' ? viewWorkout : viewSelection);
        btnBack.classList.toggle('hidden', treinoSubview !== 'workout');
        updateTabUI();
        updateFab();
    }

    function showTrofeusTab() {
        currentTab = 'trofeus';
        activateView(viewTrophies);
        btnBack.classList.add('hidden');
        renderTrophies();
        updateTabUI();
        updateFab();
    }

    function showHistoricoTab() {
        currentTab = 'historico';
        activateView(viewHistory);
        btnBack.classList.add('hidden');
        renderHistoryView();
        updateTabUI();
        updateFab();
    }

    btnTabTreino.addEventListener('click', showTreinoTab);
    btnTabHistorico.addEventListener('click', showHistoricoTab);
    btnTabTrofeus.addEventListener('click', showTrofeusTab);

    // Workout View Elements
    const wTitle = document.getElementById('workout-title');
    const wFocus = document.getElementById('workout-focus');
    const wTips = document.createElement('div'); // holds the tips markup shown in the modal
    const btnTips = document.getElementById('btn-tips');
    btnTips.addEventListener('click', () => {
        openModal('<i class="ph-fill ph-lightbulb"></i> Dicas do treino', `<div class="workout-tips">${wTips.innerHTML}</div>`);
    });
    const exerciseListEl = document.getElementById('exercise-list');

    // Timer & Progress Elements
    const timerDisplay = document.getElementById('timer');
    const btnTimer = document.getElementById('btn-timer');
    const workoutTimes = document.getElementById('workout-times');
    const timeStartEl = document.getElementById('time-start');
    const timeEndEl = document.getElementById('time-end');
    const btnFinish = document.getElementById('btn-finish');
    const btnFinishFab = document.getElementById('btn-finish-fab');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const filenameSelect = document.getElementById('filename-select');
    const btnLoadServer = document.getElementById('btn-load-server');
    const errorMessage = document.getElementById('error-message');

    // ---------- Confirm modal (replaces native confirm) ----------
    const confirmModal = document.getElementById('confirm-modal');
    const confirmText = document.getElementById('confirm-text');
    const confirmOk = document.getElementById('confirm-ok');
    const confirmCancel = document.getElementById('confirm-cancel');
    let confirmResolve = null;

    // Backdrop taps never answer: a stray tap must not discard a saved session.
    function askConfirm(message, { ok = 'Confirmar', cancel = 'Cancelar' } = {}) {
        return new Promise((resolve) => {
            if (confirmResolve) confirmResolve(false);
            confirmResolve = resolve;
            confirmText.textContent = message;
            confirmOk.textContent = ok;
            confirmCancel.textContent = cancel;
            confirmModal.classList.remove('hidden');
        });
    }
    function answerConfirm(value) {
        confirmModal.classList.add('hidden');
        const r = confirmResolve;
        confirmResolve = null;
        if (r) r(value);
    }
    confirmOk.addEventListener('click', () => answerConfirm(true));
    confirmCancel.addEventListener('click', () => answerConfirm(false));

    // ---------- Service worker / offline updates ----------
    // Auto-reload at most once per minute, so a server that serves different bytes on every
    // request can never trap the app in a reload loop.
    function safeReload() {
        try {
            const last = Number(sessionStorage.getItem('academiaProUpdateReload')) || 0;
            if (Date.now() - last < 60000) return;
            sessionStorage.setItem('academiaProUpdateReload', String(Date.now()));
        } catch (e) {}
        location.reload();
    }

    function applyUpdate() {
        if (workoutStarted()) {
            pendingUpdate = true;
            document.getElementById('update-banner')?.classList.remove('hidden');
        } else {
            safeReload();
        }
    }

    function setupServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        const hadController = !!navigator.serviceWorker.controller;
        let lastCheck = 0;

        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'SHELL_UPDATED') applyUpdate();
        });
        if (hadController) {
            navigator.serviceWorker.addEventListener('controllerchange', applyUpdate);
        }

        navigator.serviceWorker.register('service-worker.js').then((reg) => {
            const check = () => {
                if (navigator.onLine === false || Date.now() - lastCheck < 30000) return;
                lastCheck = Date.now();
                reg.update().catch(() => {});
                const sw = reg.active || navigator.serviceWorker.controller;
                if (sw) sw.postMessage({ type: 'CHECK_UPDATE' });
            };
            check();
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') check();
            });
            window.addEventListener('online', check);
        }).catch(() => {});
    }

    // Initialization
    async function init() {
        const splashScreen = document.getElementById('splash-screen');
        const splashStart = Date.now();
        const MIN_SPLASH_TIME = 900;

        const hideSplash = () => {
            if (!splashScreen) return;
            const elapsed = Date.now() - splashStart;
            const remaining = Math.max(0, MIN_SPLASH_TIME - elapsed);
            setTimeout(() => splashScreen.classList.add('hidden'), remaining);
        };

        // Tenta buscar o índice de arquivos do servidor
        try {
            const response = await fetch('treinos/index.json');
            if (!response.ok) throw new Error("Status " + response.status);

            const treinos = await response.json();
            if(filenameSelect) {
                filenameSelect.innerHTML = '';
                treinos.forEach(t => {
                    const opt = document.createElement('option');
                    opt.value = 'treinos/' + t.file;
                    opt.textContent = t.name + ' (' + t.file + ')';
                    filenameSelect.appendChild(opt);
                });
            }

            // Se houver apenas um treino, esconde a seleção e carrega automático
            const welcomeSection = document.getElementById('welcome-section');
            if(treinos.length === 1) {
                if(welcomeSection) welcomeSection.style.display = 'none';
                loadFromServer('treinos/' + treinos[0].file);
            } else if(treinos.length > 0) {
                loadFromServer('treinos/' + treinos[0].file);
            }
        } catch (error) {
            console.error("Erro ao carregar o índice:", error);
            if(filenameSelect) {
                filenameSelect.innerHTML = '<option value="">Erro ao carregar (Servidor local está rodando?)</option>';
            }
            if(errorMessage) {
                errorMessage.textContent = `Você precisa rodar um servidor local (ex: Live Server) para que o aplicativo consiga listar os treinos da pasta. (erro: ${error.message})`;
                errorMessage.style.display = 'block';
            }
        }

        if(btnLoadServer) {
            btnLoadServer.addEventListener('click', () => {
                const filename = filenameSelect.value;
                if(filename) loadFromServer(filename);
            });
        }

        hideSplash();
    }

    async function loadFromServer(filename) {
        try {
            if(errorMessage) errorMessage.style.display = 'none';
            const response = await fetch(filename);
            if (!response.ok) throw new Error("Status " + response.status);
            workoutData = await response.json();
            renderSelectionView();
            // Only offer to resume a saved session once, on the first load.
            if (!sessionChecked) {
                sessionChecked = true;
                // A celebration left pending (app closed before it showed) appears after the resume prompt.
                Promise.resolve(checkActiveSession()).catch(() => {}).then(showCelebration);
            }
        } catch (error) {
            console.error("Erro ao carregar o JSON:", error);
            if(errorMessage) {
                errorMessage.textContent = `Erro ao carregar '${filename}'. Verifique se o nome está correto e se o servidor local está rodando (erro: ${error.message}).`;
                errorMessage.style.display = 'block';
            }
        }
    }

    // ---------- Workout history ----------
    // Stored newest first under the same key used by every previous version.
    // Old entries ({workoutName,totalSeconds,totalExercises,doneExercises,
    // missedExercises,missedExerciseNames,finishedAt}) stay valid; newer entries
    // add optional fields: ex:[{n,s:[[kg,reps]|null,...]}], quick, v:2.
    function getWorkoutHistory() {
        try {
            const saved = safeGet(HISTORY_KEY);
            const parsed = saved ? JSON.parse(saved) : [];
            return Array.isArray(parsed) ? parsed.filter(e => e && typeof e === 'object') : [];
        } catch (e) {
            console.error("Erro ao carregar histórico", e);
            return [];
        }
    }

    // Retention: everything from the current year, plus the 10 newest entries of
    // the previous year. Older years go. Entries without a valid date are never
    // dropped. Only called right after a new workout is added, never on read.
    function pruneHistory(history, now = new Date()) {
        const year = now.getFullYear();
        let prevKept = 0;
        return history.filter((entry) => {
            const t = Number(entry.finishedAt);
            if (!Number.isFinite(t) || t <= 0) return true;
            const y = new Date(t).getFullYear();
            if (y >= year) return true;
            if (y === year - 1) return ++prevKept <= 10;
            return false;
        });
    }

    function formatHistoryDate(timestamp) {
        const d = new Date(timestamp);
        return `${d.toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'})} às ${d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
    }

    function formatDuration(totalSeconds) {
        const mins = Math.floor((totalSeconds || 0) / 60);
        const secs = (totalSeconds || 0) % 60;
        return `${mins}min ${String(secs).padStart(2, '0')}s`;
    }

    function buildWorkoutSummaryCard(entry) {
        const durationText = formatDuration(entry.totalSeconds);
        const missedNames = Array.isArray(entry.missedExerciseNames) ? entry.missedExerciseNames : [];
        const hasMissed = missedNames.length > 0;

        const card = document.createElement('div');
        card.className = 'last-workout-card';
        card.innerHTML = `
            <div class="last-workout-date">${formatHistoryDate(entry.finishedAt)}${entry.quick ? ' · ⚡ rápido' : ''}</div>
            <div class="last-workout-name">${esc(entry.workoutName)}</div>
            <div class="last-workout-stats">
                <span class="last-workout-stat"><i class="ph ph-check"></i> ${esc(entry.doneExercises)} concluídos</span>
                <span class="last-workout-stat"><i class="ph ph-x"></i> ${esc(entry.missedExercises)} não feitos</span>
                <span class="last-workout-stat"><i class="ph ph-clock"></i> ${durationText}</span>
            </div>
            ${hasMissed ? `
                <button class="last-workout-toggle">
                    <i class="ph ph-caret-down"></i> Ver não executados
                </button>
                <div class="last-workout-missed hidden">
                    ${missedNames.map(esc).join(', ')}
                </div>
            ` : ''}
        `;

        if (hasMissed) {
            const btnToggle = card.querySelector('.last-workout-toggle');
            const missedEl = card.querySelector('.last-workout-missed');
            btnToggle.addEventListener('click', () => {
                const expanded = !missedEl.classList.contains('hidden');
                missedEl.classList.toggle('hidden', expanded);
                btnToggle.innerHTML = expanded
                    ? '<i class="ph ph-caret-down"></i> Ver não executados'
                    : '<i class="ph ph-caret-up"></i> Fechar';
            });
        }

        return card;
    }

    // Compute missed exercise frequency from the most recent entries
    function getMissedExerciseRanking(limitEntries = 10, topN = 10) {
        const history = getWorkoutHistory().slice(0, limitEntries);
        const freq = {};
        history.forEach(entry => {
            (Array.isArray(entry.missedExerciseNames) ? entry.missedExerciseNames : []).forEach(name => {
                const key = String(name).trim();
                if (!key) return;
                freq[key] = (freq[key] || 0) + 1;
            });
        });
        return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, topN)
            .map(([name, count]) => ({ name, count }));
    }

    // Build the special "NA FORÇA DO ÓDIO" card
    function buildHateWorkoutCard(ranking, isTurn) {
        const card = document.createElement('div');
        card.className = 'workout-card workout-card--hate';
        card.id = 'hate-workout-card';
        if (isTurn) card.classList.add('workout-card--turn');

        const exerciseRows = ranking.map((ex, i) =>
            `<div class="hate-exercise-row">
                <span class="hate-ex-rank">${i + 1}</span>
                <span class="hate-ex-name">${esc(ex.name)}</span>
                <span class="hate-ex-count" title="Vezes pulado">
                    <i class="ph ph-x-circle"></i> ${ex.count}x
                </span>
            </div>`
        ).join('');

        card.innerHTML = `
            ${isTurn ? TURN_BADGE_HTML : ''}
            <div class="workout-card-header hate-header">
                <div class="hate-title-wrap">
                    <span class="hate-fire">🔥</span>
                    <h3>NA FORÇA DO ÓDIO</h3>
                </div>
                <span class="workout-duration hate-badge">
                    <i class="ph ph-skull"></i> ${ranking.length} exerc.
                </span>
            </div>
            <p class="hate-subtitle">Seus exercícios mais pulados. É hora de encarar.</p>
            <div class="hate-exercise-list">
                ${exerciseRows}
            </div>
            <div class="hate-cta">
                <i class="ph-fill ph-lightning"></i> Iniciar treino
            </div>
        `;

        card.addEventListener('click', () => {
            loadWorkout({
                id: HATE_ID,
                nome: HATE_NAME,
                foco: 'Seus exercícios mais ignorados — encare-os agora!',
                duracao: '',
                observacoes: [
                    '💀 Esses são os exercícios que você mais pulou. Sem desculpas desta vez.',
                    '🔥 Complete todos para provar que você é maior que as suas limitações.',
                    '⚠️ Ajuste séries/reps conforme o grupo muscular de cada exercício.'
                ],
                exercicios: ranking.map(ex => ({
                    nome: ex.name,
                    series_reps: '3 × 8–12',
                    descanso: '60–90s',
                    rir: '0-2'
                }))
            });
        });

        return card;
    }

    const TURN_BADGE_HTML = '<div class="turn-row"><span class="turn-badge"><i class="ph-fill ph-play"></i> É a sua vez</span></div>';

    // Which workout is "next"? Look at the last N finished workouts (N = number of
    // planned workouts). A planned workout missing from that window is next; when the
    // whole cycle is there, NA FORÇA DO ÓDIO is next (if enough skipped exercises),
    // otherwise the cycle restarts. No history -> the first workout.
    // Returns a workout id, HATE_ID, or null.
    function getRotationInfo(treinos, history, hateEligible) {
        if (!treinos.length) return null;
        const names = treinos.map(t => t.nome);
        const valid = history
            .filter(e => (e.doneExercises || 0) > 0
                && Number.isFinite(Number(e.finishedAt))
                && (names.includes(e.workoutName) || e.workoutName === HATE_NAME))
            .sort((a, b) => b.finishedAt - a.finishedAt);
        if (!valid.length) return treinos[0].id;

        const windowNames = valid.slice(0, treinos.length).map(e => e.workoutName);
        const lastPlanned = windowNames.find(n => n !== HATE_NAME);
        const lastIdx = lastPlanned ? names.indexOf(lastPlanned) : -1;
        const missing = treinos.filter(t => !windowNames.includes(t.nome));

        if (missing.length) {
            for (let k = 1; k <= treinos.length; k++) {
                const t = treinos[(lastIdx + k + treinos.length) % treinos.length];
                if (missing.includes(t)) return t.id;
            }
            return missing[0].id;
        }
        if (hateEligible) return HATE_ID;
        return treinos[(lastIdx + 1) % treinos.length].id;
    }

    // Render Selection Screen
    function renderSelectionView() {
        workoutListEl.innerHTML = '';
        const hateRanking = getMissedExerciseRanking();
        const turnId = getRotationInfo(workoutData.treinos, getWorkoutHistory(), hateRanking.length >= MIN_HATE_EXERCISES);
        workoutData.treinos.forEach(treino => {
            const card = document.createElement('div');
            card.className = 'workout-card' + (treino.id === turnId ? ' workout-card--turn' : '');
            card.innerHTML = `
                ${treino.id === turnId ? TURN_BADGE_HTML : ''}
                <div class="workout-card-header">
                    <h3>${esc(treino.nome)}</h3>
                    <span class="workout-duration"><i class="ph ph-clock"></i> ${esc(treino.duracao)}</span>
                </div>
                <p>${esc(treino.foco)}</p>
            `;
            card.addEventListener('click', () => loadWorkout(treino.id));
            workoutListEl.appendChild(card);
        });

        // "NA FORÇA DO ÓDIO" card (only if there's history with missed exercises)
        if (hateRanking.length > 0) {
            // When it's the hate workout's turn it goes first, so it's visible without scrolling.
            const hateCard = buildHateWorkoutCard(hateRanking, turnId === HATE_ID);
            if (turnId === HATE_ID) workoutListEl.prepend(hateCard);
            else workoutListEl.appendChild(hateCard);
        }

        // Methodology starts collapsed once the user already has finished workouts.
        const methToggle = document.getElementById('methodology-toggle');
        const methCard = methToggle.closest('.methodology-card');
        const setMethOpen = (open) => {
            methCard.classList.toggle('collapsed', !open);
            methToggle.setAttribute('aria-expanded', String(open));
        };
        setMethOpen(getWorkoutHistory().length === 0);
        if (!methToggle._bound) {
            methToggle._bound = true;
            const flip = () => setMethOpen(methCard.classList.contains('collapsed'));
            methToggle.addEventListener('click', flip);
            methToggle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
            });
        }

        const m = workoutData.metodologia;
        if (m) {
            methodologyContentEl.innerHTML = `
                <div class="methodology-item">
                    <h4>Rotação</h4>
                    <p>${esc(m.rotacao)}</p>
                </div>
                <div class="methodology-item">
                    <h4>Progressão</h4>
                    <p>${esc(m.progressao_dupla)}</p>
                </div>
                <div class="methodology-item">
                    <h4>Intensidade</h4>
                    <p><strong>Compostos:</strong> ${esc(m.intensidade?.compostos)}<br>
                    <strong>Isoladores:</strong> ${esc(m.intensidade?.isoladores)}</p>
                </div>
                <div class="methodology-item">
                    <h4>Descanso</h4>
                    <p>${esc(m.descanso)}</p>
                </div>
            `;
        }
    }

    // ---------- Load / performance suggestions ----------
    // Parses "4 × 6–8" -> { sets: 4, min: 6, max: 8 }; null when not in that shape.
    function parseRepRange(seriesReps) {
        const m = String(seriesReps || '').match(/(\d+)\s*[×xX]\s*(\d+)(?:\s*[–\-]\s*(\d+))?/);
        if (!m) return null;
        const min = parseInt(m[2], 10);
        const max = m[3] ? parseInt(m[3], 10) : min;
        return { sets: parseInt(m[1], 10), min, max };
    }

    // Most recent logged performance of an exercise (history is newest first).
    function getLastPerformance(name) {
        return findLastPerf(getWorkoutHistory(), name);
    }

    // Double progression: every set hit the top of the rep range -> raise load.
    function suggestNext(perf, range) {
        if (!perf) return null;
        const kgs = perf.sets.map(s => parseNum(s[0]) || 0);
        const reps = perf.sets.map(s => parseNum(s[1]) || 0);
        const topKg = Math.max(...kgs);
        if (!range) return topKg > 0 ? { type: 'keep', kg: topKg } : null;
        const hitAll = perf.sets.length >= range.sets && reps.every(r => r >= range.max);
        if (topKg > 0 && hitAll) {
            const step = topKg < 20 ? 1 : 2.5;
            return { type: 'up', kg: Math.round((topKg + step) * 2) / 2 };
        }
        const target = Math.min(range.max, Math.min(...reps.filter(r => r > 0), range.max - 1) + 1);
        return { type: 'keep', kg: topKg > 0 ? topKg : null, reps: target };
    }

    function perfSummary(sets) {
        const valid = sets.filter(Boolean);
        if (!valid.length) return '';
        const kgs = valid.map(s => parseNum(s[0]) || 0);
        const reps = valid.map(s => (parseNum(s[1]) ?? '?'));
        if (new Set(kgs).size === 1) {
            return kgs[0] > 0 ? `${fmtNum(kgs[0])} kg × ${reps.join(', ')}` : `${reps.join(', ')} reps`;
        }
        return valid.map((s, i) => `${fmtNum(kgs[i])}×${reps[i]}`).join(' · ');
    }

    function suggestionText(sug) {
        if (!sug) return '';
        if (sug.type === 'up') return `↑ ${fmtNum(sug.kg)} kg`;
        return sug.reps ? `Manter${sug.kg ? ' ' + fmtNum(sug.kg) + ' kg' : ''} · buscar ${sug.reps} reps` : '';
    }

    // Defaults offered for a set's inputs (never overrides what the user typed).
    function defaultsFor(st, setIdx) {
        const perf = getLastPerformance(st.ex.nome);
        const sug = suggestNext(perf, st.range);
        const own = st.log[setIdx];
        const prev = st.log[setIdx - 1];
        const lastSet = perf ? (perf.sets[setIdx] || perf.sets[perf.sets.length - 1]) : null;
        let kg = null, reps = null;
        if (own) { kg = own[0]; reps = own[1]; }
        else {
            if (prev && prev[0] !== null) kg = prev[0];
            else if (sug && sug.type === 'up') kg = sug.kg;
            else if (lastSet) kg = parseNum(lastSet[0]);
            if (lastSet) reps = parseNum(lastSet[1]);
            else if (prev) reps = prev[1];
        }
        return { kg, reps, perf, sug };
    }

    // ---------- Exercise card helpers ----------
    function restBadgeText(st) {
        if (!quickMode) return esc(st.ex.descanso);
        const a = Math.max(1, Math.round(st.minRest / 2));
        const b = Math.max(1, Math.round(st.maxRest / 2));
        return '⚡ ' + (a === b ? formatRestTarget(a) : `${formatRestTarget(a)} – ${formatRestTarget(b)}`);
    }

    function refreshRestBadges() {
        document.querySelectorAll('.exercise-item').forEach(item => {
            const el = item._st && item.querySelector('.badge-rest-text');
            if (el) el.innerHTML = restBadgeText(item._st);
        });
    }

    function refreshLogLine(item) {
        const st = item._st;
        const el = item.querySelector('.exercise-log-line');
        if (!st || !el) return;
        const today = st.log.slice(0, st.sets);
        let html = '';
        if (today.some(Boolean)) {
            html = `<span class="log-today"><i class="ph ph-check-circle"></i> ${esc(perfSummary(today))}</span>`;
        } else {
            const perf = getLastPerformance(st.ex.nome);
            if (perf) {
                html = `<span class="log-last">Última: ${esc(perfSummary(perf.sets))}</span>`;
                const sug = suggestNext(perf, st.range);
                if (sug && sug.type === 'up') html += ` <span class="sug-chip">${esc(suggestionText(sug))}</span>`;
            }
        }
        el.innerHTML = html;
        el.classList.toggle('hidden', !html);
    }

    function setItemSets(item, n) {
        const st = item._st;
        st.sets = Math.max(0, Math.min(st.max, n));
        st.log.length = Math.min(st.log.length, st.sets);
        item.querySelector('.current-set').textContent = st.sets;
        item.classList.toggle('done', st.sets >= st.max);
    }

    function updateItemStatus(item) {
        setItemSets(item, item._st.sets);
        refreshLogLine(item);
        updateProgress();
        saveSession();
    }

    // ---------- Log bottom sheet ----------
    const logSheet = document.getElementById('log-sheet');
    const logSheetTitle = document.getElementById('log-sheet-title');
    const logSheetHint = document.getElementById('log-sheet-hint');
    const logSheetRows = document.getElementById('log-sheet-rows');
    let logSheetItem = null;

    function openLogSheet(item) {
        const st = item._st;
        logSheetItem = item;
        logSheetTitle.textContent = st.ex.nome;
        const perf = getLastPerformance(st.ex.nome);
        const sug = suggestNext(perf, st.range);
        const parts = [];
        if (perf) parts.push(`Última vez: ${perfSummary(perf.sets)}`);
        if (sug) parts.push(`Sugestão: ${suggestionText(sug)}`);
        logSheetHint.textContent = parts.join(' · ');
        logSheetHint.classList.toggle('hidden', !parts.length);
        logSheetRows.innerHTML = '';
        if (st.sets === 0) {
            logSheetRows.innerHTML = '<p class="log-empty">Marque uma série concluída (+) para registrar carga e reps.</p>';
        }
        for (let i = 0; i < st.sets; i++) {
            const d = defaultsFor(st, i);
            const row = document.createElement('div');
            row.className = 'log-row';
            row.innerHTML = `
                <span class="log-row-label">Série ${i + 1}</span>
                <label class="log-field"><span>Carga (kg)</span>
                    <input type="text" inputmode="decimal" autocomplete="off" class="log-kg" placeholder="0" value="${d.kg !== null && d.kg !== undefined ? fmtNum(d.kg) : ''}">
                </label>
                <label class="log-field"><span>Reps</span>
                    <input type="text" inputmode="numeric" autocomplete="off" class="log-reps" placeholder="0" value="${d.reps !== null && d.reps !== undefined ? fmtNum(d.reps) : ''}">
                </label>`;
            logSheetRows.appendChild(row);
        }
        document.getElementById('btn-log-sheet-save').classList.toggle('hidden', st.sets === 0);
        logSheet.classList.remove('hidden');
    }

    function closeLogSheet() {
        logSheet.classList.add('hidden');
        logSheetItem = null;
    }

    document.getElementById('btn-log-sheet-close').addEventListener('click', closeLogSheet);
    logSheet.addEventListener('click', (e) => { if (e.target === logSheet) closeLogSheet(); });
    document.getElementById('btn-log-sheet-save').addEventListener('click', () => {
        const item = logSheetItem;
        if (!item) return;
        const st = item._st;
        logSheetRows.querySelectorAll('.log-row').forEach((row, i) => {
            const kg = parseNum(row.querySelector('.log-kg').value);
            const reps = parseNum(row.querySelector('.log-reps').value);
            st.log[i] = (kg === null && reps === null) ? null : [kg, reps];
        });
        refreshLogLine(item);
        saveSession();
        closeLogSheet();
        showToast('Carga e reps salvos');
    });

    // Load Specific Workout (by id, or a ready-made workout object)
    function loadWorkout(idOrWorkout) {
        const workout = (idOrWorkout && typeof idOrWorkout === 'object')
            ? idOrWorkout
            : workoutData && workoutData.treinos.find(t => t.id === idOrWorkout);
        if (!workout) return false;
        currentWorkout = workout;
        workoutFinished = false;

        wTitle.textContent = currentWorkout.nome;
        wFocus.textContent = currentWorkout.foco;

        // Tips live behind the "Dicas" button instead of taking space on the workout screen.
        const tips = currentWorkout.observacoes || [];
        wTips.innerHTML = tips.map(obs => `<div class="tip-card">${esc(obs)}</div>`).join('');
        btnTips.classList.toggle('hidden', tips.length === 0);

        exerciseListEl.innerHTML = '';
        currentWorkout.exercicios.forEach((ex, index) => {
            // Parse max sets and rest range
            let maxSets = 1;
            const setMatch = String(ex.series_reps).match(/^(\d+)/);
            if (setMatch) maxSets = parseInt(setMatch[1]);

            let minRestSeconds = 45;
            let maxRestSeconds = 90;
            const restStr = String(ex.descanso).toLowerCase();
            const isMin = restStr.includes('min');
            const nums = restStr.match(/\d+/g);
            if (nums && nums.length >= 2) {
                minRestSeconds = isMin ? parseInt(nums[0]) * 60 : parseInt(nums[0]);
                maxRestSeconds = isMin ? parseInt(nums[1]) * 60 : parseInt(nums[1]);
            } else if (nums && nums.length === 1) {
                minRestSeconds = isMin ? parseInt(nums[0]) * 60 : parseInt(nums[0]);
                maxRestSeconds = minRestSeconds;
            }

            const item = document.createElement('div');
            item.className = 'exercise-item';
            item.dataset.index = index;
            item._st = {
                ex, max: maxSets, sets: 0, log: [],
                minRest: minRestSeconds, maxRest: maxRestSeconds,
                range: parseRepRange(ex.series_reps)
            };
            item.innerHTML = `
                <div class="set-counter-container">
                    <button class="btn-counter btn-minus">-</button>
                    <span class="set-counter-text"><span class="current-set">0</span> / ${maxSets}</span>
                    <button class="btn-counter btn-plus">+</button>
                </div>
                <div class="exercise-details">
                    <div class="exercise-name">${esc(ex.nome)}</div>
                    <div class="exercise-meta">
                        <span class="badge badge-reps clickable" data-type="reps"><i class="ph ph-barbell"></i> ${esc(ex.series_reps)}</span>
                        <span class="badge badge-rest clickable" data-type="rest"><i class="ph ph-timer"></i> <span class="badge-rest-text">${restBadgeText(item._st)}</span></span>
                        <span class="badge badge-rir clickable" data-type="rir">RIR ${esc(ex.rir)}</span>
                    </div>
                    <div class="exercise-log-line hidden"></div>
                </div>
                <button class="btn-log-edit" aria-label="Registrar carga e reps" title="Carga e reps"><i class="ph ph-note-pencil"></i></button>
            `;

            const btnMinus = item.querySelector('.btn-minus');
            const btnPlus = item.querySelector('.btn-plus');

            btnMinus.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item._st.sets > 0) {
                    item._st.sets--;
                    updateItemStatus(item);
                }
            });

            btnPlus.addEventListener('click', (e) => {
                e.stopPropagation();
                ensureNotificationPermission();
                ensureAudioContext();
                if(!isTimerRunning && secondsElapsed === 0) toggleTimer();
                setActiveExercise(item);

                const st = item._st;
                if (st.sets < st.max) {
                    st.sets++;
                    updateItemStatus(item);
                    if (st.sets < st.max) {
                        openRestModal(st.minRest, st.maxRest, ex.nome, `${st.sets}/${st.max}`, item);
                    }
                }
            });

            item.querySelector('.btn-log-edit').addEventListener('click', (e) => {
                e.stopPropagation();
                openLogSheet(item);
            });

            // Modal events for badges
            item.querySelectorAll('.badge.clickable').forEach(badge => {
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const type = badge.dataset.type;
                    if(type === 'reps') {
                        openModal('<i class="ph ph-barbell"></i> Séries e Repetições', '<strong>Exemplo (4x6-8):</strong> Você deve fazer 4 séries de 6 a 8 repetições.<br><br>Siga a <strong>Progressão Dupla</strong>: mantenha o peso até conseguir bater o teto (ex: 8 repetições) em todas as séries. Quando conseguir, aumente a carga no próximo treino!');
                    } else if (type === 'rest') {
                        openModal('<i class="ph ph-timer"></i> Descanso', 'Tempo sugerido de recuperação entre as séries. Tente ser rigoroso com o descanso para manter a intensidade alta. Use o cronômetro no topo do app.');
                    } else if (type === 'rir') {
                        openModal('Repetições na Reserva (RIR)', 'Indica o quão perto da falha muscular você deve chegar.<br><br><strong>RIR 1-2:</strong> Pare a série sentindo que conseguiria fazer apenas mais 1 ou 2 repetições perfeitas.<br><strong>RIR 0:</strong> Vá até a falha técnica total.');
                    }
                });
            });

            exerciseListEl.appendChild(item);
            refreshLogLine(item);
        });

        resetTimerUI();
        updateProgress();

        treinoSubview = 'workout';
        viewSelection.classList.remove('view-active');
        setTimeout(() => {
            activateView(viewWorkout);
            btnBack.classList.remove('hidden');
        }, 300);
        return true;
    }

    // Back to selection
    function goToSelection() {
        treinoSubview = 'selection';
        updateFab();
        viewWorkout.classList.remove('view-active');
        setTimeout(() => {
            activateView(viewSelection);
            btnBack.classList.add('hidden');
        }, 10);
    }

    btnBack.addEventListener('click', async () => {
        if(workoutStarted()) {
            // Confirm = finish and save (then leaves); cancel = stay on the workout
            if(await askConfirm('Deseja finalizar o treino atual?', { ok: 'Finalizar' })) finishWorkout();
            return;
        }
        goToSelection();
    });

    // Timer Logic
    btnTimer.addEventListener('click', toggleTimer);

    function setTimerPausedUI() {
        btnTimer.innerHTML = '<i class="ph-fill ph-play-circle"></i> Retomar Treino';
        btnTimer.className = 'btn-primary';
        timerDisplay.classList.remove('active');
    }

    function toggleTimer() {
        if (isTimerRunning) {
            // Pause - freeze the accumulated seconds using the real clock
            secondsElapsed = getElapsedSeconds();
            runStartEpoch = null;
            clearInterval(timerInterval);
            isTimerRunning = false;
            setTimerPausedUI();
            saveSession();
        } else {
            if (secondsElapsed === 0) {
                const now = new Date();
                timeStartEl.textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                workoutTimes.classList.remove('hidden');
                btnFinish.classList.remove('hidden');
            }

            runStartEpoch = Date.now();
            isTimerRunning = true;
            btnTimer.innerHTML = '<i class="ph-fill ph-pause-circle"></i> Pausar Treino';
            btnTimer.className = 'btn-danger';
            timerDisplay.classList.add('active');

            // The interval only triggers redraws; the actual value always comes from
            // the wall clock, so throttled/suspended timers (screen locked) don't drift.
            // The session is persisted on events and every ~15s, not every tick.
            timerTicks = 0;
            clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                updateTimerDisplay();
                if (++timerTicks % 15 === 0) saveSession();
            }, 1000);
            saveSession();
            updateFab();
        }
    }

    function updateTimerDisplay() {
        const total = getElapsedSeconds();
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        timerDisplay.textContent =
            (hrs > 0 ? String(hrs).padStart(2, '0') + ':' : '') +
            String(mins).padStart(2, '0') + ':' +
            String(secs).padStart(2, '0');
    }

    function resetTimerUI() {
        clearInterval(timerInterval);
        secondsElapsed = 0;
        runStartEpoch = null;
        isTimerRunning = false;
        timerDisplay.textContent = '00:00';
        timerDisplay.classList.remove('active');
        btnTimer.innerHTML = '<i class="ph-fill ph-play-circle"></i> Iniciar Treino';
        btnTimer.className = 'btn-primary';
        btnTimer.style.display = '';
        workoutTimes.classList.add('hidden');
        timeStartEl.textContent = '--:--';
        timeEndEl.textContent = '--:--';
        btnFinish.classList.add('hidden');
        btnFinish.disabled = false;
        btnFinish.innerHTML = '<i class="ph-fill ph-check-circle"></i> Finalizar Treino';
        updateFab();
    }

    // Floating finish button: only while a workout is started and visible
    function updateFab() {
        const show = workoutStarted() && currentTab === 'treino' && treinoSubview === 'workout';
        btnFinishFab.classList.toggle('hidden', !show);
    }

    async function confirmFinish() {
        if (await askConfirm('Deseja finalizar o treino?', { ok: 'Finalizar' })) finishWorkout();
    }
    btnFinish.addEventListener('click', confirmFinish);
    btnFinishFab.addEventListener('click', confirmFinish);

    function collectLoggedExercises() {
        const out = [];
        document.querySelectorAll('.exercise-item').forEach(item => {
            const st = item._st;
            if (!st) return;
            const s = st.log.slice(0, st.sets).map(v => (v ? [v[0], v[1]] : null));
            if (s.some(Boolean)) out.push({ n: st.ex.nome, s });
        });
        return out;
    }

    function finishWorkout() {
        workoutFinished = true;
        closeRestModal();
        closeLogSheet();
        if(isTimerRunning) toggleTimer();
        btnFinishFab.classList.add('hidden');

        const now = new Date();
        timeEndEl.textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        btnFinish.innerHTML = '<i class="ph-fill ph-check-circle"></i> Treino Concluído!';
        btnFinish.disabled = true;
        btnTimer.style.display = 'none';
        clearActiveExercise();

        const items = document.querySelectorAll('.exercise-item');
        const doneItems = document.querySelectorAll('.exercise-item.done');
        const missedItems = document.querySelectorAll('.exercise-item:not(.done)');
        const missedNames = Array.from(missedItems).map(item => item.querySelector('.exercise-name').textContent);
        const entry = {
            workoutName: currentWorkout.nome,
            totalSeconds: getElapsedSeconds(),
            totalExercises: items.length,
            doneExercises: doneItems.length,
            missedExercises: items.length - doneItems.length,
            missedExerciseNames: missedNames,
            finishedAt: new Date().getTime(),
            v: 2
        };
        if (quickMode) entry.quick = true;
        const logged = collectLoggedExercises();
        if (logged.length) entry.ex = logged;

        const prevHistory = getWorkoutHistory();
        const history = pruneHistory([entry, ...prevHistory]);
        let saved = safeSet(HISTORY_KEY, JSON.stringify(history));
        if (!saved && entry.ex) {
            // Storage full: keep the workout itself even if the loads don't fit.
            delete entry.ex;
            saved = safeSet(HISTORY_KEY, JSON.stringify(pruneHistory([entry, ...getWorkoutHistory()])));
        }
        if (saved) safeRemove(SESSION_KEY);
        else showToast('Não foi possível salvar o histórico (armazenamento cheio).');

        // Trophy ledger: computed over the FULL history (before pruning drops old entries). Optional.
        if (saved) {
            try { syncTrophyLedger([entry, ...prevHistory], workoutData ? workoutData.treinos : []); }
            catch (e) { console.error('Erro ao atualizar troféus', e); }
        }

        // Celebration only after the workout is safely stored; never blocks the finish.
        if (saved) {
            try {
                const celebration = buildCelebration(prevHistory, entry);
                if (celebration) safeSet(CELEB_PENDING_KEY, JSON.stringify(celebration));
            } catch (e) { console.error('Erro ao calcular conquistas', e); }
        }

        setTimeout(() => {
            if (workoutData) renderSelectionView();
            goToSelection();
            if (pendingUpdate) safeReload();
            showCelebration();
        }, 1500);
    }

    // Highlights the exercise currently being executed (only one at a time)
    function setActiveExercise(item) {
        document.querySelectorAll('.exercise-item.active-exercise').forEach(el => {
            if (el !== item) el.classList.remove('active-exercise');
        });
        item.classList.add('active-exercise');
    }

    function clearActiveExercise() {
        document.querySelectorAll('.exercise-item.active-exercise').forEach(el => {
            el.classList.remove('active-exercise');
        });
    }

    // Progress Logic
    function updateProgress() {
        const items = document.querySelectorAll('.exercise-item');
        const doneItems = document.querySelectorAll('.exercise-item.done');
        const total = items.length;
        const done = doneItems.length;
        progressText.textContent = `${done} / ${total}`;
        const percentage = total === 0 ? 0 : (done / total) * 100;
        progressBar.style.width = `${percentage}%`;
    }

    // ---------- Session recovery ----------
    // Extra fields (sets, logs, virtual) are optional so sessions saved by older
    // versions still restore.
    function saveSession() {
        if (!currentWorkout || workoutFinished) return;
        const items = Array.from(document.querySelectorAll('.exercise-item'));
        const session = {
            workoutId: currentWorkout.id,
            secondsElapsed: getElapsedSeconds(),
            startTime: timeStartEl.textContent,
            doneIndexes: items.filter(i => i.classList.contains('done')).map(i => parseInt(i.dataset.index)),
            sets: items.map(i => (i._st ? i._st.sets : 0)),
            logs: items.map(i => (i._st ? i._st.log.slice(0, i._st.sets) : [])),
            timestamp: new Date().getTime()
        };
        if (currentWorkout.id === HATE_ID) session.virtual = currentWorkout;
        safeSet(SESSION_KEY, JSON.stringify(session));
    }

    async function checkActiveSession() {
        const saved = safeGet(SESSION_KEY);
        if (!saved) return;
        let session;
        try { session = JSON.parse(saved); } catch (e) { console.error("Erro ao restaurar sessão", e); return; }
        // Only recover if less than 6 hours old
        if (!session || new Date().getTime() - session.timestamp >= 6 * 60 * 60 * 1000) {
            safeRemove(SESSION_KEY);
            return;
        }
        const resume = await askConfirm('Encontramos um treino em andamento. Deseja continuar de onde parou?', { ok: 'Continuar', cancel: 'Descartar' });
        if (!resume) { safeRemove(SESSION_KEY); return; }

        if (!loadWorkout(session.virtual || session.workoutId)) {
            safeRemove(SESSION_KEY);
            return;
        }

        secondsElapsed = session.secondsElapsed || 0;
        updateTimerDisplay();
        timeStartEl.textContent = session.startTime || '--:--';
        workoutTimes.classList.remove('hidden');
        btnFinish.classList.remove('hidden');
        setTimerPausedUI();

        const items = document.querySelectorAll('.exercise-item');
        const done = Array.isArray(session.doneIndexes) ? session.doneIndexes : [];
        items.forEach((item, idx) => {
            const st = item._st;
            const n = Array.isArray(session.sets) && Number.isFinite(session.sets[idx])
                ? session.sets[idx]
                : (done.includes(idx) ? st.max : 0);
            setItemSets(item, n);
            const log = Array.isArray(session.logs) ? session.logs[idx] : null;
            if (Array.isArray(log)) st.log = log.slice(0, st.sets).map(v => (Array.isArray(v) ? v : null));
            refreshLogLine(item);
        });
        updateProgress();
        updateFab();
    }

    // Help Modal Logic
    const infoModal = document.getElementById('info-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalText = document.getElementById('modal-text');
    const btnCloseModal = document.getElementById('btn-close-modal');

    function openModal(title, text) {
        modalTitle.innerHTML = title;
        modalText.innerHTML = text;
        infoModal.classList.remove('hidden');
    }

    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', () => {
            infoModal.classList.add('hidden');
        });
    }

    if (infoModal) {
        infoModal.addEventListener('click', (e) => {
            if(e.target === infoModal) infoModal.classList.add('hidden');
        });
    }

    // Rest Modal Logic
    const restModal = document.getElementById('rest-modal');
    const restTimerText = document.getElementById('rest-timer-text');
    const restStatusText = document.getElementById('rest-status-text');
    const restTargetText = document.getElementById('rest-target-text');
    const restEtaText = document.getElementById('rest-eta-text');
    const swipeUnlock = document.getElementById('swipe-unlock');
    let restInterval = null;
    let restStartEpoch = null;
    let restMinTarget = 0;
    let restMaxTarget = 0;
    let restExerciseName = '';
    let restSetLabel = '';
    let restNotified = false;
    let restLogItem = null;
    let restLogSetIdx = 0;

    function notifyRestDone() {
        if (restNotified) return;
        restNotified = true;
        navigator.vibrate?.([200, 100, 200]);
        playRestBeep();
        const body = restExerciseName ? `${restExerciseName} — Série ${restSetLabel}` : 'Hora da próxima série!';
        navigator.serviceWorker?.ready.then((reg) => {
            reg.active?.postMessage({
                type: 'REST_DONE',
                title: 'Descanso finalizado',
                body
            });
        }).catch(() => {});
    }

    function getRestSeconds() {
        return restStartEpoch ? Math.floor((Date.now() - restStartEpoch) / 1000) : 0;
    }

    function formatRestTarget(seconds) {
        if (seconds >= 60) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return s > 0 ? `${m}min ${s}s` : `${m}min`;
        }
        return `${seconds}s`;
    }

    // Quick mode: halves every rest target (e.g. 1min -> 30s).
    const quickModeToggle = document.getElementById('quick-mode-toggle');
    const isQuickMode = () => quickMode;
    if (quickModeToggle) {
        quickModeToggle.checked = quickMode;
        quickModeToggle.addEventListener('change', () => {
            quickMode = quickModeToggle.checked;
            safeSet(QUICK_KEY, quickMode ? '1' : '0');
            refreshRestBadges();
        });
    }
    const btnQuickHelp = document.getElementById('btn-quick-help');
    if (btnQuickHelp) {
        btnQuickHelp.addEventListener('click', () => {
            openModal(
                '<i class="ph-fill ph-lightning"></i> Modo rápido',
                'Reduz <strong>pela metade</strong> todos os tempos de descanso (mínimo e máximo). Por exemplo, um descanso de 1min vira 30s.<br><br>Use quando precisar terminar o treino com mais rapidez, pausando menos entre as séries. A recuperação será menor, então a carga ou as repetições podem cair um pouco.<br><br>Vale para os próximos descansos e pode ser ligado ou desligado a qualquer momento.'
            );
        });
    }

    // Rest screen: optional accordion to log load/reps of the set just done.
    const restLogToggle = document.getElementById('btn-rest-log-toggle');
    const restLogToggleText = document.getElementById('rest-log-toggle-text');
    const restLogPanel = document.getElementById('rest-log-panel');
    const restLogHint = document.getElementById('rest-log-hint');
    const restLogKg = document.getElementById('rest-log-kg');
    const restLogReps = document.getElementById('rest-log-reps');

    function setRestLogOpen(open) {
        restLogPanel.classList.toggle('hidden', !open);
        restLogToggle.setAttribute('aria-expanded', String(open));
        restLogToggle.classList.toggle('open', open);
    }

    function prepareRestLog(item) {
        restLogItem = item || null;
        const wrap = restLogToggle.closest('.rest-log');
        wrap.classList.toggle('hidden', !item);
        setRestLogOpen(false);
        restLogToggleText.textContent = 'Registrar série';
        if (!item) return;
        restLogSetIdx = item._st.sets - 1;
        const d = defaultsFor(item._st, restLogSetIdx);
        restLogKg.value = d.kg !== null && d.kg !== undefined ? fmtNum(d.kg) : '';
        restLogReps.value = d.reps !== null && d.reps !== undefined ? fmtNum(d.reps) : '';
        const parts = [];
        if (d.perf) parts.push(`Última: ${perfSummary(d.perf.sets)}`);
        if (d.sug) parts.push(`Sugestão: ${suggestionText(d.sug)}`);
        restLogHint.textContent = parts.join(' · ');
        restLogHint.classList.toggle('hidden', !parts.length);
        if (item._st.log[restLogSetIdx]) restLogToggleText.textContent = 'Série registrada ✓';
    }

    restLogToggle.addEventListener('click', () => setRestLogOpen(restLogPanel.classList.contains('hidden')));
    document.getElementById('btn-rest-log-save').addEventListener('click', () => {
        const item = restLogItem;
        if (!item) return;
        const kg = parseNum(restLogKg.value);
        const reps = parseNum(restLogReps.value);
        if (kg !== null || reps !== null) {
            item._st.log[restLogSetIdx] = [kg, reps];
            refreshLogLine(item);
            saveSession();
            restLogToggleText.textContent = 'Série registrada ✓';
        }
        setRestLogOpen(false);
    });

    function openRestModal(minSeconds, maxSeconds, exerciseName, setLabel, item) {
        if(!restModal) return;
        const quick = isQuickMode();
        if (quick) {
            minSeconds = Math.max(1, Math.round(minSeconds / 2));
            maxSeconds = Math.max(1, Math.round(maxSeconds / 2));
        }
        restModal.classList.remove('hidden');
        if(swipeUnlock) swipeUnlock.value = 0;
        const rangeText = minSeconds === maxSeconds
            ? formatRestTarget(minSeconds)
            : `${formatRestTarget(minSeconds)} – ${formatRestTarget(maxSeconds)}`;
        if(restTargetText) restTargetText.textContent = `${quick ? '⚡ ' : ''}Alvo: ${rangeText}`;
        restMinTarget = minSeconds;
        restMaxTarget = maxSeconds;
        restExerciseName = exerciseName || '';
        restSetLabel = setLabel || '';
        restNotified = false;
        restStartEpoch = Date.now();
        prepareRestLog(item);
        if (restEtaText) {
            const eta = new Date(restStartEpoch + maxSeconds * 1000);
            restEtaText.textContent = `Termina às ${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }
        updateRestDisplay(minSeconds, maxSeconds);
        requestWakeLock();

        // Redraw off the wall clock so a locked/backgrounded screen doesn't cause drift.
        clearInterval(restInterval);
        restInterval = setInterval(() => {
            updateRestDisplay(minSeconds, maxSeconds);
        }, 1000);
    }

    function closeRestModal() {
        if(!restModal) return;
        restModal.classList.add('hidden');
        clearInterval(restInterval);
        restStartEpoch = null;
        restNotified = false;
        restLogItem = null;
        if (document.activeElement && restModal.contains(document.activeElement)) document.activeElement.blur();
        releaseWakeLock();
    }

    function updateRestDisplay(minTarget, maxTarget) {
        if(!restTimerText) return;
        const restSeconds = getRestSeconds();
        const mins = Math.floor(restSeconds / 60);
        const secs = restSeconds % 60;
        restTimerText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        // Yellow: below min target
        // Green: between min and max + grace of 15s
        // Red: beyond max + 15s
        if (restSeconds < minTarget) {
            restTimerText.className = 'rest-time-status-normal';
            restStatusText.textContent = 'Recuperação em andamento...';
        } else if (restSeconds >= minTarget && restSeconds <= maxTarget + 15) {
            restTimerText.className = 'rest-time-status-target';
            restStatusText.textContent = 'Tempo ideal alcançado!';
            notifyRestDone();
        } else {
            restTimerText.className = 'rest-time-status-over';
            restStatusText.textContent = 'Passou do tempo! Próxima série!';
            notifyRestDone();
        }
    }

    // Swipe to dismiss
    if (swipeUnlock) {
        swipeUnlock.addEventListener('input', (e) => {
            if (e.target.value >= 95) {
                closeRestModal();
                setTimeout(() => { e.target.value = 0; }, 300);
            }
        });
        swipeUnlock.addEventListener('change', (e) => {
            if (e.target.value < 95) {
                e.target.value = 0; // snap back
            }
        });
    }

    // Both timers are computed off Date.now(), so they stay accurate even if the
    // interval is throttled while the screen is locked. This just forces an
    // immediate redraw the moment the app becomes visible again, instead of
    // waiting up to 1s for the next tick.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (isTimerRunning) updateTimerDisplay();
        if (restStartEpoch) {
            updateRestDisplay(restMinTarget, restMaxTarget);
            requestWakeLock();
        }
    });

    // ---------- Celebrations: achievements, fireworks, share image ----------
    // Everything here runs AFTER the workout is saved and is wrapped in try/catch:
    // a failure can only cost the celebration, never the workout or the history.
    const CELEB_PENDING_KEY = 'academiaProPendingCelebration';
    const CELEB_MAX_AGE = 24 * 60 * 60 * 1000;

    function shiftDays(ts, n) {
        const d = new Date(ts);
        d.setDate(d.getDate() + n);
        return d.getTime();
    }

    function mondaysOfMonth(year, month) {
        const res = [];
        const d = new Date(year, month, 1);
        d.setHours(0, 0, 0, 0);
        while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
        while (d.getMonth() === month) { res.push(d.getTime()); d.setDate(d.getDate() + 7); }
        return res;
    }

    // Best set of an exercise session: highest load and the best reps at that load.
    function bestOfSets(sets) {
        const valid = (sets || []).filter(s => Array.isArray(s) && (parseNum(s[0]) !== null || parseNum(s[1]) !== null));
        if (!valid.length) return null;
        const kg = Math.max(...valid.map(s => parseNum(s[0]) || 0));
        const reps = Math.max(...valid.filter(s => (parseNum(s[0]) || 0) === kg).map(s => parseNum(s[1]) || 0));
        return { kg, reps };
    }

    function findLastPerf(history, name) {
        const key = normName(name);
        for (const entry of history) {
            if (!Array.isArray(entry.ex)) continue;
            const found = entry.ex.find(x => x && normName(x.n) === key);
            if (!found || !Array.isArray(found.s)) continue;
            const sets = found.s.filter(s => Array.isArray(s) && (parseNum(s[0]) !== null || parseNum(s[1]) !== null));
            if (sets.length) return { sets, finishedAt: entry.finishedAt };
        }
        return null;
    }

    const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

    // Pure: which goals did `entry` just cross? `prevHistoryRaw` = history before it.
    function computeAchievements(prevHistoryRaw, entry, treinos) {
        const valid = e => e && typeof e === 'object' && (e.doneExercises || 0) > 0 && Number.isFinite(Number(e.finishedAt));
        if (!valid(entry)) return [];
        const prev = (prevHistoryRaw || []).filter(valid);
        const all = [entry, ...prev];
        const t = Number(entry.finishedAt);
        const d = new Date(t);
        const variant = Math.floor(t / DAY_MS) % 2;
        const pick = (a, b) => (variant ? b : a);
        const names = (treinos || []).map(x => x.nome);
        const out = [];
        const add = (id, rank, level, icon, title, line, extra) => out.push(Object.assign({ id, rank, level, icon, title, line }, extra || {}));
        const sameMonth = (e) => { const x = new Date(Number(e.finishedAt)); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth(); };

        // Month milestones + closing the whole month
        const monthCount = all.filter(sameMonth).length;
        const monthName = MONTHS_PT[d.getMonth()];
        const monthDays = new Set(all.filter(sameMonth).map(e => new Date(Number(e.finishedAt)).getDate()));
        const prevMonthDays = new Set(prev.filter(sameMonth).map(e => new Date(Number(e.finishedAt)).getDate()));
        const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        if (monthDays.size === daysInMonth && !prevMonthDays.has(d.getDate())) {
            add('mes-fechado', 1, 'grande', 'crown-simple', 'Mês fechado', `Treinou em todos os dias de ${monthName}. Hoje vale comemorar.`);
        }
        const monthMsgs = {
            5: ['média', '5 treinos no mês', pick('O ritmo está se formando.', 'Cinco treinos e o hábito começa a pegar.'), 7],
            10: ['média', '10 treinos no mês', pick('Já virou hábito.', 'Dez treinos. O corpo já percebeu.'), 7],
            20: ['grande', '20 treinos no mês', pick('Pouca gente chega até aqui.', 'Vinte treinos num mês. Isso é disciplina.'), 3],
            30: ['grande', '30 treinos no mês', pick('Um mês de dedicação rara.', 'Trinta treinos. Poucos chegam nesse nível.'), 3]
        };
        if (monthMsgs[monthCount]) {
            const [lvl, title, line, rank] = monthMsgs[monthCount];
            add('mes-' + monthCount, rank, lvl === 'média' ? 'media' : 'grande', 'calendar-check', title, line);
        }

        // Weekly rotation complete (needs a real rotation: 2+ planned workouts)
        const W = weekStart(t);
        const doneNames = (hist, ws) => new Set(hist.filter(e => weekStart(Number(e.finishedAt)) === ws && names.includes(e.workoutName)).map(e => e.workoutName));
        const weekComplete = (hist, ws) => names.length >= 2 && doneNames(hist, ws).size >= names.length;
        if (weekComplete(all, W) && !weekComplete(prev, W)) {
            const label = names.length <= 4 ? 'A rotação ' + names.map(n => n.replace(/^Treino\s+/i, '')).join(', ').replace(/, ([^,]*)$/, ' e $1') + ' desta semana está completa.' : 'A rotação completa desta semana está feita.';
            add('semana-completa', 5, 'media', 'calendar-check', 'Semana em dia', label);
        }

        // Every week of the month with the full rotation
        const Wd = new Date(W);
        const mondays = mondaysOfMonth(Wd.getFullYear(), Wd.getMonth());
        const monthWeeksOk = (hist) => mondays.length >= 4 && mondays.every(m => weekComplete(hist, m));
        if (names.length >= 2 && monthWeeksOk(all) && !monthWeeksOk(prev)) {
            add('mes-consistente', 2, 'grande', 'medal', 'Mês consistente', 'Todas as semanas de ' + MONTHS_PT[Wd.getMonth()] + ' com a rotação completa. Isso é consistência de verdade.');
        }

        // Weekly streak
        const weeksAll = new Set(all.map(e => weekStart(Number(e.finishedAt))));
        const weeksPrev = new Set(prev.map(e => weekStart(Number(e.finishedAt))));
        if (!weeksPrev.has(W)) {
            let streak = 0, cur = W;
            while (weeksAll.has(cur)) { streak++; cur = weekStart(shiftDays(cur, -7)); }
            const sq = {
                4: ['media', 6, '4 semanas seguidas', 'Um mês sem falhar uma semana.'],
                8: ['media', 6, '8 semanas seguidas', 'Dois meses de constância.'],
                12: ['grande', 4, '12 semanas seguidas', 'Três meses sem faltar uma semana. Isso muda o corpo.']
            };
            if (sq[streak]) add('sequencia-' + streak, sq[streak][1], sq[streak][0], 'fire', sq[streak][2], sq[streak][3]);
        }

        // Progression vs the previous time each exercise was logged
        const gains = [];
        (Array.isArray(entry.ex) ? entry.ex : []).forEach(x => {
            if (!x || !Array.isArray(x.s)) return;
            const now = bestOfSets(x.s);
            const before = findLastPerf(prev, x.n);
            const old = before && bestOfSets(before.sets);
            if (!now || !old) return;
            if (now.kg > old.kg + 0.001) gains.push(`${x.n}: ${fmtNum(old.kg)} → ${fmtNum(now.kg)} kg`);
            else if (Math.abs(now.kg - old.kg) < 0.001 && now.reps > old.reps) {
                gains.push(now.kg > 0 ? `${x.n}: ${fmtNum(now.kg)} kg · ${fmtNum(old.reps)} → ${fmtNum(now.reps)} reps` : `${x.n}: ${fmtNum(old.reps)} → ${fmtNum(now.reps)} reps`);
            }
        });
        if (gains.length) {
            const more = gains.length > 2 ? ` (+${gains.length - 2})` : '';
            add('progressao', 8, 'media', 'trend-up', 'Evolução registrada', gains.slice(0, 2).join(' · ') + more);
        }

        if (prev.length === 0) add('primeiro-treino', 9, 'media', 'sparkle', 'Primeiro treino registrado', 'Todo histórico começa com um. Bem-vindo.');

        const yearCount = all.filter(e => new Date(Number(e.finishedAt)).getFullYear() === d.getFullYear()).length;
        const yearEntries = all.filter(e => new Date(Number(e.finishedAt)).getFullYear() === d.getFullYear());
        const dayKey = (e) => { const x = new Date(Number(e.finishedAt)); return x.getMonth() + '-' + x.getDate(); };
        const daysInYear = Math.round((new Date(d.getFullYear() + 1, 0, 1) - new Date(d.getFullYear(), 0, 1)) / DAY_MS);
        const yearDays = new Set(yearEntries.map(dayKey));
        const prevYearDays = new Set(prev.filter(e => new Date(Number(e.finishedAt)).getFullYear() === d.getFullYear()).map(dayKey));
        if (yearDays.size === daysInYear && !prevYearDays.has(d.getMonth() + '-' + d.getDate())) {
            add('ano-fechado', 1, 'grande', 'crown-simple', 'Ano fechado', `Treinou em todos os dias de ${d.getFullYear()}. Um ano inteiro sem faltar.`);
        }
        if (yearCount === 200) add('ano-200', 10, 'grande', 'star', `200 treinos em ${d.getFullYear()}`, 'Duzentos treinos. Isso já é estilo de vida.');
        if (yearCount === 300) add('ano-300', 10, 'grande', 'star', `300 treinos em ${d.getFullYear()}`, 'Trezentos treinos. Poucos chegam perto disso.');
        if (yearCount === 50) add('ano-50', 10, 'media', 'star', `50 treinos em ${d.getFullYear()}`, 'Meio caminho andado.');
        if (yearCount === 100) add('ano-100', 10, 'grande', 'star', `100 treinos em ${d.getFullYear()}`, 'Três dígitos. Respeito.');

        const total = entry.totalExercises || ((entry.doneExercises || 0) + (entry.missedExercises || 0));
        if (total > 0 && entry.doneExercises === total) {
            add('treino-completo', 11, 'leve', 'check-circle', 'Treino completo', pick('Todos os exercícios feitos. Constância é isso.', 'Nada ficou pela metade hoje.'));
        }
        return out.sort((a, b) => a.rank - b.rank);
    }

    // Collapses achievements into one celebration: headline + up to 2 pills.
    function buildCelebration(prevHistory, entry) {
        const list = computeAchievements(prevHistory, entry, workoutData ? workoutData.treinos : []);
        if (!list.length) return null;
        const [head, ...rest] = list;
        const level = list.some(a => a.level === 'grande') ? 'grande' : (list.some(a => a.level === 'media') ? 'media' : 'leve');
        const pills = rest.slice(0, 2).map(a => ({ icon: a.icon, text: a.id === 'progressao' ? a.line : a.title }));
        return {
            v: 1,
            createdAt: Date.now(),
            finishedAt: entry.finishedAt,
            level,
            icon: head.icon,
            title: head.title,
            text: head.line,
            pills,
            more: Math.max(0, rest.length - 2),
            ids: list.map(a => a.id)
        };
    }

    // ----- Fireworks (live canvas) -----
    const FW_COLORS = ['#10b981', '#34d399', '#fcd34d', '#f59e0b', '#60a5fa', '#a78bfa', '#f8fafc'];
    let fwStop = null;

    function startFireworks(canvas, level) {
        const ctx = canvas && canvas.getContext && canvas.getContext('2d');
        if (!ctx) return null;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const W = canvas.clientWidth || window.innerWidth;
        const H = canvas.clientHeight || window.innerHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const cfg = { leve: [2, 1500], media: [5, 3000], grande: [9, 5000] }[level] || [4, 2500];
        const bursts = cfg[0], duration = cfg[1];
        const maxP = Math.min(260, Math.round((W * H) / 1800));
        const perBurst = Math.max(30, Math.min(80, Math.round(maxP / 3)));
        const plan = [];
        for (let i = 0; i < bursts; i++) plan.push(i * (duration / bursts) + (i ? Math.random() * 180 : 0));
        let nextIdx = 0;
        const rockets = [];
        const parts = [];
        let start = 0, last = 0, raf = 0, stopped = false;

        function launch() {
            const x = W * (0.15 + Math.random() * 0.7);
            rockets.push({ x, y: H + 10, ty: H * (0.1 + Math.random() * 0.4), vy: -(H * 1.3), color: FW_COLORS[Math.floor(Math.random() * FW_COLORS.length)] });
        }
        function explode(r) {
            const n = Math.min(perBurst, Math.max(0, maxP - parts.length));
            const second = FW_COLORS[Math.floor(Math.random() * FW_COLORS.length)];
            for (let i = 0; i < n; i++) {
                const a = (Math.PI * 2 * i) / n + Math.random() * 0.2;
                const sp = (90 + Math.random() * 190) * (W / 400 > 1.4 ? 1.4 : Math.max(0.85, W / 400));
                parts.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, ttl: 1.1 + Math.random() * 0.9, color: i % 3 === 0 ? second : r.color, size: 2 + Math.random() * 2 });
            }
        }
        function frame(ts) {
            if (stopped) return;
            if (!start) { start = ts; last = ts; }
            const dt = Math.min(0.033, (ts - last) / 1000);
            last = ts;
            const elapsed = ts - start;
            while (nextIdx < plan.length && elapsed >= plan[nextIdx]) { launch(); nextIdx++; }

            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(0,0,0,0.22)';
            ctx.fillRect(0, 0, W, H);
            ctx.globalCompositeOperation = 'lighter';

            for (let i = rockets.length - 1; i >= 0; i--) {
                const r = rockets[i];
                r.y += r.vy * dt;
                ctx.fillStyle = r.color;
                ctx.beginPath(); ctx.arc(r.x, r.y, 2, 0, Math.PI * 2); ctx.fill();
                if (r.y <= r.ty) { explode(r); rockets.splice(i, 1); }
            }
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i];
                p.life += dt;
                if (p.life >= p.ttl) { parts.splice(i, 1); continue; }
                p.vx *= 0.985; p.vy = p.vy * 0.985 + 90 * dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                ctx.globalAlpha = Math.max(0, 1 - p.life / p.ttl);
                ctx.fillStyle = p.color;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
            }
            ctx.globalAlpha = 1;

            if (nextIdx >= plan.length && !rockets.length && !parts.length) { stop(); return; }
            raf = requestAnimationFrame(frame);
        }
        function stop() {
            stopped = true;
            cancelAnimationFrame(raf);
            try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
        }
        raf = requestAnimationFrame(frame);
        return stop;
    }

    // ----- Share image -----
    const SHARE_FORMATS = {
        story: { w: 1080, h: 1920, label: 'Stories', fw: [0.05, 0.50], textTop: 0.56, footer: 0.93 },
        feed: { w: 1080, h: 1350, label: 'Feed', fw: [0.04, 0.46], textTop: 0.52, footer: 0.93 },
        square: { w: 1080, h: 1080, label: 'Quadrado', fw: [0.03, 0.42], textTop: 0.49, footer: 0.92 }
    };
    const LEVEL_COLORS = { leve: '#10b981', media: '#fcd34d', grande: '#f59e0b' };

    function mulberry32(a) {
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function loadImage(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
    }

    function wrapLines(ctx, text, maxWidth) {
        const words = String(text).split(/\s+/);
        const lines = [];
        let line = '';
        words.forEach(w => {
            const test = line ? line + ' ' + w : w;
            if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
        });
        if (line) lines.push(line);
        return lines;
    }

    // Shrinks the font until the wrapped text fits within maxLines.
    function fitText(ctx, text, weight, startSize, minSize, maxWidth, maxLines) {
        let size = startSize, lines = [];
        for (; size >= minSize; size -= 2) {
            ctx.font = `${weight} ${size}px Outfit, system-ui, -apple-system, sans-serif`;
            lines = wrapLines(ctx, text, maxWidth);
            if (lines.length <= maxLines) break;
        }
        return { size, lines: lines.slice(0, maxLines) };
    }

    function drawStaticBurst(ctx, cx, cy, radius, color, rand) {
        const n = 46;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (let i = 0; i < n; i++) {
            const a = (Math.PI * 2 * i) / n + rand() * 0.08;
            const r1 = radius * (0.35 + rand() * 0.1);
            const r2 = radius * (0.75 + rand() * 0.25);
            const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
            const x2 = cx + Math.cos(a) * r2, y2 = cy + Math.sin(a) * r2 + radius * 0.08;
            const g = ctx.createLinearGradient(x1, y1, x2, y2);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(1, color);
            ctx.strokeStyle = g;
            ctx.lineWidth = 3 + rand() * 2;
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.9;
            ctx.beginPath(); ctx.arc(x2, y2, 3.5 + rand() * 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        }
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.6);
        glow.addColorStop(0, color + '55');
        glow.addColorStop(1, color + '00');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    }

    function starPath(ctx, cx, cy, outer, inner) {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? outer : inner;
            const a = -Math.PI / 2 + (Math.PI * i) / 5;
            const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    async function renderShareImage(result, formatKey) {
        const f = SHARE_FORMATS[formatKey];
        const canvas = document.createElement('canvas');
        canvas.width = f.w; canvas.height = f.h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas indisponível');
        const W = f.w, H = f.h;
        const accent = LEVEL_COLORS[result.level] || '#10b981';
        const rand = mulberry32((Number(result.createdAt) || 1) % 2147483647);

        // fonts (best effort, never blocks for long)
        try {
            await Promise.race([
                Promise.all([document.fonts.load('700 48px Outfit'), document.fonts.load('400 32px Outfit')]),
                new Promise(r => setTimeout(r, 1500))
            ]);
        } catch (e) {}

        // background
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#070d1a'); bg.addColorStop(0.55, '#0f172a'); bg.addColorStop(1, '#0b1322');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        const glow1 = ctx.createRadialGradient(W * 0.2, H * 0.12, 0, W * 0.2, H * 0.12, W * 0.8);
        glow1.addColorStop(0, 'rgba(16,185,129,0.16)'); glow1.addColorStop(1, 'rgba(16,185,129,0)');
        ctx.fillStyle = glow1; ctx.fillRect(0, 0, W, H);
        const glow2 = ctx.createRadialGradient(W * 0.85, H * 0.3, 0, W * 0.85, H * 0.3, W * 0.7);
        glow2.addColorStop(0, 'rgba(96,165,250,0.12)'); glow2.addColorStop(1, 'rgba(96,165,250,0)');
        ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);

        const pad = W * 0.09, maxW = W - pad * 2;
        const dateStr = new Date(Number(result.finishedAt) || Date.now()).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
        const font = (weight, size) => `${weight} ${size}px Outfit, system-ui, -apple-system, sans-serif`;

        // Text block: measured first (draw=false) so the fireworks get whatever room is left.
        function block(scale, topY, draw) {
            let y = topY;
            ctx.textAlign = 'center';
            const br = W * 0.062 * scale;
            if (draw) {
                ctx.save();
                ctx.shadowColor = accent; ctx.shadowBlur = 40;
                ctx.fillStyle = accent + '22'; ctx.strokeStyle = accent; ctx.lineWidth = 6;
                ctx.beginPath(); ctx.arc(W / 2, y + br, br, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.restore();
                ctx.fillStyle = accent;
                starPath(ctx, W / 2, y + br, br * 0.58, br * 0.26); ctx.fill();
            }
            y += br * 2 + W * 0.04 * scale;

            const title = fitText(ctx, result.title, '700', Math.round(W * 0.082 * scale), Math.round(W * 0.05 * scale), maxW, 2);
            ctx.font = font('700', title.size);
            ctx.fillStyle = '#f8fafc';
            title.lines.forEach((ln) => { y += title.size * 1.05; if (draw) ctx.fillText(ln, W / 2, y); y += title.size * 0.1; });
            y += W * 0.02 * scale;

            const sub = fitText(ctx, result.text, '400', Math.round(W * 0.04 * scale), Math.round(W * 0.028 * scale), maxW, 3);
            ctx.font = font('400', sub.size);
            ctx.fillStyle = '#94a3b8';
            sub.lines.forEach((ln) => { y += sub.size * 1.3; if (draw) ctx.fillText(ln, W / 2, y); });
            y += W * 0.025 * scale;

            (result.pills || []).slice(0, 2).forEach((p) => {
                const size = Math.round(W * 0.03 * scale);
                ctx.font = font('600', size);
                let text = p.text;
                while (ctx.measureText(text).width > maxW - size * 2 && text.length > 6) text = text.slice(0, -2);
                if (text !== p.text) text += '…';
                const tw = ctx.measureText(text).width, ph = size * 1.9, pw = tw + size * 1.6;
                y += W * 0.012 * scale;
                if (draw) {
                    ctx.fillStyle = 'rgba(148,163,184,0.14)';
                    roundRect(ctx, W / 2 - pw / 2, y, pw, ph, ph / 2); ctx.fill();
                    ctx.fillStyle = '#e2e8f0';
                    ctx.fillText(text, W / 2, y + ph * 0.66);
                }
                y += ph;
            });

            y += W * 0.04 * scale;
            const dsize = Math.round(W * 0.028 * scale);
            ctx.font = font('400', dsize);
            ctx.fillStyle = '#64748b';
            y += dsize;
            if (draw) ctx.fillText(dateStr, W / 2, y);
            return y;
        }

        const footerY = H * f.footer;
        const blockBottomMax = footerY - W * 0.09;
        let scale = 1, topY = 0;
        for (; scale >= 0.55; scale -= 0.05) {
            const h = block(scale, 0, false);
            topY = blockBottomMax - h;
            if (topY >= H * 0.36) break;
        }
        topY = Math.max(topY, H * 0.30);

        // fireworks (frozen frame) in the space above the text
        const fwTop = H * f.fw[0], fwBot = Math.max(fwTop + H * 0.2, topY - W * 0.03), fwH = fwBot - fwTop;
        const count = result.level === 'grande' ? 6 : (result.level === 'media' ? 4 : 3);
        const spots = [[0.5, 0.45, 0.30], [0.2, 0.25, 0.20], [0.8, 0.3, 0.21], [0.3, 0.72, 0.17], [0.72, 0.74, 0.16], [0.52, 0.08, 0.13]];
        for (let i = 0; i < count; i++) {
            const [sx, sy, sr] = spots[i];
            drawStaticBurst(ctx, W * sx, fwTop + fwH * sy, Math.min(W * sr * 1.2, fwH * sr * 1.5), FW_COLORS[(i * 2 + 1) % FW_COLORS.length], rand);
        }
        block(scale, topY, true);

        // footer: logo + app name
        const logo = await loadImage('favicon.png');
        const fy = footerY;
        const nameSize = Math.round(W * 0.044);
        ctx.font = `700 ${nameSize}px Outfit, system-ui, -apple-system, sans-serif`;
        const nameW = ctx.measureText('Academia Pro').width;
        const ls = W * 0.07, gap = W * 0.02;
        const total = (logo ? ls + gap : 0) + nameW;
        let fx = W / 2 - total / 2;
        if (logo) { ctx.save(); roundRect(ctx, fx, fy - ls * 0.72, ls, ls, ls * 0.22); ctx.clip(); ctx.drawImage(logo, fx, fy - ls * 0.72, ls, ls); ctx.restore(); fx += ls + gap; }
        ctx.textAlign = 'left';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText('Academia Pro', fx, fy);

        return await new Promise((resolve, reject) => {
            if (canvas.toBlob) canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob vazio'))), 'image/png');
            else reject(new Error('toBlob indisponível'));
        });
    }

    // ----- Celebration modal -----
    const celebModal = document.getElementById('celebration-modal');
    const celebCanvas = document.getElementById('celebration-canvas');
    const celebCard = celebModal ? celebModal.querySelector('.celebration-card') : null;
    const celebTitle = document.getElementById('celebration-title');
    const celebText = document.getElementById('celebration-text');
    const celebPills = document.getElementById('celebration-pills');
    const celebBadgeIcon = celebModal ? celebModal.querySelector('.celebration-badge i') : null;
    const shareBox = document.getElementById('celebration-share');
    const shareImg = document.getElementById('share-preview-img');
    const shareStatus = document.getElementById('share-status');
    const btnShare = document.getElementById('btn-share');
    const btnShareSave = document.getElementById('btn-share-save');
    const formatBtns = celebModal ? Array.from(celebModal.querySelectorAll('.share-format')) : [];
    let celebCurrent = null;
    let shareBlobs = {};
    let shareUrls = {};
    let shareFormat = 'feed';
    let shareToken = 0;

    function revokeShareUrls() {
        Object.values(shareUrls).forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
        shareUrls = {}; shareBlobs = {};
    }

    function setShareFormat(key) {
        shareFormat = key;
        formatBtns.forEach(b => {
            const on = b.dataset.format === key;
            b.classList.toggle('active', on);
            b.setAttribute('aria-checked', String(on));
        });
        updateSharePreview();
    }

    function updateSharePreview() {
        const blob = shareBlobs[shareFormat];
        const url = shareUrls[shareFormat];
        if (blob && url) {
            shareImg.src = url;
            shareImg.classList.remove('hidden');
            shareStatus.textContent = '';
            btnShare.disabled = false; btnShareSave.disabled = false;
        } else {
            shareImg.classList.add('hidden');
            shareStatus.textContent = 'Preparando imagem…';
            btnShare.disabled = true; btnShareSave.disabled = true;
        }
    }

    // Pre-generates every format (current one first) so the share click needs no await.
    async function prepareShareImages(result) {
        const token = ++shareToken;
        const order = [shareFormat, ...Object.keys(SHARE_FORMATS).filter(k => k !== shareFormat)];
        let anyOk = false;
        for (const key of order) {
            if (token !== shareToken) return;
            try {
                const blob = await renderShareImage(result, key);
                if (token !== shareToken) return;
                shareBlobs[key] = blob;
                shareUrls[key] = URL.createObjectURL(blob);
                anyOk = true;
                if (key === shareFormat) updateSharePreview();
            } catch (e) {
                console.error('Falha ao gerar imagem de compartilhamento', key, e);
            }
        }
        if (token === shareToken && !anyOk) shareBox.classList.add('hidden');
        else if (token === shareToken) updateSharePreview();
    }

    async function shareCurrentImage() {
        const blob = shareBlobs[shareFormat];
        if (!blob) return;
        try {
            const file = new File([blob], `academia-pro-${shareFormat}.png`, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], text: celebCurrent ? `${celebCurrent.title} · Academia Pro` : 'Academia Pro' });
                return;
            }
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            console.error('Falha ao compartilhar', e);
        }
        saveCurrentImage();
    }

    function saveCurrentImage() {
        const url = shareUrls[shareFormat];
        if (!url) return;
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = `academia-pro-${shareFormat}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (e) {
            console.error('Falha ao salvar imagem', e);
        }
    }

    function closeCelebration() {
        if (!celebModal || celebModal.classList.contains('hidden')) return;
        celebModal.classList.add('hidden');
        if (fwStop) { try { fwStop(); } catch (e) {} fwStop = null; }
        shareToken++;
        revokeShareUrls();
        if (shareImg) shareImg.removeAttribute('src');
        celebCurrent = null;
        safeRemove(CELEB_PENDING_KEY);
    }

    function openCelebration(result) {
        if (!celebModal || !result || celebCurrent) return;
        celebCurrent = result;
        celebCard.className = 'modal-content celebration-card celebration-level-' + (result.level || 'media');
        celebTitle.textContent = result.title;
        celebText.textContent = result.text;
        if (celebBadgeIcon) celebBadgeIcon.className = 'ph-fill ph-' + (result.icon || 'trophy');
        celebPills.innerHTML = '';
        (result.pills || []).forEach(p => {
            const el = document.createElement('span');
            el.className = 'celebration-pill';
            el.textContent = p.text;
            celebPills.appendChild(el);
        });
        if (result.more > 0) {
            const el = document.createElement('span');
            el.className = 'celebration-pill';
            el.textContent = `+${result.more} ${result.more === 1 ? 'conquista' : 'conquistas'}`;
            celebPills.appendChild(el);
        }
        celebPills.classList.toggle('hidden', !celebPills.children.length);
        celebModal.classList.remove('hidden');

        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduce) {
            try { fwStop = startFireworks(celebCanvas, result.level); } catch (e) { console.error('Fogos indisponíveis', e); }
            try { navigator.vibrate?.(30); } catch (e) {}
        }

        // share block (only when a blob can be produced)
        try {
            shareFormat = 'feed';
            shareBox.classList.remove('hidden');
            // Phones: one "Compartilhar" button (the system sheet already offers Instagram, WhatsApp,
            // "Salvar imagem", Files...). Browsers without file sharing keep only "Salvar".
            let canShareFiles = false;
            try {
                canShareFiles = !!(navigator.share && navigator.canShare &&
                    navigator.canShare({ files: [new File(['x'], 'a.png', { type: 'image/png' })] }));
            } catch (e) {}
            btnShare.classList.toggle('hidden', !canShareFiles);
            btnShareSave.classList.toggle('hidden', canShareFiles);
            setShareFormat('feed');
            prepareShareImages(result);
        } catch (e) {
            console.error(e);
            shareBox.classList.add('hidden');
        }
        try { document.getElementById('btn-celebration-close').focus({ preventScroll: true }); } catch (e) {}
    }

    // Reads the pending celebration saved at finish time and shows it once.
    function showCelebration() {
        try {
            const raw = safeGet(CELEB_PENDING_KEY);
            if (!raw) return;
            let result = null;
            try { result = JSON.parse(raw); } catch (e) {}
            if (!result || !result.title || Date.now() - (result.createdAt || 0) > CELEB_MAX_AGE) {
                safeRemove(CELEB_PENDING_KEY);
                return;
            }
            openCelebration(result);
        } catch (e) {
            console.error('Erro ao mostrar celebração', e);
        }
    }

    if (celebModal) {
        document.getElementById('btn-celebration-close').addEventListener('click', closeCelebration);
        celebModal.addEventListener('click', (e) => { if (e.target === celebModal) closeCelebration(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCelebration(); });
        formatBtns.forEach(b => b.addEventListener('click', () => setShareFormat(b.dataset.format)));
        btnShare.addEventListener('click', shareCurrentImage);
        btnShareSave.addEventListener('click', saveCurrentImage);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && fwStop) { try { fwStop(); } catch (e) {} fwStop = null; }
        });
        window.addEventListener('pagehide', () => { if (fwStop) { try { fwStop(); } catch (e) {} fwStop = null; } });
    }

    // Local-only preview: ?demo=celebration[&level=grande] (never active in production).
    if (['localhost', '127.0.0.1'].includes(location.hostname) && /[?&]demo=celebration/.test(location.search)) {
        const lvl = (location.search.match(/level=(leve|media|grande)/) || [])[1] || 'grande';
        window.__celebrationTest = { computeAchievements, buildCelebration, renderShareImage, startFireworks };
        window.__demoCelebration = (level = lvl) => openCelebration({
            v: 1, createdAt: Date.now(), finishedAt: Date.now(), level, icon: 'medal',
            title: level === 'leve' ? 'Treino completo' : 'Mês consistente',
            text: level === 'leve' ? 'Nada ficou pela metade hoje.' : 'Todas as semanas de outubro com a rotação completa. Isso é consistência de verdade.',
            pills: level === 'leve' ? [] : [{ icon: 'trend-up', text: 'Supino reto com barra: 40 → 42,5 kg' }, { icon: 'calendar-check', text: 'Semana em dia' }],
            more: 1, ids: []
        });
    }

    // ---------- Trophies (shelf) ----------
    // Status of the current periods is always computed from the workout history
    // (never modified here). A small optional ledger (academiaProTrophies) remembers
    // past periods so the "xN" counters survive the yearly history pruning.
    const TROPHY_LEDGER_KEY = 'academiaProTrophies';

    function longestWeekStreak(entries) {
        const weeks = [...new Set(entries.map(e => weekStart(Number(e.finishedAt))))].sort((a, b) => a - b);
        let best = 0, run = 0, prev = null;
        weeks.forEach(w => {
            run = (prev !== null && weekStart(shiftDays(prev, 7)) === w) ? run + 1 : 1;
            best = Math.max(best, run);
            prev = w;
        });
        return best;
    }

    function entryHasProgress(entry, allDesc) {
        if (!Array.isArray(entry.ex)) return false;
        const older = allDesc.filter(e => Number(e.finishedAt) < Number(entry.finishedAt));
        return entry.ex.some(x => {
            if (!x || !Array.isArray(x.s)) return false;
            const now = bestOfSets(x.s);
            const before = findLastPerf(older, x.n);
            const old = before && bestOfSets(before.sets);
            if (!now || !old) return false;
            return now.kg > old.kg + 0.001 || (Math.abs(now.kg - old.kg) < 0.001 && now.reps > old.reps);
        });
    }

    const entryTotal = (e) => e.totalExercises || ((e.doneExercises || 0) + (e.missedExercises || 0));
    const plannedDone = (entries, names) => new Set(entries.filter(e => names.includes(e.workoutName)).map(e => e.workoutName)).size;
    const cap = (value, meta) => ({ value: Math.min(value, meta), meta });

    // eval(ctx) -> { value, meta }. ctx: entries (this period), all, allDesc, names, start, daysInMonth, monthStart
    // Trophies whose rule depends on the plan's workout names are only recorded for the CURRENT
    // period, so editing the plan later can never retroactively credit old weeks/months.
    const NAME_DEPENDENT = ['semana-em-dia', 'mes-consistente'];
    const TROPHIES = [
        { id: 'semana-em-dia', scope: 'week', art: 'calendar', metal: 'prata', title: 'Semana em dia',
          desc: 'Todos os treinos da rotação feitos na mesma semana.',
          how: 'Faça cada treino programado (A, B, C…) pelo menos uma vez, de segunda a domingo.',
          quote: 'A rotação completa é onde o resultado acontece.',
          unit: 'treinos', eval: (c) => cap(plannedDone(c.entries, c.names), Math.max(c.names.length, 2)) },
        { id: 'sem-pular', scope: 'week', art: 'shield', metal: 'ouro', title: 'Sem pular nada',
          desc: 'Três treinos diferentes da semana com todos os exercícios concluídos.',
          how: 'Conclua 100% dos exercícios em 3 treinos diferentes durante a semana.',
          quote: 'Fazer tudo, mesmo nos dias ruins.',
          unit: 'treinos', eval: (c) => cap(new Set(c.entries.filter(e => entryTotal(e) > 0 && e.doneExercises === entryTotal(e)).map(e => e.workoutName)).size, 3) },
        { id: 'evolucao-semana', scope: 'week', art: 'medalArrow', metal: 'esmeralda', title: 'Evolução da semana',
          desc: 'Mais carga ou mais repetições que da última vez.',
          how: 'Registre carga e reps nos treinos e supere o seu último registro em algum exercício.',
          quote: 'Pequenos avanços, toda semana.',
          unit: '', eval: (c) => cap(c.entries.some(e => entryHasProgress(e, c.allDesc)) ? 1 : 0, 1) },

        { id: 'mes-5', scope: 'month', art: 'medalNum', num: '5', metal: 'bronze', title: '5 treinos no mês',
          desc: 'O ritmo começa a se formar.', how: 'Conclua 5 treinos dentro do mês.', quote: 'Cinco treinos e o hábito começa a pegar.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 5) },
        { id: 'mes-10', scope: 'month', art: 'medalNum', num: '10', metal: 'prata', title: '10 treinos no mês',
          desc: 'Já virou hábito.', how: 'Conclua 10 treinos dentro do mês.', quote: 'Dez treinos. O corpo já percebeu.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 10) },
        { id: 'mes-20', scope: 'month', art: 'medalNum', num: '20', metal: 'ouro', title: '20 treinos no mês',
          desc: 'Pouca gente chega até aqui.', how: 'Conclua 20 treinos dentro do mês.', quote: 'Vinte treinos num mês. Isso é disciplina.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 20) },
        { id: 'mes-30', scope: 'month', art: 'medalNum', num: '30', metal: 'esmeralda', title: '30 treinos no mês',
          desc: 'Um mês de dedicação rara.', how: 'Conclua 30 treinos dentro do mês.', quote: 'Trinta treinos. Poucos chegam nesse nível.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 30) },
        { id: 'mes-consistente', scope: 'month', art: 'cup', metal: 'ouro', title: 'Mês consistente',
          desc: 'Todas as semanas do mês com a rotação completa.',
          how: 'Complete a rotação inteira em todas as semanas (que começam na segunda-feira) do mês.',
          quote: 'Consistência de verdade, semana após semana.',
          unit: 'semanas', eval: (c) => {
              const mondays = mondaysOfMonth(c.monthStart.getFullYear(), c.monthStart.getMonth());
              const ok = mondays.filter(m => c.names.length >= 2 && plannedDone(c.all.filter(e => weekStart(Number(e.finishedAt)) === m), c.names) >= c.names.length).length;
              return cap(ok, Math.max(mondays.length, 1));
          } },
        { id: 'mes-fechado', scope: 'month', art: 'crown', metal: 'esmeralda', title: 'Mês fechado',
          desc: 'Treinou em todos os dias do mês.',
          how: 'Registre pelo menos um treino em cada dia do mês.',
          quote: 'Raro, difícil e digno de coroa.',
          unit: 'dias', eval: (c) => cap(new Set(c.entries.map(e => new Date(Number(e.finishedAt)).getDate())).size, c.daysInMonth) },

        { id: 'ano-50', scope: 'year', art: 'cupNum', num: '50', metal: 'bronze', title: '50 treinos no ano',
          desc: 'Meio caminho andado.', how: 'Conclua 50 treinos dentro do ano.', quote: 'Meio caminho andado.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 50) },
        { id: 'ano-100', scope: 'year', art: 'cupNum', num: '100', metal: 'prata', title: '100 treinos no ano',
          desc: 'Três dígitos. Respeito.', how: 'Conclua 100 treinos dentro do ano.', quote: 'Três dígitos. Respeito.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 100) },
        { id: 'ano-200', scope: 'year', art: 'cupNum', num: '200', metal: 'ouro', title: '200 treinos no ano',
          desc: 'Um ano de rotina de atleta.', how: 'Conclua 200 treinos dentro do ano.', quote: 'Isso já é estilo de vida.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 200) },

        { id: 'ano-300', scope: 'year', art: 'cupNum', num: '300', metal: 'esmeralda', title: '300 treinos no ano',
          desc: 'Quase um treino por dia, o ano inteiro.', how: 'Conclua 300 treinos dentro do ano.', quote: 'Trezentos treinos. Poucos chegam perto disso.',
          unit: 'treinos', eval: (c) => cap(c.entries.length, 300) },
        { id: 'ano-fechado', scope: 'year', art: 'crown', num: '365', metal: 'ouro', title: 'Ano fechado',
          desc: 'Treinou em todos os dias do ano.', how: 'Registre pelo menos um treino em cada dia do ano (365 ou 366 dias).',
          quote: 'Um ano inteiro sem faltar um dia.',
          unit: 'dias', eval: (c) => {
              const y = c.monthStart.getFullYear();
              const daysInYear = (new Date(y + 1, 0, 1) - new Date(y, 0, 1)) / DAY_MS;
              const days = new Set(c.entries.map(e => { const d = new Date(Number(e.finishedAt)); return d.getMonth() + '-' + d.getDate(); })).size;
              return cap(days, Math.round(daysInYear));
          } },

        { id: 'primeiro-treino', scope: 'forever', art: 'dumbbell', metal: 'ouro', title: 'Primeiro treino',
          desc: 'O primeiro treino registrado no app.', how: 'Finalize um treino com pelo menos um exercício feito.',
          quote: 'Todo histórico começa com um.',
          unit: '', eval: (c) => cap(c.all.length > 0 ? 1 : 0, 1) },
        { id: 'seq-4', scope: 'forever', art: 'flame', num: '4', metal: 'bronze', title: '4 semanas seguidas',
          desc: 'Um mês sem falhar uma semana.', how: 'Treine pelo menos uma vez por semana, durante 4 semanas seguidas. Vale o seu recorde.',
          quote: 'Um mês sem falhar uma semana.',
          unit: 'semanas', eval: (c) => cap(Math.max(longestWeekStreak(c.all), c.bestStreak || 0), 4) },
        { id: 'seq-8', scope: 'forever', art: 'flame', num: '8', metal: 'prata', title: '8 semanas seguidas',
          desc: 'Dois meses de constância.', how: 'Treine pelo menos uma vez por semana, durante 8 semanas seguidas. Vale o seu recorde.',
          quote: 'Dois meses de constância.',
          unit: 'semanas', eval: (c) => cap(Math.max(longestWeekStreak(c.all), c.bestStreak || 0), 8) },
        { id: 'seq-12', scope: 'forever', art: 'flame', num: '12', metal: 'ouro', title: '12 semanas seguidas',
          desc: 'Três meses sem faltar uma semana.', how: 'Treine pelo menos uma vez por semana, durante 12 semanas seguidas. Vale o seu recorde.',
          quote: 'Três meses sem faltar uma semana. Isso muda o corpo.',
          unit: 'semanas', eval: (c) => cap(Math.max(longestWeekStreak(c.all), c.bestStreak || 0), 12) }
    ];

    const TROPHY_SCOPES = [
        { key: 'week', title: 'Esta semana', icon: 'calendar-blank' },
        { key: 'month', title: 'Este mês', icon: 'calendar' },
        { key: 'year', title: 'Este ano', icon: 'sun' },
        { key: 'forever', title: 'Para sempre', icon: 'infinity' }
    ];

    function validEntries(history) {
        return (history || []).filter(e => e && typeof e === 'object' && (e.doneExercises || 0) > 0 && Number.isFinite(Number(e.finishedAt)));
    }

    function trophyContext(all, scope, ref, names) {
        const t = ref.getTime();
        const allDesc = [...all].sort((a, b) => Number(b.finishedAt) - Number(a.finishedAt));
        const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1);
        const ctx = { all, allDesc, names, monthStart, daysInMonth: new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate() };
        if (scope === 'week') { const ws = weekStart(t); ctx.entries = all.filter(e => weekStart(Number(e.finishedAt)) === ws); }
        else if (scope === 'month') ctx.entries = all.filter(e => { const d = new Date(Number(e.finishedAt)); return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth(); });
        else if (scope === 'year') ctx.entries = all.filter(e => new Date(Number(e.finishedAt)).getFullYear() === ref.getFullYear());
        else ctx.entries = all;
        return ctx;
    }

    function periodKey(scope, ref) {
        if (scope === 'week') { const d = new Date(weekStart(ref.getTime())); return 'S' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
        if (scope === 'month') return 'M' + ref.getFullYear() + '-' + String(ref.getMonth() + 1).padStart(2, '0');
        if (scope === 'year') return 'Y' + ref.getFullYear();
        return 'A';
    }

    function daysUntilReset(scope, now) {
        let end;
        if (scope === 'week') end = new Date(shiftDays(weekStart(now.getTime()), 7));
        else if (scope === 'month') end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        else if (scope === 'year') end = new Date(now.getFullYear() + 1, 0, 1);
        else return null;
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return Math.max(1, Math.round((end - today) / DAY_MS));
    }

    function readTrophyLedger() {
        try {
            const raw = safeGet(TROPHY_LEDGER_KEY);
            const obj = raw ? JSON.parse(raw) : null;
            if (obj && typeof obj === 'object' && obj.items && typeof obj.items === 'object' && !Array.isArray(obj.items)) return obj.items;
        } catch (e) {}
        return {};
    }

    // Pure: state of every trophy for the current periods (+ counts from `ledger`).
    function computeTrophies(history, treinos, now, ledger) {
        const all = validEntries(history);
        const names = (treinos || []).map(x => x.nome);
        return TROPHIES.map(def => {
            const ctx = trophyContext(all, def.scope, now, names);
            ctx.bestStreak = Number((ledger || {})['seq-best|A']) || 0;
            let res;
            try { res = def.eval(ctx); } catch (e) { res = { value: 0, meta: 1 }; }
            const earned = res.meta > 0 && res.value >= res.meta;
            const keys = Object.keys(ledger || {}).filter(k => k.startsWith(def.id + '|'));
            const curKey = def.id + '|' + periodKey(def.scope, now);
            let count = keys.length;
            if (earned && !keys.includes(curKey)) count++;
            const lastTs = keys.reduce((m, k) => Math.max(m, Number(ledger[k]) || 0), 0);
            return { def, value: res.value, meta: res.meta, earned, count, lastTs };
        });
    }

    // Adds every trophy earned in any period present in `history` to the ledger (never removes).
    function syncTrophyLedger(history, treinos) {
        const all = validEntries(history);
        if (!all.length) return;
        const names = (treinos || []).map(x => x.nome);
        const items = readTrophyLedger();
        let changed = false;
        const add = (key, ts) => { if (!(key in items)) { items[key] = ts; changed = true; } };
        ['week', 'month', 'year'].forEach(scope => {
            const periods = new Map();
            all.forEach(e => {
                const ref = new Date(Number(e.finishedAt));
                const k = periodKey(scope, ref);
                if (!periods.has(k)) periods.set(k, { ref, last: Number(e.finishedAt) });
                else periods.get(k).last = Math.max(periods.get(k).last, Number(e.finishedAt));
            });
            periods.forEach((p, k) => {
                const ctx = trophyContext(all, scope, p.ref, names);
                const isCurrent = k === periodKey(scope, new Date());
                TROPHIES.filter(d => d.scope === scope).forEach(def => {
                    if (NAME_DEPENDENT.includes(def.id) && !isCurrent) return;
                    let res; try { res = def.eval(ctx); } catch (e) { return; }
                    if (res.meta > 0 && res.value >= res.meta) add(def.id + '|' + k, p.last);
                });
            });
        });
        const ctxF = trophyContext(all, 'forever', new Date(), names);
        const bestNow = longestWeekStreak(all);
        if (bestNow > (Number(items['seq-best|A']) || 0)) { items['seq-best|A'] = bestNow; changed = true; }
        ctxF.bestStreak = Number(items['seq-best|A']) || 0;
        const lastAll = all.reduce((m, e) => Math.max(m, Number(e.finishedAt)), 0);
        TROPHIES.filter(d => d.scope === 'forever').forEach(def => {
            let res; try { res = def.eval(ctxF); } catch (e) { return; }
            if (res.meta > 0 && res.value >= res.meta) add(def.id + '|A', lastAll);
        });
        if (changed) safeSet(TROPHY_LEDGER_KEY, JSON.stringify({ v: 1, items }));
    }

    // ----- Trophy art (inline SVG, no external images) -----
    const METALS = {
        bronze: ['#f6c38a', '#cd7f32', '#7a4a1d'],
        prata: ['#ffffff', '#cbd5e1', '#64748b'],
        ouro: ['#fff4b0', '#fcd34d', '#b45309'],
        esmeralda: ['#d1fae5', '#34d399', '#047857'],
        lock: ['#64748b', '#475569', '#1e293b']
    };

    function ensureTrophyDefs() {
        if (document.getElementById('trophy-defs')) return;
        const grads = Object.entries(METALS).map(([k, c]) =>
            `<linearGradient id="tg-${k}" x1="0" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="0.5" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"/></linearGradient>`).join('');
        const holder = document.createElement('div');
        holder.innerHTML = `<svg id="trophy-defs" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${grads}
            <linearGradient id="tg-ribbon" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient>
            <linearGradient id="tg-ribbon-lock" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#475569"/><stop offset="1" stop-color="#334155"/></linearGradient>
            <radialGradient id="tg-shine" cx="0.3" cy="0.25" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity="0.65"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
            </defs></svg>`;
        document.body.appendChild(holder.firstChild);
    }

    // Returns an SVG string (viewBox 0 0 100 104). `locked` renders the grey silhouette.
    function trophyArt(def, locked) {
        const m = locked ? 'lock' : def.metal;
        const fill = `url(#tg-${m})`;
        const dark = locked ? '#1e293b' : (def.metal === 'prata' ? '#475569' : (def.metal === 'esmeralda' ? '#064e3b' : (def.metal === 'ouro' ? '#7c4a03' : '#4a2a0d')));
        const light = locked ? '#94a3b8' : '#ffffff';
        const ribbon = locked ? 'url(#tg-ribbon-lock)' : 'url(#tg-ribbon)';
        const num = (txt, x, y, size) => {
            const t = String(txt);
            const s = t.length >= 3 ? size * 0.78 : size;
            return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Outfit, system-ui, sans-serif" font-weight="800" font-size="${s}" fill="${dark}" stroke="${light}" stroke-opacity="0.35" stroke-width="0.8" paint-order="stroke">${t}</text>`;
        };
        const shadow = '<ellipse cx="50" cy="98" rx="27" ry="4.2" fill="#000" opacity="0.38"/>';
        let body = '';
        switch (def.art) {
            case 'medalNum':
            case 'medalArrow':
                body = `<path d="M33 6 L50 40 L40 44 L24 12 Z" fill="${ribbon}"/><path d="M67 6 L50 40 L60 44 L76 12 Z" fill="${ribbon}" opacity="0.92"/>
                    <circle cx="50" cy="66" r="29" fill="${fill}"/><circle cx="50" cy="66" r="29" fill="none" stroke="${dark}" stroke-opacity="0.35" stroke-width="2"/>
                    <circle cx="50" cy="66" r="22.5" fill="none" stroke="${light}" stroke-opacity="0.55" stroke-width="2"/>
                    <circle cx="50" cy="66" r="29" fill="url(#tg-shine)"/>` +
                    (def.art === 'medalNum'
                        ? num(def.num, 50, 66 + (String(def.num).length >= 3 ? 7 : 9.5), String(def.num).length >= 2 ? 25 : 30)
                        : `<path d="M50 50 L65 68 H55.5 V82 H44.5 V68 H35 Z" fill="${dark}" opacity="0.92"/>`);
                break;
            case 'cup':
            case 'cupNum':
                body = `<path d="M29 24 H17 C17 44 25 51 35 53" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/>
                    <path d="M71 24 H83 C83 44 75 51 65 53" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/>
                    <path d="M27 14 H73 V38 C73 56 63 66 50 66 C37 66 27 56 27 38 Z" fill="${fill}"/>
                    <path d="M27 14 H73 V38 C73 56 63 66 50 66 C37 66 27 56 27 38 Z" fill="url(#tg-shine)"/>
                    <rect x="45" y="66" width="10" height="13" rx="2" fill="${fill}"/>
                    <path d="M30 90 L34 80 H66 L70 90 Z" fill="${fill}"/><rect x="30" y="88" width="40" height="5" rx="2" fill="${dark}" opacity="0.5"/>` +
                    (def.art === 'cupNum' ? num(def.num, 50, 48, String(def.num).length >= 3 ? 22 : 26)
                        : `<path d="M50 28 l3.6 8 8.4.8-6.3 5.6 1.9 8.3-7.6-4.4-7.6 4.4 1.9-8.3-6.3-5.6 8.4-.8z" fill="${dark}" opacity="0.85"/>`);
                break;
            case 'shield':
                body = `<path d="M50 8 L82 20 V47 C82 70 68 85 50 94 C32 85 18 70 18 47 V20 Z" fill="${fill}"/>
                    <path d="M50 8 L82 20 V47 C82 70 68 85 50 94 C32 85 18 70 18 47 V20 Z" fill="none" stroke="${dark}" stroke-opacity="0.4" stroke-width="2"/>
                    <path d="M50 17 L74 26 V47 C74 65 63 77 50 85 C37 77 26 65 26 47 V26 Z" fill="none" stroke="${light}" stroke-opacity="0.5" stroke-width="2"/>
                    <path d="M50 8 L82 20 V47 C82 70 68 85 50 94 C32 85 18 70 18 47 V20 Z" fill="url(#tg-shine)"/>
                    <path d="M36 52 L46 62 L65 40" fill="none" stroke="${dark}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'crown':
                body = `<path d="M16 76 L10 34 L33 54 L50 22 L67 54 L90 34 L84 76 Z" fill="${fill}"/>
                    <path d="M16 76 L10 34 L33 54 L50 22 L67 54 L90 34 L84 76 Z" fill="url(#tg-shine)"/>
                    <rect x="16" y="76" width="68" height="12" rx="4" fill="${fill}"/><rect x="16" y="76" width="68" height="12" rx="4" fill="none" stroke="${dark}" stroke-opacity="0.35" stroke-width="1.6"/>
                    <circle cx="50" cy="16" r="5" fill="${fill}"/><circle cx="9" cy="30" r="4.5" fill="${fill}"/><circle cx="91" cy="30" r="4.5" fill="${fill}"/>
                    <circle cx="50" cy="64" r="5.5" fill="${locked ? '#94a3b8' : '#f43f5e'}"/><circle cx="31" cy="68" r="4" fill="${locked ? '#94a3b8' : '#60a5fa'}"/><circle cx="69" cy="68" r="4" fill="${locked ? '#94a3b8' : '#60a5fa'}"/>
                    ${def.num ? `<text x="50" y="85.5" text-anchor="middle" font-family="Outfit, system-ui, sans-serif" font-weight="800" font-size="9.5" fill="${dark}">${def.num}</text>` : `<circle cx="50" cy="82" r="2.2" fill="${dark}" opacity="0.5"/><circle cx="34" cy="82" r="2.2" fill="${dark}" opacity="0.5"/><circle cx="66" cy="82" r="2.2" fill="${dark}" opacity="0.5"/>`}`;
                break;
            case 'flame':
                body = `<path d="M50 6 C55 24 76 34 76 58 C76 78 64 92 50 92 C36 92 24 78 24 58 C24 47 31 40 36 33 C36 45 42 48 45 43 C50 34 43 22 50 6 Z" fill="${fill}"/>
                    <path d="M50 6 C55 24 76 34 76 58 C76 78 64 92 50 92 C36 92 24 78 24 58 C24 47 31 40 36 33 C36 45 42 48 45 43 C50 34 43 22 50 6 Z" fill="url(#tg-shine)"/>
                    <path d="M50 44 C55 54 64 58 64 70 C64 80 58 86 50 86 C42 86 36 80 36 70 C36 62 41 58 44 52 C46 58 49 58 50 44 Z" fill="${light}" opacity="${locked ? 0.25 : 0.38}"/>` +
                    num(def.num, 50, 80, String(def.num).length >= 2 ? 24 : 28);
                break;
            case 'calendar':
                body = `<rect x="15" y="20" width="70" height="68" rx="10" fill="${fill}"/>
                    <rect x="15" y="20" width="70" height="20" rx="10" fill="${dark}" opacity="0.45"/><rect x="15" y="30" width="70" height="10" fill="${dark}" opacity="0.45"/>
                    <rect x="28" y="10" width="8" height="18" rx="4" fill="${fill}" stroke="${dark}" stroke-opacity="0.4" stroke-width="1.5"/><rect x="64" y="10" width="8" height="18" rx="4" fill="${fill}" stroke="${dark}" stroke-opacity="0.4" stroke-width="1.5"/>
                    <rect x="15" y="20" width="70" height="68" rx="10" fill="url(#tg-shine)"/>
                    <path d="M32 64 L45 76 L69 50" fill="none" stroke="${dark}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
                break;
            case 'dumbbell':
                body = `<path d="M50 6 l4.4 10 10.6 1-8 7.2 2.4 10.6-9.4-5.6-9.4 5.6 2.4-10.6-8-7.2 10.6-1z" fill="${fill}"/>
                    <rect x="31" y="62" width="38" height="8" rx="3" fill="${dark}" opacity="0.7"/>
                    <rect x="14" y="50" width="12" height="32" rx="4" fill="${fill}"/><rect x="24" y="44" width="10" height="44" rx="4" fill="${fill}"/>
                    <rect x="74" y="50" width="12" height="32" rx="4" fill="${fill}"/><rect x="66" y="44" width="10" height="44" rx="4" fill="${fill}"/>
                    <rect x="24" y="44" width="10" height="44" rx="4" fill="url(#tg-shine)"/><rect x="66" y="44" width="10" height="44" rx="4" fill="url(#tg-shine)"/>`;
                break;
            default:
                body = `<circle cx="50" cy="52" r="30" fill="${fill}"/>`;
        }
        return `<svg class="trophy-svg" viewBox="0 0 100 104" role="img" aria-hidden="true" focusable="false">${shadow}${body}</svg>`;
    }

    // ----- Gallery UI -----
    const trophyListEl = document.getElementById('trophy-list');
    const trophySummaryEl = document.getElementById('trophy-summary');
    const trophyModal = document.getElementById('trophy-modal');
    let trophyStates = [];

    function resetLabel(scope, now) {
        const d = daysUntilReset(scope, now);
        if (d === null) return 'sem renovação';
        return d === 1 ? 'renova amanhã' : `renova em ${d} dias`;
    }

    function trophyCard(st) {
        const { def, earned } = st;
        const pct = st.meta ? Math.round((st.value / st.meta) * 100) : 0;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'trophy-card' + (earned ? ' earned' : ' locked') + ' metal-' + def.metal;
        card.dataset.id = def.id;
        card.setAttribute('aria-label', `${def.title}: ${earned ? 'conquistado' : `${st.value} de ${st.meta}`}`);
        card.innerHTML = `
            <span class="trophy-stage">
                ${trophyArt(def, !earned)}
                ${!earned ? '<i class="ph-fill ph-lock-simple trophy-lock"></i>' : ''}
                ${earned && st.count > 1 ? `<span class="trophy-count">×${st.count}</span>` : ''}
            </span>
            <span class="trophy-name">${esc(def.title)}</span>
            ${earned
                ? '<span class="trophy-status">Conquistado</span>'
                : `<span class="trophy-progress"><span style="width:${pct}%"></span></span><span class="trophy-fraction">${st.value}/${st.meta}</span>`}
        `;
        card.addEventListener('click', () => openTrophyModal(st.def.id));
        return card;
    }

    const trophyMQ = window.matchMedia ? window.matchMedia('(min-width: 480px)') : null;
    const trophyColumns = () => (trophyMQ && trophyMQ.matches ? 4 : 3);
    if (trophyMQ && trophyMQ.addEventListener) trophyMQ.addEventListener('change', () => { if (currentTab === 'trofeus') renderTrophies(); });

    function renderTrophies() {
        if (!trophyListEl) return;
        ensureTrophyDefs();
        try {
            const history = getWorkoutHistory();
            try { syncTrophyLedger(history, workoutData ? workoutData.treinos : []); } catch (e) { console.error('Erro no livro de troféus', e); }
            const now = new Date();
            trophyStates = computeTrophies(history, workoutData ? workoutData.treinos : [], now, readTrophyLedger());
            const earnedNow = trophyStates.filter(s => s.earned).length;
            const totalEver = trophyStates.reduce((a, s) => a + Math.max(s.count, s.earned ? 1 : 0), 0);
            trophySummaryEl.textContent = validEntries(history).length
                ? `${earnedNow} conquistado${earnedNow === 1 ? '' : 's'} agora · ${totalEver} no total`
                : 'Seus troféus aparecem aqui conforme você treina.';
            trophyListEl.innerHTML = '';
            TROPHY_SCOPES.forEach(scope => {
                const list = trophyStates.filter(s => s.def.scope === scope.key);
                const got = list.filter(s => s.earned).length;
                const sec = document.createElement('section');
                sec.className = 'shelf-section';
                sec.innerHTML = `
                    <header class="shelf-head">
                        <h3><i class="ph-fill ph-${scope.icon}"></i> ${scope.title}</h3>
                        <span class="shelf-meta"><strong>${got}/${list.length}</strong> · ${resetLabel(scope.key, now)}</span>
                    </header>
                    <div class="shelf"></div>`;
                const shelf = sec.querySelector('.shelf');
                list.forEach(s => shelf.appendChild(trophyCard(s)));
                // Ghost cells keep the shelf board continuous under the last, incomplete row.
                const cols = trophyColumns();
                for (let g = (cols - (list.length % cols)) % cols; g > 0; g--) {
                    const ghost = document.createElement('div');
                    ghost.className = 'trophy-card ghost';
                    ghost.setAttribute('aria-hidden', 'true');
                    ghost.innerHTML = '<span class="trophy-stage"><svg class="trophy-svg" viewBox="0 0 100 104"></svg></span><span class="trophy-name">&nbsp;</span>';
                    shelf.appendChild(ghost);
                }
                trophyListEl.appendChild(sec);
            });
        } catch (e) {
            console.error('Erro ao montar troféus', e);
            trophyListEl.innerHTML = '<p class="history-empty">Não foi possível carregar os troféus agora.</p>';
        }
    }

    function openTrophyModal(id) {
        const st = trophyStates.find(s => s.def.id === id);
        if (!st || !trophyModal) return;
        const { def } = st, now = new Date();
        const scopeInfo = TROPHY_SCOPES.find(s => s.key === def.scope);
        const status = st.earned ? 'Conquistado' : (st.value > 0 ? 'Em andamento' : 'Bloqueado');
        const left = st.meta - st.value;
        const pct = st.meta ? Math.round((st.value / st.meta) * 100) : 0;
        let period;
        if (def.scope === 'week') period = `Vale para esta semana · ${resetLabel('week', now)}`;
        else if (def.scope === 'month') period = `Vale para ${MONTHS_PT[now.getMonth()]} · ${resetLabel('month', now)}`;
        else if (def.scope === 'year') period = `Vale para ${now.getFullYear()} · ${resetLabel('year', now)}`;
        else period = 'Não renova — fica com você para sempre';
        const times = st.count === 0 ? 'Ainda não conquistado.' : `Conquistado ${st.count} ${st.count === 1 ? 'vez' : 'vezes'}${st.lastTs ? ' · última em ' + new Date(st.lastTs).toLocaleDateString('pt-BR') : ''}.`;
        const progressText = st.earned ? 'Meta atingida' : (def.unit
            ? `${st.value} de ${st.meta} ${def.unit} · faltam ${left}`
            : (def.id === 'evolucao-semana' ? 'Ainda sem evolução registrada nesta semana' : 'Ainda não conquistado'));
        trophyModal.querySelector('.trophy-modal-art').innerHTML = trophyArt(def, !st.earned);
        trophyModal.querySelector('.trophy-modal-art').className = 'trophy-modal-art' + (st.earned ? ' earned metal-' + def.metal : ' locked');
        document.getElementById('trophy-modal-title').textContent = def.title;
        const chip = document.getElementById('trophy-modal-status');
        chip.textContent = status;
        chip.className = 'trophy-chip ' + (st.earned ? 'earned' : (st.value > 0 ? 'progress' : 'locked'));
        document.getElementById('trophy-modal-desc').textContent = def.desc;
        document.getElementById('trophy-modal-how').textContent = def.how;
        document.getElementById('trophy-modal-bar').style.width = pct + '%';
        document.getElementById('trophy-modal-progress').textContent = progressText;
        document.getElementById('trophy-modal-period').textContent = period;
        document.getElementById('trophy-modal-times').textContent = times;
        document.getElementById('trophy-modal-quote').textContent = '“' + def.quote + '”';
        trophyModal.classList.remove('hidden');
        try { document.getElementById('btn-trophy-close').focus({ preventScroll: true }); } catch (e) {}
    }

    function closeTrophyModal() { if (trophyModal) trophyModal.classList.add('hidden'); }
    if (trophyModal) {
        document.getElementById('btn-trophy-close').addEventListener('click', closeTrophyModal);
        document.getElementById('btn-trophy-x').addEventListener('click', closeTrophyModal);
        trophyModal.addEventListener('click', (e) => { if (e.target === trophyModal) closeTrophyModal(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTrophyModal(); });
    }

    // Test hook (localhost only)
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
        window.__trophyTest = { computeTrophies, syncTrophyLedger, trophyArt, TROPHIES, readTrophyLedger, longestWeekStreak, ensureTrophyDefs };
    }

    // ---------- History tab: stats dashboard ----------
    let historyShown = 10;

    const DAY_MS = 86400000;
    function weekStart(ts) {
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
        return d.getTime();
    }

    function lineChartSvg(points, unit) {
        if (points.length === 0) return '';
        const W = 320, H = 150, L = 38, R = 14, T = 16, B = 28;
        const vals = points.map(p => p.value);
        let min = Math.min(...vals), max = Math.max(...vals);
        if (min === max) { min = Math.max(0, min - 1); max = max + 1; }
        const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
        const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
        const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
        const area = `${x(0).toFixed(1)},${H - B} ${pts} ${x(points.length - 1).toFixed(1)},${H - B}`;
        const grid = [0, 0.5, 1].map(f => {
            const v = min + (max - min) * f;
            const yy = y(v).toFixed(1);
            return `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="chart-grid"/><text x="${L - 6}" y="${(+yy + 4)}" class="chart-label" text-anchor="end">${fmtNum(v)}</text>`;
        }).join('');
        const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" class="chart-dot"/>`).join('');
        const last = points[points.length - 1];
        return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de evolução (${esc(unit)})">
            ${grid}
            <polygon points="${area}" class="chart-area"/>
            <polyline points="${pts}" class="chart-line"/>
            ${dots}
            <text x="${L}" y="${H - 8}" class="chart-label">${esc(points[0].label)}</text>
            ${points.length > 1 ? `<text x="${W - R}" y="${H - 8}" class="chart-label" text-anchor="end">${esc(last.label)}</text>` : ''}
        </svg>`;
    }

    const shortDate = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

    function buildExerciseProgress(history) {
        // chronological sessions per exercise
        const map = new Map();
        [...history].reverse().forEach(entry => {
            (entry.ex || []).forEach(x => {
                if (!x || !Array.isArray(x.s)) return;
                const sets = x.s.filter(Boolean);
                if (!sets.length) return;
                const maxKg = Math.max(...sets.map(s => parseNum(s[0]) || 0));
                const maxReps = Math.max(...sets.map(s => parseNum(s[1]) || 0));
                const key = normName(x.n);
                if (!map.has(key)) map.set(key, { name: x.n, sessions: [] });
                map.get(key).sessions.push({ t: entry.finishedAt, kg: maxKg, reps: maxReps });
            });
        });
        return [...map.values()].sort((a, b) => b.sessions.length - a.sessions.length);
    }

    function renderExerciseChart(exercises, idx, host) {
        const ex = exercises[idx];
        if (!ex) { host.innerHTML = ''; return; }
        const useKg = ex.sessions.some(s => s.kg > 0);
        const key = useKg ? 'kg' : 'reps';
        const unit = useKg ? 'kg' : 'reps';
        const pts = ex.sessions.slice(-12).map(s => ({ value: s[key], label: shortDate(s.t) }));
        const best = ex.sessions.reduce((a, s) => (s[key] >= a[key] ? s : a), ex.sessions[0]);
        const first = ex.sessions[0][key], now = ex.sessions[ex.sessions.length - 1][key];
        const diff = now - first;
        host.innerHTML = `
            <div class="pr-row">
                <span class="pr-badge">🏆 Recorde: ${fmtNum(best[key])} ${unit} <small>${shortDate(best.t)}</small></span>
                <span class="pr-diff ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${fmtNum(diff)} ${unit} desde o início</span>
            </div>
            ${lineChartSvg(pts, unit)}`;
    }

    function buildStats(history) {
        const valid = validEntries(history);
        const now = Date.now();
        const nowD = new Date(now);
        const monthStart = new Date(nowD.getFullYear(), nowD.getMonth(), 1).getTime();
        const monthEntries = valid.filter(e => e.finishedAt >= monthStart);

        // weekly streak
        const weeks = new Set(valid.map(e => weekStart(e.finishedAt)));
        let cursor = weekStart(now);
        if (!weeks.has(cursor)) cursor = weekStart(shiftDays(cursor, -7));
        let streak = 0;
        while (weeks.has(cursor)) { streak++; cursor = weekStart(shiftDays(cursor, -7)); }

        const totalSecs = valid.reduce((a, e) => a + (e.totalSeconds || 0), 0);
        const avgSecs = valid.length ? Math.round(totalSecs / valid.length) : 0;
        const doneSum = valid.reduce((a, e) => a + (e.doneExercises || 0), 0);
        const totalSum = valid.reduce((a, e) => a + (e.totalExercises || ((e.doneExercises || 0) + (e.missedExercises || 0))), 0);
        const completion = totalSum ? Math.round((doneSum / totalSum) * 100) : 0;
        const hrs = Math.floor(totalSecs / 3600), mins = Math.floor((totalSecs % 3600) / 60);

        // 8 weekly bars
        const curWeek = weekStart(now);
        const bars = [];
        for (let i = 7; i >= 0; i--) {
            const ws = weekStart(shiftDays(curWeek, -7 * i));
            const c = valid.filter(e => weekStart(e.finishedAt) === ws).length;
            bars.push({ ws, c });
        }
        const maxBar = Math.max(1, ...bars.map(b => b.c));
        const barsHtml = bars.map(b => `
            <div class="bar-col">
                <span class="bar-val">${b.c || ''}</span>
                <div class="bar-track"><div class="bar-fill" style="height:${(b.c / maxBar) * 100}%"></div></div>
                <span class="bar-label">${shortDate(b.ws)}</span>
            </div>`).join('');

        // month calendar
        const daysInMonth = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
        const firstDow = new Date(nowD.getFullYear(), nowD.getMonth(), 1).getDay(); // 0 = Sunday
        const perDay = {};
        monthEntries.forEach(e => { const d = new Date(e.finishedAt).getDate(); perDay[d] = (perDay[d] || 0) + 1; });
        let cal = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(d => `<span class="cal-dow">${d}</span>`).join('');
        for (let i = 0; i < firstDow; i++) cal += '<span class="cal-cell empty"></span>';
        for (let d = 1; d <= daysInMonth; d++) {
            const c = perDay[d] || 0;
            cal += `<span class="cal-cell${c ? ' has' : ''}${d === nowD.getDate() ? ' today' : ''}" title="${c} treino(s)">${d}</span>`;
        }
        const monthRaw = nowD.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(' de ', ' ');
        const monthName = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1);

        // volume trend
        const volumes = [...valid].reverse().map(e => {
            if (!Array.isArray(e.ex)) return null;
            let vol = 0;
            e.ex.forEach(x => (x.s || []).forEach(s => { if (s) vol += (parseNum(s[0]) || 0) * (parseNum(s[1]) || 0); }));
            return vol > 0 ? { value: Math.round(vol), label: shortDate(e.finishedAt) } : null;
        }).filter(Boolean).slice(-10);

        // exercise progress
        const exercises = buildExerciseProgress(valid);

        // most skipped (last 30 workouts)
        const skipped = getMissedExerciseRanking(30, 5);
        const maxSk = skipped.length ? skipped[0].count : 1;

        const el = document.createElement('div');
        el.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card"><i class="ph-fill ph-calendar-check"></i><strong>${monthEntries.length}</strong><span>treinos no mês</span></div>
                <div class="stat-card"><i class="ph-fill ph-fire"></i><strong>${streak}</strong><span>${streak === 1 ? 'semana seguida' : 'semanas seguidas'}</span></div>
                <div class="stat-card"><i class="ph-fill ph-clock"></i><strong>${hrs}h${String(mins).padStart(2, '0')}</strong><span>tempo total</span></div>
                <div class="stat-card"><i class="ph-fill ph-timer"></i><strong>${Math.round(avgSecs / 60)}min</strong><span>duração média</span></div>
                <div class="stat-card"><i class="ph-fill ph-target"></i><strong>${completion}%</strong><span>exercícios feitos</span></div>
                <div class="stat-card"><i class="ph-fill ph-barbell"></i><strong>${valid.length}</strong><span>treinos salvos</span></div>
            </div>

            <div class="stats-card">
                <h4><i class="ph ph-chart-bar"></i> Frequência semanal</h4>
                <div class="bars">${barsHtml}</div>
            </div>

            <div class="stats-card">
                <h4><i class="ph ph-calendar-blank"></i> <span>${esc(monthName)}</span></h4>
                <div class="cal-grid">${cal}</div>
            </div>

            ${volumes.length >= 1 ? `
            <div class="stats-card">
                <h4><i class="ph ph-trend-up"></i> Volume por treino <small>(kg × reps)</small></h4>
                ${lineChartSvg(volumes, 'kg × reps')}
            </div>` : ''}

            ${exercises.length ? `
            <div class="stats-card">
                <h4><i class="ph ph-medal"></i> Evolução por exercício</h4>
                <select id="stats-ex-select" class="stats-select" aria-label="Exercício">
                    ${exercises.map((x, i) => `<option value="${i}">${esc(x.name)} (${x.sessions.length}x)</option>`).join('')}
                </select>
                <div id="stats-ex-chart"></div>
            </div>` : `
            <div class="stats-card stats-hint">
                <h4><i class="ph ph-medal"></i> Evolução por exercício</h4>
                <p>Registre carga e reps durante o treino (tela de descanso ou ícone de lápis no exercício) para ver sua evolução e recordes aqui.</p>
            </div>`}

            ${skipped.length ? `
            <div class="stats-card">
                <h4><i class="ph ph-skull"></i> Mais pulados <small>(últimos 30 treinos)</small></h4>
                <div class="skip-list">
                    ${skipped.map(s => `
                        <div class="skip-row">
                            <span class="skip-name">${esc(s.name)}</span>
                            <div class="skip-bar"><div style="width:${(s.count / maxSk) * 100}%"></div></div>
                            <span class="skip-count">${s.count}x</span>
                        </div>`).join('')}
                </div>
            </div>` : ''}
        `;

        const select = el.querySelector('#stats-ex-select');
        if (select) {
            const host = el.querySelector('#stats-ex-chart');
            renderExerciseChart(exercises, 0, host);
            select.addEventListener('change', () => renderExerciseChart(exercises, parseInt(select.value, 10), host));
        }
        return el;
    }

    function renderHistoryView() {
        if (!historyListEl) return;
        const history = getWorkoutHistory();
        historyListEl.innerHTML = '';
        if (statsEl) statsEl.innerHTML = '';
        if (history.length === 0) {
            historyListEl.innerHTML = '<p class="history-empty">Nenhum treino concluído ainda.</p>';
            return;
        }
        if (statsEl) {
            try { statsEl.appendChild(buildStats(history)); } catch (e) { console.error('Erro nas estatísticas', e); }
        }
        const title = document.createElement('h3');
        title.className = 'history-title';
        title.textContent = 'Treinos recentes';
        historyListEl.appendChild(title);
        history.slice(0, historyShown).forEach(entry => historyListEl.appendChild(buildWorkoutSummaryCard(entry)));
        if (history.length > historyShown) {
            const more = document.createElement('button');
            more.className = 'btn-secondary history-more';
            more.textContent = `Mostrar mais (${history.length - historyShown})`;
            more.addEventListener('click', () => { historyShown += 10; renderHistoryView(); });
            historyListEl.appendChild(more);
        }
    }

    // Start App
    setupServiceWorker();
    init();
});
