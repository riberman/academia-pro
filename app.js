document.addEventListener('DOMContentLoaded', () => {
    // State
    let workoutData = null;
    let currentWorkout = null;
    let timerInterval = null;
    let secondsElapsed = 0;
    let isTimerRunning = false;
    
    // DOM Elements
    const viewSelection = document.getElementById('view-selection');
    const viewWorkout = document.getElementById('view-workout');
    const btnBack = document.getElementById('btn-back');
    const workoutListEl = document.getElementById('workout-list');
    const methodologyContentEl = document.getElementById('methodology-content');
    
    // Workout View Elements
    const wTitle = document.getElementById('workout-title');
    const wFocus = document.getElementById('workout-focus');
    const wTips = document.getElementById('workout-tips');
    const exerciseListEl = document.getElementById('exercise-list');
    
    // Timer & Progress Elements
    const timerDisplay = document.getElementById('timer');
    const btnTimer = document.getElementById('btn-timer');
    const workoutTimes = document.getElementById('workout-times');
    const timeStartEl = document.getElementById('time-start');
    const timeEndEl = document.getElementById('time-end');
    const btnFinish = document.getElementById('btn-finish');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const filenameSelect = document.getElementById('filename-select');
    const btnLoadServer = document.getElementById('btn-load-server');
    const errorMessage = document.getElementById('error-message');

    // Initialization
    async function init() {
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
            
            // Auto carrega o primeiro da lista
            if(treinos.length > 0) {
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
    }

    async function loadFromServer(filename) {
        try {
            if(errorMessage) errorMessage.style.display = 'none';
            const response = await fetch(filename);
            if (!response.ok) throw new Error("Status " + response.status);
            workoutData = await response.json();
            renderSelectionView();
            checkActiveSession();
        } catch (error) {
            console.error("Erro ao carregar o JSON:", error);
            if(errorMessage) {
                errorMessage.textContent = `Erro ao carregar '${filename}'. Verifique se o nome está correto e se o servidor local está rodando (erro: ${error.message}).`;
                errorMessage.style.display = 'block';
            }
        }
    }

    // Render Selection Screen
    function renderSelectionView() {
        // Render Workouts
        workoutListEl.innerHTML = '';
        workoutData.treinos.forEach(treino => {
            const card = document.createElement('div');
            card.className = 'workout-card';
            card.innerHTML = `
                <div class="workout-card-header">
                    <h3>${treino.nome}</h3>
                    <span class="workout-duration"><i class="ph ph-clock"></i> ${treino.duracao}</span>
                </div>
                <p>${treino.foco}</p>
            `;
            card.addEventListener('click', () => loadWorkout(treino.id));
            workoutListEl.appendChild(card);
        });

        // Render Methodology
        methodologyContentEl.innerHTML = `
            <div class="methodology-item">
                <h4>Rotação</h4>
                <p>${workoutData.metodologia.rotacao}</p>
            </div>
            <div class="methodology-item">
                <h4>Progressão</h4>
                <p>${workoutData.metodologia.progressao_dupla}</p>
            </div>
            <div class="methodology-item">
                <h4>Intensidade</h4>
                <p><strong>Compostos:</strong> ${workoutData.metodologia.intensidade.compostos}<br>
                <strong>Isoladores:</strong> ${workoutData.metodologia.intensidade.isoladores}</p>
            </div>
            <div class="methodology-item">
                <h4>Descanso</h4>
                <p>${workoutData.metodologia.descanso}</p>
            </div>
        `;
    }

    // Load Specific Workout
    function loadWorkout(id) {
        currentWorkout = workoutData.treinos.find(t => t.id === id);
        if (!currentWorkout) return;

        // Setup Header
        wTitle.textContent = currentWorkout.nome;
        wFocus.textContent = currentWorkout.foco;

        // Setup Tips
        wTips.innerHTML = currentWorkout.observacoes.map(obs => `
            <div class="tip-card">${obs}</div>
        `).join('');

        // Setup Exercises
        exerciseListEl.innerHTML = '';
        currentWorkout.exercicios.forEach((ex, index) => {
            // Parse max sets and rest range
            let maxSets = 1;
            const setMatch = ex.series_reps.match(/^(\d+)/);
            if (setMatch) maxSets = parseInt(setMatch[1]);

            // Extract min and max rest in seconds
            let minRestSeconds = 45;
            let maxRestSeconds = 90;
            const restStr = ex.descanso.toLowerCase();
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
            item.innerHTML = `
                <div class="set-counter-container">
                    <button class="btn-counter btn-minus">-</button>
                    <span class="set-counter-text"><span class="current-set">0</span> / ${maxSets}</span>
                    <button class="btn-counter btn-plus">+</button>
                </div>
                <div class="exercise-details">
                    <div class="exercise-name">${ex.nome}</div>
                    <div class="exercise-meta">
                        <span class="badge badge-reps clickable" data-type="reps"><i class="ph ph-barbell"></i> ${ex.series_reps}</span>
                        <span class="badge badge-rest clickable" data-type="rest"><i class="ph ph-timer"></i> ${ex.descanso}</span>
                        <span class="badge badge-rir clickable" data-type="rir">RIR ${ex.rir}</span>
                    </div>
                </div>
            `;
            
            // Set Counter Logic
            let currentSets = 0;
            const currentSetSpan = item.querySelector('.current-set');
            const btnMinus = item.querySelector('.btn-minus');
            const btnPlus = item.querySelector('.btn-plus');

            function updateItemStatus() {
                currentSetSpan.textContent = currentSets;
                if (currentSets >= maxSets) {
                    item.classList.add('done');
                } else {
                    item.classList.remove('done');
                }
                updateProgress();
                saveSession();
            }

            btnMinus.addEventListener('click', (e) => {
                e.stopPropagation();
                if (currentSets > 0) {
                    currentSets--;
                    updateItemStatus();
                }
            });

            btnPlus.addEventListener('click', (e) => {
                e.stopPropagation();
                if(!isTimerRunning && secondsElapsed === 0) toggleTimer();
                
                if (currentSets < maxSets) {
                    currentSets++;
                    updateItemStatus();
                    if (currentSets < maxSets) {
                        openRestModal(minRestSeconds, maxRestSeconds);
                    }
                }
            });

            // Modal events for badges
            const badges = item.querySelectorAll('.badge.clickable');
            badges.forEach(badge => {
                badge.addEventListener('click', (e) => {
                    e.stopPropagation(); // Previne de marcar o checkbox ao clicar na badge
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
        });

        resetTimerUI();
        updateProgress();
        
        // Switch View
        viewSelection.classList.remove('view-active');
        setTimeout(() => {
            viewSelection.classList.add('hidden');
            viewWorkout.classList.remove('hidden');
            viewWorkout.classList.add('view-active');
            btnBack.classList.remove('hidden');
        }, 300); // Wait fade out (approx)
    }

    // Back to selection
    btnBack.addEventListener('click', () => {
        if(isTimerRunning || secondsElapsed > 0) {
            const confirmLeave = confirm("Você tem um treino em andamento. Deseja realmente sair? O progresso será salvo.");
            if(!confirmLeave) return;
        }

        viewWorkout.classList.remove('view-active');
        setTimeout(() => {
            viewWorkout.classList.add('hidden');
            viewSelection.classList.remove('hidden');
            viewSelection.classList.add('view-active');
            btnBack.classList.add('hidden');
        }, 10);
    });

    // Timer Logic
    btnTimer.addEventListener('click', toggleTimer);

    function toggleTimer() {
        if (isTimerRunning) {
            // Pause
            clearInterval(timerInterval);
            isTimerRunning = false;
            btnTimer.innerHTML = '<i class="ph-fill ph-play-circle"></i> Retomar Treino';
            btnTimer.className = 'btn-primary';
            timerDisplay.classList.remove('active');
        } else {
            // Start
            if (secondsElapsed === 0) {
                const now = new Date();
                timeStartEl.textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                workoutTimes.classList.remove('hidden');
                btnFinish.classList.remove('hidden');
            }
            
            isTimerRunning = true;
            btnTimer.innerHTML = '<i class="ph-fill ph-pause-circle"></i> Pausar Treino';
            btnTimer.className = 'btn-danger';
            timerDisplay.classList.add('active');
            
            timerInterval = setInterval(() => {
                secondsElapsed++;
                updateTimerDisplay();
                saveSession();
            }, 1000);
        }
    }

    function updateTimerDisplay() {
        const hrs = Math.floor(secondsElapsed / 3600);
        const mins = Math.floor((secondsElapsed % 3600) / 60);
        const secs = secondsElapsed % 60;
        timerDisplay.textContent = 
            (hrs > 0 ? String(hrs).padStart(2, '0') + ':' : '') +
            String(mins).padStart(2, '0') + ':' +
            String(secs).padStart(2, '0');
    }

    function resetTimerUI() {
        clearInterval(timerInterval);
        secondsElapsed = 0;
        isTimerRunning = false;
        timerDisplay.textContent = '00:00';
        timerDisplay.classList.remove('active');
        btnTimer.innerHTML = '<i class="ph-fill ph-play-circle"></i> Iniciar Treino';
        btnTimer.className = 'btn-primary';
        workoutTimes.classList.add('hidden');
        timeStartEl.textContent = '--:--';
        timeEndEl.textContent = '--:--';
        btnFinish.classList.add('hidden');
    }

    // Finish Workout
    btnFinish.addEventListener('click', () => {
        if(isTimerRunning) toggleTimer();
        
        const now = new Date();
        timeEndEl.textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        btnFinish.innerHTML = '<i class="ph-fill ph-check-circle"></i> Treino Concluído!';
        btnFinish.disabled = true;
        btnTimer.style.display = 'none';
        
        // Clear session from storage
        localStorage.removeItem('academiaProSession');
        
        // Reset after some time or keep it
        setTimeout(() => {
            alert("Parabéns! Treino finalizado e registrado.");
            // In a real app, you'd save this to a database here.
            btnBack.click();
            btnTimer.style.display = 'flex';
            btnFinish.disabled = false;
        }, 1500);
    });

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

    // Local Storage (Session Recovery)
    function saveSession() {
        if (!currentWorkout) return;
        
        const doneIndexes = Array.from(document.querySelectorAll('.exercise-item.done'))
                                .map(item => parseInt(item.dataset.index));
                                
        const session = {
            workoutId: currentWorkout.id,
            secondsElapsed: secondsElapsed,
            startTime: timeStartEl.textContent,
            doneIndexes: doneIndexes,
            timestamp: new Date().getTime()
        };
        
        localStorage.setItem('academiaProSession', JSON.stringify(session));
    }

    function checkActiveSession() {
        const saved = localStorage.getItem('academiaProSession');
        if (saved) {
            try {
                const session = JSON.parse(saved);
                // Only recover if less than 6 hours old
                const now = new Date().getTime();
                if (now - session.timestamp < 6 * 60 * 60 * 1000) {
                    if(confirm("Encontramos um treino em andamento. Deseja continuar de onde parou?")) {
                        loadWorkout(session.workoutId);
                        
                        // Restore state
                        secondsElapsed = session.secondsElapsed;
                        updateTimerDisplay();
                        
                        timeStartEl.textContent = session.startTime;
                        workoutTimes.classList.remove('hidden');
                        btnFinish.classList.remove('hidden');
                        
                        const items = document.querySelectorAll('.exercise-item');
                        session.doneIndexes.forEach(idx => {
                            if(items[idx]) items[idx].classList.add('done');
                        });
                        updateProgress();
                    } else {
                        localStorage.removeItem('academiaProSession');
                    }
                } else {
                     localStorage.removeItem('academiaProSession');
                }
            } catch(e) {
                console.error("Erro ao restaurar sessão", e);
            }
        }
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
    const swipeUnlock = document.getElementById('swipe-unlock');
    let restInterval = null;
    let restSeconds = 0;

    function formatRestTarget(seconds) {
        if (seconds >= 60) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return s > 0 ? `${m}min ${s}s` : `${m}min`;
        }
        return `${seconds}s`;
    }

    function openRestModal(minSeconds, maxSeconds) {
        if(!restModal) return;
        restModal.classList.remove('hidden');
        if(swipeUnlock) swipeUnlock.value = 0;
        const rangeText = minSeconds === maxSeconds
            ? formatRestTarget(minSeconds)
            : `${formatRestTarget(minSeconds)} – ${formatRestTarget(maxSeconds)}`;
        if(restTargetText) restTargetText.textContent = `Alvo: ${rangeText}`;
        restSeconds = 0;
        updateRestDisplay(minSeconds, maxSeconds);
        
        clearInterval(restInterval);
        restInterval = setInterval(() => {
            restSeconds++;
            updateRestDisplay(minSeconds, maxSeconds);
        }, 1000);
    }

    function closeRestModal() {
        if(!restModal) return;
        restModal.classList.add('hidden');
        clearInterval(restInterval);
    }

    function updateRestDisplay(minTarget, maxTarget) {
        if(!restTimerText) return;
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
        } else {
            restTimerText.className = 'rest-time-status-over';
            restStatusText.textContent = 'Passou do tempo! Próxima série!';
        }
    }

    // Swipe to dismiss
    if (swipeUnlock) {
        // on input triggers while dragging
        swipeUnlock.addEventListener('input', (e) => {
            if (e.target.value >= 95) {
                closeRestModal();
                setTimeout(() => { e.target.value = 0; }, 300);
            }
        });
        // on change triggers when mouse is released
        swipeUnlock.addEventListener('change', (e) => {
            if (e.target.value < 95) {
                e.target.value = 0; // snap back
            }
        });
    }

    // Start App
    init();
});
