// ui/script.js
// Client-side JavaScript for the Chatterbox TTS Server web interface.
// Handles UI interactions, API communication, audio playback, and settings management.

document.addEventListener('DOMContentLoaded', async function () {
    // --- Global Flags & State ---
    let uiReady = false;
    let listenersAttached = false;
    let isGenerating = false;
    let wavesurfer = null;
    let currentAudioBlobUrl = null;
    let saveStateTimeout = null;

    let currentConfig = {};
    let currentUiState = {};
    let appPresets = [];
    let initialReferenceFiles = [];
    let initialPredefinedVoices = [];

    let hideChunkWarning = false;
    let hideGenerationWarning = false;
    let currentVoiceMode = 'predefined';
    let isUserInteraction = false; // <-- declare to avoid ReferenceError

    const IS_LOCAL_FILE = window.location.protocol === 'file:';
    // If you always access the server via localhost
    const API_BASE_URL = IS_LOCAL_FILE ? 'http://localhost:8004' : '';

    const DEBOUNCE_DELAY_MS = 750;


    // --- DOM Element Selectors ---
    const appTitleLink = document.getElementById('app-title-link');
    const themeToggleButton = document.getElementById('theme-toggle-btn');
    const themeSwitchThumb = themeToggleButton ? themeToggleButton.querySelector('.theme-switch-thumb') : null;
    const notificationArea = document.getElementById('notification-area');
    const ttsForm = document.getElementById('tts-form');
    const ttsFormHeader = document.getElementById('tts-form-header');
    const textArea = document.getElementById('text');
    const charCount = document.getElementById('char-count');
    const generateBtn = document.getElementById('generate-btn');
    const splitTextToggle = document.getElementById('split-text-toggle');
    const chunkSizeControls = document.getElementById('chunk-size-controls');
    const chunkSizeSlider = document.getElementById('chunk-size-slider');
    const chunkSizeValue = document.getElementById('chunk-size-value');
    const chunkExplanation = document.getElementById('chunk-explanation');
    const voiceModeRadios = document.querySelectorAll('input[name="voice_mode"]');
    const predefinedVoiceOptionsDiv = document.getElementById('predefined-voice-options');
    const predefinedVoiceSelect = document.getElementById('predefined-voice-select');
    const predefinedVoiceImportButton = document.getElementById('predefined-voice-import-button');
    const predefinedVoiceRefreshButton = document.getElementById('predefined-voice-refresh-button');
    const predefinedVoiceFileInput = document.getElementById('predefined-voice-file-input');
    const cloneOptionsDiv = document.getElementById('clone-options');
    const cloneReferenceSelect = document.getElementById('clone-reference-select');
    const cloneImportButton = document.getElementById('clone-import-button');
    const cloneRefreshButton = document.getElementById('clone-refresh-button');
    const cloneFileInput = document.getElementById('clone-file-input');
    const presetsContainer = document.getElementById('presets-container');
    const presetsPlaceholder = document.getElementById('presets-placeholder');
    const temperatureSlider = document.getElementById('temperature');
    const temperatureValueDisplay = document.getElementById('temperature-value');
    const exaggerationSlider = document.getElementById('exaggeration');
    const exaggerationValueDisplay = document.getElementById('exaggeration-value');
    const cfgWeightSlider = document.getElementById('cfg-weight');
    const cfgWeightValueDisplay = document.getElementById('cfg-weight-value');
    const speedFactorSlider = document.getElementById('speed-factor');
    const speedFactorValueDisplay = document.getElementById('speed-factor-value');
    const speedFactorWarningSpan = document.getElementById('speed-factor-warning');
    const seedInput = document.getElementById('seed');
    const languageSelectContainer = document.getElementById('language-select-container');
    const languageSelect = document.getElementById('language');
    const outputFormatSelect = document.getElementById('output-format');
    const saveGenDefaultsBtn = document.getElementById('save-gen-defaults-btn');
    const genDefaultsStatus = document.getElementById('gen-defaults-status');
    const serverConfigForm = document.getElementById('server-config-form');
    const saveConfigBtn = document.getElementById('save-config-btn');
    const restartServerBtn = document.getElementById('restart-server-btn');
    const configStatus = document.getElementById('config-status');
    const resetSettingsBtn = document.getElementById('reset-settings-btn');
    const bookRemoveNotesCheckbox = document.getElementById('book-remove-notes');
    const bookSectionSizeInput = document.getElementById('book-section-size');
    const audioPlayerContainer = document.getElementById('audio-player-container');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingMessage = document.getElementById('loading-message');
    const loadingStatusText = document.getElementById('loading-status');
    const loadingCancelBtn = document.getElementById('loading-cancel-btn');
    const chunkWarningModal = document.getElementById('chunk-warning-modal');
    const chunkWarningOkBtn = document.getElementById('chunk-warning-ok');
    const chunkWarningCancelBtn = document.getElementById('chunk-warning-cancel');
    const hideChunkWarningCheckbox = document.getElementById('hide-chunk-warning-checkbox');
    const generationWarningModal = document.getElementById('generation-warning-modal');
    const generationWarningAcknowledgeBtn = document.getElementById('generation-warning-acknowledge');
    const hideGenerationWarningCheckbox = document.getElementById('hide-generation-warning-checkbox');
    const clearAllBtn = document.getElementById('clear-all-btn');




// ...existing code...

    // --- New DOM selectors for multi-run batch UI ---
    const multiRunToggle = document.getElementById('multi-run-toggle');
    const addTextBtn = document.getElementById('add-text-btn');
    const multiTextsContainer = document.getElementById('multi-texts-container');
    const singleTextWrapper = document.getElementById('single-text-wrapper');
    const manualMultiRunInputs = document.getElementById('manual-multi-run-inputs');
    const manualMultiRunInputCount = document.getElementById('manual-multi-run-input-count');

    // --- Multi-run helpers ---
    function createMultiTextBox(initialText = '') {
        const wrapper = document.createElement('div');
        wrapper.className = 'multi-text-box card-base p-3 relative';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-text-btn btn-secondary absolute right-3 top-3';
        removeBtn.textContent = 'Remove';
        removeBtn.onclick = () => {
            wrapper.remove();
            updateMultiRunInputSummary();
        };

        const ta = document.createElement('textarea');
        ta.className = 'multi-text-item textarea-base';
        ta.rows = 5;
        ta.value = initialText || '';

        wrapper.appendChild(removeBtn);
        wrapper.appendChild(ta);
        return wrapper;
    }

    function resetMultiTextBoxes() {
        if (!multiTextsContainer) return;
        multiTextsContainer.innerHTML = '';
        const count = Math.max(1, parseInt(currentUiState.initial_textbox_count || 11, 10));
        for (let i = 0; i < count; i++) multiTextsContainer.appendChild(createMultiTextBox(''));
        updateMultiRunInputSummary();
    }

    function updateMultiRunInputSummary() {
        if (!manualMultiRunInputCount || !multiTextsContainer) return;
        const count = multiTextsContainer.querySelectorAll('.multi-text-item').length;
        manualMultiRunInputCount.textContent = `Expand to edit the ${count} input ${count === 1 ? 'box' : 'boxes'}`;
    }

    function ensureAtLeastOneMultiBox() {
        if (multiTextsContainer && multiTextsContainer.querySelectorAll('.multi-text-item').length === 0) resetMultiTextBoxes();
    }

    function toggleMultiRunUI(enabled) {
        if (enabled) {
            if (singleTextWrapper) singleTextWrapper.classList.add('hidden');
            if (manualMultiRunInputs) manualMultiRunInputs.classList.remove('hidden');
            if (multiTextsContainer) ensureAtLeastOneMultiBox();
            if (audioPlayerContainer) audioPlayerContainer.classList.add('hidden'); // hide playback
        } else {
            if (singleTextWrapper) singleTextWrapper.classList.remove('hidden');
            if (manualMultiRunInputs) manualMultiRunInputs.classList.add('hidden');
            if (audioPlayerContainer) audioPlayerContainer.classList.remove('hidden');
        }
    }

    if (multiRunToggle) {
        multiRunToggle.addEventListener('change', () => {
            toggleMultiRunUI(!!multiRunToggle.checked);
            debouncedSaveState();
        });
    }

    if (addTextBtn) {
        addTextBtn.addEventListener('click', () => {
            if (!multiTextsContainer) return;
            const box = createMultiTextBox('');
            multiTextsContainer.appendChild(box);
            updateMultiRunInputSummary();
            if (manualMultiRunInputs) manualMultiRunInputs.open = true;
            box.querySelector('.multi-text-item').focus();
        });
    }

    // Modify existing getTTSFormData to support single-item build but keep it unchanged for single-run
    function buildRequestForSingleControls(textValue) {
        const jsonData = {
            text: textValue,
            temperature: parseFloat(temperatureSlider.value),
            exaggeration: parseFloat(exaggerationSlider.value),
            cfg_weight: parseFloat(cfgWeightSlider.value),
            speed_factor: parseFloat(speedFactorSlider.value),
            seed: parseInt(seedInput.value, 10),
            language: languageSelect.value,
            voice_mode: currentVoiceMode,
            split_text: splitTextToggle.checked,
            chunk_size: parseInt(chunkSizeSlider.value, 10),
            output_format: outputFormatSelect.value || 'mp3'
        };
        if (currentVoiceMode === 'predefined' && predefinedVoiceSelect.value !== 'none') {
            jsonData.predefined_voice_id = predefinedVoiceSelect.value;
        } else if (currentVoiceMode === 'clone' && cloneReferenceSelect.value !== 'none') {
            jsonData.reference_audio_filename = cloneReferenceSelect.value;
        }
        return jsonData;
    }

    // Safe accessor for current single textarea content (trimmed). Returns empty string when textarea missing.
    function getCurrentTextContent() {
        return (textArea && typeof textArea.value === 'string') ? textArea.value.trim() : '';
    }

    // New: build batch array from multi textboxes
    function buildMultiRequestsArray() {
        const items = [];
        if (!multiTextsContainer) return items;
        const textareas = multiTextsContainer.querySelectorAll('.multi-text-item');
        textareas.forEach(ta => {
            const textVal = ta.value.trim();
            if (!textVal) return; // skip empty boxes
            items.push(buildRequestForSingleControls(textVal));
        });
        return items;
    }

    // New: submit multiple requests sequentially using /tts/multi
    async function submitMultiTTSRequests() {
        isGenerating = true;
        showLoadingOverlay();
        const requestsArray = buildMultiRequestsArray();
        if (requestsArray.length === 0) {
            showNotification("No text boxes with content found for multi-run.", "error");
            isGenerating = false;
            hideLoadingOverlay();
            return;
        }
        try {
            const response = await fetch(`${API_BASE_URL}/tts/multi`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestsArray)
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
                throw new Error(err.detail || 'Batch TTS request failed.');
            }
            const jsonResp = await response.json();
            const items = jsonResp.items || [];
            // Show simple result list
            const listEl = document.createElement('div');
            listEl.className = 'card-base p-4 mt-4';
            let anySuccess = false;
            items.forEach((it, idx) => {
                const row = document.createElement('div');
                row.className = 'text-sm mb-2';
                if (it.success) {
                    anySuccess = true;
                    const url = it.download_url ? `${API_BASE_URL}${it.download_url}` : null;
                    row.innerHTML = `Item ${idx+1}: Saved as <strong>${it.filename}</strong> ${url ? `(<a href="${url}" target="_blank">download</a>)` : ''} — ${it.size} bytes.`;
                } else {
                    row.innerHTML = `Item ${idx+1}: Error: <span class="text-red-600">${it.error || 'unknown'}</span>`;
                }
                listEl.appendChild(row);
            });
            // Insert below the form (replace any previous multi-result area)
            const existing = document.getElementById('multi-run-result-area');
            if (existing) existing.remove();
            listEl.id = 'multi-run-result-area';
            try {
                // Prefer inserting right after the form so we don't rely on other containers' parent relationships
                if (ttsForm && typeof ttsForm.insertAdjacentElement === 'function') {
                    ttsForm.insertAdjacentElement('afterend', listEl);
                } else if (ttsForm && ttsForm.parentNode) {
                    // If audioPlayerContainer happens to be in the same parent, insert before it; otherwise append
                    if (audioPlayerContainer && audioPlayerContainer.parentNode === ttsForm.parentNode) {
                        ttsForm.parentNode.insertBefore(listEl, audioPlayerContainer);
                    } else {
                        ttsForm.parentNode.appendChild(listEl);
                    }
                } else {
                    // Last resort: append to body to ensure it becomes visible
                    document.body.appendChild(listEl);
                }
            } catch (e) {
                console.error('Failed to insert multi-run result element, appending to body as fallback:', e);
                document.body.appendChild(listEl);
            }
            showNotification(anySuccess ? 'Batch processing complete.' : 'Batch finished with errors.', anySuccess ? 'success' : 'warning', 8000);
        } catch (error) {
            console.error('Batch TTS error:', error);
            showNotification(error.message || 'Batch TTS failed.', 'error', 0);
        } finally {
            isGenerating = false;
            hideLoadingOverlay();
        }
    }

    // Modify proceedWithSubmissionChecks to branch for multi-run
    function proceedWithSubmissionChecks() {
        const isMulti = multiRunToggle && multiRunToggle.checked;
        if (isMulti) {
            // basic validation: at least one non-empty box
            const items = buildMultiRequestsArray();
            if (items.length === 0) { showNotification("Add at least one text box with content for multi-run.", "error"); return; }
            // Don't load audio player; call multi endpoint
            submitMultiTTSRequests();
            return;
        }
        // existing single-run flow
        const textContent = getCurrentTextContent();
        const isSplittingEnabled = splitTextToggle.checked;
        const currentChunkSz = parseInt(chunkSizeSlider.value, 10);
        const needsChunkWarn = isSplittingEnabled && textContent.length >= currentChunkSz * 1.5 &&
            currentVoiceMode !== 'predefined' && currentVoiceMode !== 'clone' &&
            (!seedInput || parseInt(seedInput.value, 10) === 0 || seedInput.value === '') && !hideChunkWarning;
        if (needsChunkWarn) { showChunkWarningModal(); return; }
        submitTTSRequest();
    }

    // On initial load ensure multi-run UI reflects saved state
    // Called during initializeApplication -> loadInitialUiState -> attachStateSavingListeners
    function initMultiUiFromState() {
        const multiEnabled = currentUiState.multi_run_enabled !== false;
        if (multiRunToggle) multiRunToggle.checked = !!multiEnabled;
        resetMultiTextBoxes();
        toggleMultiRunUI(!!multiEnabled);
    }

    // Call initMultiUiFromState after loadInitialUiState()
    // Insert call into initializeApplication() after loadInitialUiState() or call here if already initialized:

// ...existing code...




    // Handle voice mode selection visual feedback
    const voiceModeOptions = document.querySelectorAll('.voice-mode-option');

    voiceModeRadios.forEach(radio => {
        radio.addEventListener('change', function () {
            // Remove selected class from all options
            voiceModeOptions.forEach(option => {
                option.classList.remove('selected');
            });

            // Add selected class to the parent of the checked radio
            const selectedOption = this.closest('.voice-mode-option');
            if (selectedOption) {
                selectedOption.classList.add('selected');
            }
        });
    });

    // Set initial state
    const checkedRadio = document.querySelector('input[name="voice_mode"]:checked');
    if (checkedRadio) {
        const selectedOption = checkedRadio.closest('.voice-mode-option');
        if (selectedOption) {
            selectedOption.classList.add('selected');
        }
    }

    // --- Utility Functions ---
    function showNotification(message, type = 'info', duration = 5000) {
        if (!notificationArea) return null;
        const icons = {
            success: '<svg class="notification-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg>',
            error: '<svg class="notification-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" /></svg>',
            warning: '<svg class="notification-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>',
            info: '<svg class="notification-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd" /></svg>'
        };
        const typeClassMap = { success: 'notification-success', error: 'notification-error', warning: 'notification-warning', info: 'notification-info' };
        const notificationDiv = document.createElement('div');
        notificationDiv.className = `notification-base ${typeClassMap[type] || 'notification-info'}`;
        notificationDiv.setAttribute('role', 'alert');
        // Create content wrapper
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'flex items-start flex-grow';
        contentWrapper.innerHTML = `${icons[type] || icons['info']} <span class="block sm:inline">${message}</span>`;

        // Create close button
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'ml-auto -mx-1.5 -my-1.5 bg-transparent rounded-lg p-1.5 inline-flex h-8 w-8 items-center justify-center text-current hover:bg-slate-200 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400 flex-shrink-0';
        closeButton.innerHTML = '<span class="sr-only">Close</span><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"></path></svg>';
        closeButton.onclick = () => {
            notificationDiv.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            notificationDiv.style.opacity = '0';
            notificationDiv.style.transform = 'translateY(-20px)';
            setTimeout(() => notificationDiv.remove(), 300);
        };

        // Add both to notification
        notificationDiv.appendChild(contentWrapper);
        notificationDiv.appendChild(closeButton);
        notificationArea.appendChild(notificationDiv);
        if (duration > 0) setTimeout(() => closeButton.click(), duration);
        return notificationDiv;
    }

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${minutes}:${secs}`;
    }

    // --- Theme Management ---
    function applyTheme(theme) {
        const isDark = theme === 'dark';
        document.documentElement.classList.toggle('dark', isDark);
        if (themeSwitchThumb) {
            themeSwitchThumb.classList.toggle('translate-x-6', isDark);
            themeSwitchThumb.classList.toggle('bg-indigo-500', isDark);
            themeSwitchThumb.classList.toggle('bg-white', !isDark);
        }
        if (wavesurfer) {
            wavesurfer.setOptions({
                waveColor: isDark ? '#6366f1' : '#a5b4fc',
                progressColor: isDark ? '#4f46e5' : '#6366f1',
                cursorColor: isDark ? '#cbd5e1' : '#475569',
            });
        }
        localStorage.setItem('uiTheme', theme);
    }

    if (themeToggleButton) {
        themeToggleButton.addEventListener('click', () => {
            const newTheme = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
            applyTheme(newTheme);
            debouncedSaveState();
        });
    }

    // --- UI State Persistence ---
    async function saveCurrentUiState() {
        const stateToSave = {
            multi_run_enabled: multiRunToggle ? multiRunToggle.checked : true,
            initial_textbox_count: parseInt(currentUiState.initial_textbox_count || 11, 10),
            chapters_per_section: parseInt(bookSectionSizeInput?.value || 50, 10),
            keep_notes: !bookRemoveNotesCheckbox?.checked,
            last_voice_mode: currentVoiceMode,
            last_predefined_voice: predefinedVoiceSelect ? predefinedVoiceSelect.value : null,
            last_reference_file: cloneReferenceSelect ? cloneReferenceSelect.value : null,
            last_seed: seedInput ? parseInt(seedInput.value, 10) || 0 : 0,
            last_chunk_size: chunkSizeSlider ? parseInt(chunkSizeSlider.value, 10) : 120,
            last_split_text_enabled: splitTextToggle ? splitTextToggle.checked : true,
            hide_chunk_warning: hideChunkWarning,
            hide_generation_warning: hideGenerationWarning,
            theme: localStorage.getItem('uiTheme') || 'dark'
        };
        try {
            const response = await fetch(`${API_BASE_URL}/save_settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ui_state: stateToSave })
            });
            if (!response.ok) {
                const errorResult = await response.json();
                throw new Error(errorResult.detail || `Failed to save UI state (status ${response.status})`);
            }
        } catch (error) {
            console.error("Error saving UI state via API:", error);
            showNotification(`Error saving settings: ${error.message}. Some changes may not persist.`, 'error', 0);
        }
    }

    function debouncedSaveState() {
        // Do not save anything until the entire UI has finished its initial setup.
        // MODIFICATION: Add a check for listenersAttached.
        if (!uiReady || !listenersAttached) { return; }
        clearTimeout(saveStateTimeout);
        saveStateTimeout = setTimeout(saveCurrentUiState, DEBOUNCE_DELAY_MS);
    }

    // --- Speed Factor Warning ---
    function updateSpeedFactorWarning() {
        if (speedFactorSlider && speedFactorWarningSpan) {
            const value = parseFloat(speedFactorSlider.value);
            if (value !== 1.0) {
                speedFactorWarningSpan.textContent = "* Experimental, may cause echo.";
                speedFactorWarningSpan.classList.remove('hidden');
            } else {
                speedFactorWarningSpan.classList.add('hidden');
            }
        }
    }


    // --- Initial Application Setup ---
    function initializeApplication() {
        const preferredTheme = localStorage.getItem('uiTheme') || currentUiState.theme || 'dark';
        applyTheme(preferredTheme);
        const pageTitle = currentConfig?.ui?.title || "Chatterbox TTS Server";
        document.title = pageTitle;
        if (appTitleLink) appTitleLink.textContent = pageTitle;
        if (ttsFormHeader) ttsFormHeader.textContent = `Generate Speech`;
        loadInitialUiState();
        initMultiUiFromState();
        if (bookSectionSizeInput) bookSectionSizeInput.value = currentUiState.chapters_per_section || 50;
        populatePredefinedVoices();
        populateReferenceFiles();
        populatePresets();
        displayServerConfiguration();
        if (languageSelectContainer && currentConfig?.ui?.show_language_select === false) {
            languageSelectContainer.classList.add('hidden');
        }
        updateSpeedFactorWarning(); // Initial check for speed factor warning
        // attachStateSavingListeners();
        const initialGenResult = currentConfig.initial_gen_result;
        if (initialGenResult && initialGenResult.outputUrl) {
            initializeWaveSurfer(initialGenResult.outputUrl, initialGenResult);
        }
    }

    async function fetchInitialData() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/ui/initial-data`);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to fetch initial UI data: ${response.status} ${response.statusText}. Server response: ${errorText}`);
            }
            const data = await response.json();
            currentConfig = data.config || {};
            currentUiState = currentConfig.ui_state || {};
            appPresets = data.presets || [];
            initialReferenceFiles = data.reference_files || [];
            initialPredefinedVoices = data.predefined_voices || [];
            hideChunkWarning = currentUiState.hide_chunk_warning || false;
            hideGenerationWarning = currentUiState.hide_generation_warning || false;
            currentVoiceMode = currentUiState.last_voice_mode || 'predefined';

            // This now ONLY sets values. It does NOT attach state-saving listeners.
            initializeApplication();

        } catch (error) {
            console.error("Error fetching initial data:", error);
            showNotification(`Could not load essential application data: ${error.message}. Please try refreshing.`, 'error', 0);
            if (Object.keys(currentConfig).length === 0) {
                currentConfig = { ui: { title: "Chatterbox TTS Server (Error Mode)" }, generation_defaults: {}, ui_state: {} };
                currentUiState = currentConfig.ui_state;
            }
            initializeApplication(); // Attempt to init in a degraded state
        } finally {
            // --- PHASE 2: Attach listeners and enable UI readiness ---
            // This pushes the listener attachment to the end of the event queue,
            // ensuring all initialization events have fired harmlessly before we start listening.
            setTimeout(() => {
                attachStateSavingListeners();
                listenersAttached = true;
                uiReady = true;
            }, 50); // A 50ms delay is more robust than 0ms for complex UIs.
        }
    }

    function loadInitialUiState() {
        // Browsers may restore form values independently of application state.
        // Text is intentionally never restored between page loads.
        if (textArea) {
            textArea.value = '';
            if (charCount) charCount.textContent = '0';
        }
        const modeRadioToSelect = document.querySelector(`input[name="voice_mode"][value="${currentVoiceMode}"]`);
        if (modeRadioToSelect) modeRadioToSelect.checked = true;
        else {
            document.querySelector('input[name="voice_mode"][value="predefined"]').checked = true;
            currentVoiceMode = 'predefined';
        }
        toggleVoiceOptionsDisplay();
        if (seedInput && currentUiState.last_seed !== undefined) seedInput.value = currentUiState.last_seed;
        else if (seedInput && currentConfig?.generation_defaults?.seed !== undefined) seedInput.value = currentConfig.generation_defaults.seed;
        if (splitTextToggle) splitTextToggle.checked = currentUiState.last_split_text_enabled !== undefined ? currentUiState.last_split_text_enabled : true;
        if (chunkSizeSlider && currentUiState.last_chunk_size !== undefined) chunkSizeSlider.value = currentUiState.last_chunk_size;
        if (chunkSizeValue) chunkSizeValue.textContent = chunkSizeSlider ? chunkSizeSlider.value : '120';
        toggleChunkControlsVisibility();
        const genDefaults = currentConfig.generation_defaults || {};
        if (temperatureSlider) temperatureSlider.value = genDefaults.temperature !== undefined ? genDefaults.temperature : 0.8;
        if (temperatureValueDisplay) temperatureValueDisplay.textContent = temperatureSlider.value;
        if (exaggerationSlider) exaggerationSlider.value = genDefaults.exaggeration !== undefined ? genDefaults.exaggeration : 0.5;
        if (exaggerationValueDisplay) exaggerationValueDisplay.textContent = exaggerationSlider.value;
        if (cfgWeightSlider) cfgWeightSlider.value = genDefaults.cfg_weight !== undefined ? genDefaults.cfg_weight : 0.5;
        if (cfgWeightValueDisplay) cfgWeightValueDisplay.textContent = cfgWeightSlider.value;
        if (speedFactorSlider) speedFactorSlider.value = genDefaults.speed_factor !== undefined ? genDefaults.speed_factor : 1.0;
        if (speedFactorValueDisplay) speedFactorValueDisplay.textContent = speedFactorSlider.value;
        if (languageSelect) languageSelect.value = genDefaults.language || 'en';
        if (outputFormatSelect) outputFormatSelect.value = currentConfig?.audio_output?.format || 'mp3';
        if (hideChunkWarningCheckbox) hideChunkWarningCheckbox.checked = hideChunkWarning;
        if (hideGenerationWarningCheckbox) hideGenerationWarningCheckbox.checked = hideGenerationWarning;
        // keep_notes defaults to true for configs created before this setting existed.
        if (bookRemoveNotesCheckbox) bookRemoveNotesCheckbox.checked = currentUiState.keep_notes === false;
    }

    function attachStateSavingListeners() {
        // Re-fetching settings after a configuration save must not register
        // duplicate listeners (and therefore duplicate persistence requests).
        if (listenersAttached) return;
        listenersAttached = true;
        voiceModeRadios.forEach(radio => {
            radio.addEventListener('change', debouncedSaveState);
        });

        if (textArea) textArea.addEventListener('input', () => { if (charCount) charCount.textContent = textArea.value.length; debouncedSaveState(); });
        if (predefinedVoiceSelect) predefinedVoiceSelect.addEventListener('change', debouncedSaveState);
        if (cloneReferenceSelect) cloneReferenceSelect.addEventListener('change', debouncedSaveState);
        if (seedInput) seedInput.addEventListener('change', debouncedSaveState);
        if (splitTextToggle) splitTextToggle.addEventListener('change', () => { toggleChunkControlsVisibility(); debouncedSaveState(); });
        if (chunkSizeSlider) {
            chunkSizeSlider.addEventListener('input', () => { if (chunkSizeValue) chunkSizeValue.textContent = chunkSizeSlider.value; });
            chunkSizeSlider.addEventListener('change', debouncedSaveState);
        }
        const genParamSliders = [temperatureSlider, exaggerationSlider, cfgWeightSlider, speedFactorSlider];
        genParamSliders.forEach(slider => {
            if (slider) {
                const valueDisplayId = slider.id + '-value';
                const valueDisplay = document.getElementById(valueDisplayId);
                slider.addEventListener('input', () => {
                    if (valueDisplay) valueDisplay.textContent = slider.value;
                    if (slider.id === 'speed-factor') updateSpeedFactorWarning(); // Update warning on input
                });
                slider.addEventListener('change', debouncedSaveState);
            }
        });
        if (languageSelect) languageSelect.addEventListener('change', debouncedSaveState);
        if (outputFormatSelect) outputFormatSelect.addEventListener('change', debouncedSaveState);
        if (bookRemoveNotesCheckbox) bookRemoveNotesCheckbox.addEventListener('change', debouncedSaveState);
        if (bookSectionSizeInput) bookSectionSizeInput.addEventListener('change', debouncedSaveState);
    }

    // --- Dynamic UI Population ---
    function populatePredefinedVoices(voicesData = initialPredefinedVoices) {
        if (!predefinedVoiceSelect) return;
        const currentSelectedValue = predefinedVoiceSelect.value;
        predefinedVoiceSelect.innerHTML = '<option value="none">-- Select Voice --</option>';
        voicesData.forEach(voice => {
            const option = document.createElement('option');
            option.value = voice.filename;
            option.textContent = voice.display_name || voice.filename;
            predefinedVoiceSelect.appendChild(option);
        });
        const lastSelected = currentUiState.last_predefined_voice;
        const defaultFromConfig = currentConfig?.tts_engine?.default_voice_id;
        if (currentSelectedValue !== 'none' && voicesData.some(v => v.filename === currentSelectedValue)) {
            predefinedVoiceSelect.value = currentSelectedValue;
        } else if (lastSelected && voicesData.some(v => v.filename === lastSelected)) {
            predefinedVoiceSelect.value = lastSelected;
        } else if (defaultFromConfig && voicesData.some(v => v.filename === defaultFromConfig)) {
            predefinedVoiceSelect.value = defaultFromConfig;
        } else {
            predefinedVoiceSelect.value = 'none';
        }
    }

    function populateReferenceFiles(filesData = initialReferenceFiles) {
        if (!cloneReferenceSelect) return;
        const currentSelectedValue = cloneReferenceSelect.value;
        cloneReferenceSelect.innerHTML = '<option value="none">-- Select Reference File --</option>';
        filesData.forEach(filename => {
            const option = document.createElement('option');
            option.value = filename;
            option.textContent = filename;
            cloneReferenceSelect.appendChild(option);
        });
        const lastSelected = currentUiState.last_reference_file;
        if (currentSelectedValue !== 'none' && filesData.includes(currentSelectedValue)) {
            cloneReferenceSelect.value = currentSelectedValue;
        } else if (lastSelected && filesData.includes(lastSelected)) {
            cloneReferenceSelect.value = lastSelected;
        } else {
            cloneReferenceSelect.value = 'none';
        }
    }

    function populatePresets() {
        if (!presetsContainer || !appPresets) return;
        if (appPresets.length === 0) {
            if (presetsPlaceholder) presetsPlaceholder.textContent = 'No presets available.';
            return;
        }
        if (presetsPlaceholder) presetsPlaceholder.remove();
        presetsContainer.innerHTML = '';
        appPresets.forEach((preset, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.id = `preset-btn-${index}`;
            button.className = 'preset-button';
            button.title = `Load '${preset.name}' text and settings`;
            button.textContent = preset.name;
            button.addEventListener('click', () => applyPreset(preset));
            presetsContainer.appendChild(button);
        });
    }

    function applyPreset(presetData, showNotif = true) {
        if (!presetData) return;
        if (textArea && presetData.text !== undefined) {
            textArea.value = presetData.text;
            if (charCount) charCount.textContent = textArea.value.length;
        }
        const genParams = presetData.params || presetData;
        if (temperatureSlider && genParams.temperature !== undefined) temperatureSlider.value = genParams.temperature;
        if (exaggerationSlider && genParams.exaggeration !== undefined) exaggerationSlider.value = genParams.exaggeration;
        if (cfgWeightSlider && genParams.cfg_weight !== undefined) cfgWeightSlider.value = genParams.cfg_weight;
        if (speedFactorSlider && genParams.speed_factor !== undefined) speedFactorSlider.value = genParams.speed_factor;
        if (seedInput && genParams.seed !== undefined) seedInput.value = genParams.seed;
        if (languageSelect && genParams.language !== undefined) languageSelect.value = genParams.language;
        if (temperatureValueDisplay && temperatureSlider) temperatureValueDisplay.textContent = temperatureSlider.value;
        if (exaggerationValueDisplay && exaggerationSlider) exaggerationValueDisplay.textContent = exaggerationSlider.value;
        if (cfgWeightValueDisplay && cfgWeightSlider) cfgWeightValueDisplay.textContent = cfgWeightSlider.value;
        if (speedFactorValueDisplay && speedFactorSlider) speedFactorValueDisplay.textContent = speedFactorSlider.value;
        updateSpeedFactorWarning(); // Update warning after applying preset
        if (genParams.voice_id && predefinedVoiceSelect) {
            const voiceExists = Array.from(predefinedVoiceSelect.options).some(opt => opt.value === genParams.voice_id);
            if (voiceExists) {
                predefinedVoiceSelect.value = genParams.voice_id;
                // MODIFICATION: Set checked property directly and call the UI update function.
                document.querySelector('input[name="voice_mode"][value="predefined"]').checked = true;
                toggleVoiceOptionsDisplay();
            }
        } else if (genParams.reference_audio_filename && cloneReferenceSelect) {
            const refExists = Array.from(cloneReferenceSelect.options).some(opt => opt.value === genParams.reference_audio_filename);
            if (refExists) {
                cloneReferenceSelect.value = genParams.reference_audio_filename;
                // MODIFICATION: Set checked property directly and call the UI update function.
                document.querySelector('input[name="voice_mode"][value="clone"]').checked = true;
                toggleVoiceOptionsDisplay();
            }
        }
        if (showNotif) showNotification(`Preset "${presetData.name}" loaded.`, 'info', 3000);
        // Only save the state if this was a direct user click, not an init call.
        if (isUserInteraction) {
            debouncedSaveState();
        }
    }

    // --- Voice Mode and Options Visibility ---
    function toggleVoiceOptionsDisplay() {
        const selectedMode = document.querySelector('input[name="voice_mode"]:checked')?.value;
        currentVoiceMode = selectedMode;
        if (predefinedVoiceOptionsDiv) predefinedVoiceOptionsDiv.classList.toggle('hidden', selectedMode !== 'predefined');
        if (cloneOptionsDiv) cloneOptionsDiv.classList.toggle('hidden', selectedMode !== 'clone');
        if (predefinedVoiceSelect) predefinedVoiceSelect.required = (selectedMode === 'predefined');
        if (cloneReferenceSelect) cloneReferenceSelect.required = (selectedMode === 'clone');
    }
    voiceModeRadios.forEach(radio => radio.addEventListener('change', toggleVoiceOptionsDisplay));

    function toggleChunkControlsVisibility() {
        const isChecked = splitTextToggle ? splitTextToggle.checked : false;
        if (chunkSizeControls) chunkSizeControls.classList.toggle('hidden', !isChecked);
        if (chunkExplanation) chunkExplanation.classList.toggle('hidden', !isChecked);
    }
    if (splitTextToggle) toggleChunkControlsVisibility();

    // --- Audio Player (WaveSurfer) ---
    function initializeWaveSurfer(audioUrl, resultDetails = {}) {
        if (wavesurfer) {
            wavesurfer.unAll(); // Remove all event listeners before destroying
            wavesurfer.destroy();
            wavesurfer = null;
        }
        if (currentAudioBlobUrl) {
            URL.revokeObjectURL(currentAudioBlobUrl);
            currentAudioBlobUrl = null;
        }
        currentAudioBlobUrl = audioUrl;

        // Ensure the container is clean or re-created
        audioPlayerContainer.innerHTML = `
            <div class="audio-player-card">
                <div class="p-6 sm:p-8">
                    <h2 class="card-header">Generated Audio</h2>
                    <div class="mb-5"><div id="waveform" class="waveform-container"></div></div>
                    <div class="audio-player-controls">
                        <div class="audio-player-buttons">
                            <button id="play-btn" class="btn-primary flex items-center" disabled>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 mr-1.5"><path fill-rule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm6.39-2.908a.75.75 0 0 1 .766.027l3.5 2.25a.75.75 0 0 1 0 1.262l-3.5 2.25A.75.75 0 0 1 8 12.25v-4.5a.75.75 0 0 1 .39-.658Z" clip-rule="evenodd" /></svg>
                                <span>Play</span>
                            </button>
                            <a id="download-link" href="#" download="tts_output.wav" class="btn-secondary flex items-center opacity-50 pointer-events-none">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 mr-1.5">
                                  <path fill-rule="evenodd" d="M10 3a.75.75 0 01.75.75v6.638l1.96-2.158a.75.75 0 111.08 1.04l-3.25 3.5a.75.75 0 01-1.08 0l-3.25-3.5a.75.75 0 111.08-1.04l1.96 2.158V3.75A.75.75 0 0110 3zM3.75 13a.75.75 0 01.75.75v.008c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V13.75a.75.75 0 011.5 0v.008c0 1.518-1.232 2.75-2.75 2.75h-8.5C4.232 16.5 3 15.268 3 13.75v-.008A.75.75 0 013.75 13z" clip-rule="evenodd" />
                                </svg>
                                <span>Download</span>
                            </a>
                        </div>
                        <div class="audio-player-info text-xs sm:text-sm">
                            Mode: <span id="player-voice-mode" class="font-medium text-indigo-600 dark:text-indigo-400">--</span>
                            <span id="player-voice-file-details"></span>
                            <span class="mx-1">•</span> Gen Time: <span id="player-gen-time" class="font-medium tabular-nums">--s</span>
                            <span class="mx-1">•</span> Duration: <span id="audio-duration" class="font-medium tabular-nums">--:--</span>
                        </div>
                    </div>
                </div>
            </div>`;

        // Re-select elements after recreating them
        const waveformDiv = audioPlayerContainer.querySelector('#waveform');
        const playBtn = audioPlayerContainer.querySelector('#play-btn');
        const downloadLink = audioPlayerContainer.querySelector('#download-link');
        const playerModeSpan = audioPlayerContainer.querySelector('#player-voice-mode');
        const playerFileSpan = audioPlayerContainer.querySelector('#player-voice-file-details');
        const playerGenTimeSpan = audioPlayerContainer.querySelector('#player-gen-time');
        const audioDurationSpan = audioPlayerContainer.querySelector('#audio-duration');

        const audioFilename = resultDetails.filename || (typeof audioUrl === 'string' ? audioUrl.split('/').pop() : 'tts_output.wav');
        if (downloadLink) {
            downloadLink.href = audioUrl;
            downloadLink.download = audioFilename;
            const downloadTextSpan = downloadLink.querySelector('span'); // Target the span for text update
            if (downloadTextSpan) {
                downloadTextSpan.textContent = `Download ${audioFilename.split('.').pop().toUpperCase()}`;
            }
        }
        if (playerModeSpan) playerModeSpan.textContent = resultDetails.submittedVoiceMode || currentVoiceMode || '--';
        if (playerFileSpan) {
            let fileDetail = '';
            if ((resultDetails.submittedVoiceMode || currentVoiceMode) === 'clone' && resultDetails.submittedCloneFile) {
                fileDetail = `(<span class="font-medium text-slate-700 dark:text-slate-300">${resultDetails.submittedCloneFile}</span>)`;
            } else if ((resultDetails.submittedVoiceMode || currentVoiceMode) === 'predefined' && resultDetails.submittedPredefinedVoice) {
                fileDetail = `(<span class="font-medium text-slate-700 dark:text-slate-300">${resultDetails.submittedPredefinedVoice}</span>)`;
            }
            playerFileSpan.innerHTML = fileDetail;
        }
        if (playerGenTimeSpan) playerGenTimeSpan.textContent = resultDetails.genTime ? `${resultDetails.genTime}s` : '--s';

        const playIconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 mr-1.5"><path fill-rule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm6.39-2.908a.75.75 0 0 1 .766.027l3.5 2.25a.75.75 0 0 1 0 1.262l-3.5 2.25A.75.75 0 0 1 8 12.25v-4.5a.75.75 0 0 1 .39-.658Z" clip-rule="evenodd" /></svg><span>Play</span>`;
        const pauseIconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5 mr-1.5"><path fill-rule="evenodd" d="M2 10a8 8 0 1 1 16 0 8 8 0 0 1-16 0Zm5-2.25A.75.75 0 0 1 7.75 7h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-4.5Z" clip-rule="evenodd" /></svg><span>Pause</span>`;
        const isDark = document.documentElement.classList.contains('dark');

        wavesurfer = WaveSurfer.create({
            container: waveformDiv, waveColor: isDark ? '#6366f1' : '#a5b4fc', progressColor: isDark ? '#4f46e5' : '#6366f1',
            cursorColor: isDark ? '#cbd5e1' : '#475569', barWidth: 3, barRadius: 3, cursorWidth: 1, height: 80, barGap: 2,
            responsive: true, url: audioUrl, mediaControls: false, normalize: true,
        });

        wavesurfer.on('ready', () => {
            const duration = wavesurfer.getDuration();
            if (audioDurationSpan) audioDurationSpan.textContent = formatTime(duration);
            if (playBtn) { playBtn.disabled = false; playBtn.innerHTML = playIconSVG; }
            if (downloadLink) { downloadLink.classList.remove('opacity-50', 'pointer-events-none'); downloadLink.setAttribute('aria-disabled', 'false'); }
        });
        wavesurfer.on('play', () => { if (playBtn) playBtn.innerHTML = pauseIconSVG; });
        wavesurfer.on('pause', () => { if (playBtn) playBtn.innerHTML = playIconSVG; });
        wavesurfer.on('finish', () => { if (playBtn) playBtn.innerHTML = playIconSVG; wavesurfer.seekTo(0); });
        wavesurfer.on('error', (err) => {
            console.error("WaveSurfer error:", err);
            showNotification(`Error loading audio waveform: ${err.message || err}`, 'error');
            if (waveformDiv) waveformDiv.innerHTML = `<p class="p-4 text-sm text-red-600 dark:text-red-400">Could not load waveform.</p>`;
            if (playBtn) playBtn.disabled = true;
        });

        if (playBtn) {
            playBtn.onclick = () => {
                if (wavesurfer) {
                    wavesurfer.playPause();
                }
            };
        }
        setTimeout(() => audioPlayerContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 150);
    }

    // --- TTS Generation Logic ---
    function getTTSFormData() {
        const jsonData = {
            text: getCurrentTextContent(),
            temperature: parseFloat(temperatureSlider.value),
            exaggeration: parseFloat(exaggerationSlider.value),
            cfg_weight: parseFloat(cfgWeightSlider.value),
            speed_factor: parseFloat(speedFactorSlider.value),
            seed: parseInt(seedInput.value, 10),
            language: languageSelect.value,
            voice_mode: currentVoiceMode,
            split_text: splitTextToggle.checked,
            chunk_size: parseInt(chunkSizeSlider.value, 10),
            output_format: outputFormatSelect.value || 'mp3'
        };
        if (currentVoiceMode === 'predefined' && predefinedVoiceSelect.value !== 'none') {
            jsonData.predefined_voice_id = predefinedVoiceSelect.value;
        } else if (currentVoiceMode === 'clone' && cloneReferenceSelect.value !== 'none') {
            jsonData.reference_audio_filename = cloneReferenceSelect.value;
        }
        return jsonData;
    }

    async function submitTTSRequest() {
        isGenerating = true;
        showLoadingOverlay();
        const startTime = performance.now();
        const jsonData = getTTSFormData();
        try {
            const response = await fetch(`${API_BASE_URL}/tts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jsonData)
            });
            if (!response.ok) {
                const errorResult = await response.json().catch(() => ({ detail: `HTTP error ${response.status}` }));
                throw new Error(errorResult.detail || 'TTS generation failed.');
            }
            // Determine response type. For large files the server will save to /outputs and return JSON with a download_url.
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            const endTime = performance.now();
            const genTime = ((endTime - startTime) / 1000).toFixed(2);
            if (contentType.includes('application/json')) {
                const jsonResp = await response.json();
                if (jsonResp && jsonResp.download_url) {
                    const fileUrl = `${API_BASE_URL}${jsonResp.download_url}`;
                    const resultDetails = {
                        outputUrl: fileUrl,
                        filename: jsonResp.filename || (jsonResp.download_url.split('/').pop()),
                        genTime: genTime,
                        submittedVoiceMode: jsonData.voice_mode,
                        submittedPredefinedVoice: jsonData.predefined_voice_id,
                        submittedCloneFile: jsonData.reference_audio_filename,
                    };
                    initializeWaveSurfer(resultDetails.outputUrl, resultDetails);
                    showNotification(`Large audio saved to server outputs and is available: ${resultDetails.filename}`, 'info', 8000);
                } else {
                    throw new Error('Server returned JSON but no download URL was provided.');
                }
            } else {
                const audioBlob = await response.blob();
                const filenameFromServer = response.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/"/g, '') || 'generated_audio.wav';
                const resultDetails = {
                    outputUrl: URL.createObjectURL(audioBlob), filename: filenameFromServer, genTime: genTime,
                    submittedVoiceMode: jsonData.voice_mode, submittedPredefinedVoice: jsonData.predefined_voice_id,
                    submittedCloneFile: jsonData.reference_audio_filename
                };
                initializeWaveSurfer(resultDetails.outputUrl, resultDetails);
                showNotification('Audio generated successfully!', 'success');
            }
        } catch (error) {
            console.error('TTS Generation Error:', error);
            showNotification(error.message || 'An unknown error occurred during TTS generation.', 'error');
        } finally {
            isGenerating = false;
            hideLoadingOverlay();
        }
    }

    function proceedWithSubmissionChecks() {
        const isMulti = multiRunToggle && multiRunToggle.checked;
        if (isMulti) {
            const items = buildMultiRequestsArray();
            if (items.length === 0) {
                showNotification("Add at least one text box with content for multi-run.", "error");
                return;
            }
            submitMultiTTSRequests();
            return;
        }
        const textContent = getCurrentTextContent();
        const isSplittingEnabled = splitTextToggle.checked;
        const currentChunkSz = parseInt(chunkSizeSlider.value, 10);
        const needsChunkWarn = isSplittingEnabled && textContent.length >= currentChunkSz * 1.5 &&
            currentVoiceMode !== 'predefined' && currentVoiceMode !== 'clone' &&
            (!seedInput || parseInt(seedInput.value, 10) === 0 || seedInput.value === '') && !hideChunkWarning;
        if (needsChunkWarn) { showChunkWarningModal(); return; }
        submitTTSRequest();
    }

    // --- Attach main generation event to the button's CLICK, not the form's SUBMIT ---
    // This is a more robust method that prevents accidental submissions during page load.
    if (generateBtn) {
        generateBtn.addEventListener('click', function (event) {

            console.log('Generate button clicked!');
            console.log('Current voice mode:', currentVoiceMode);
            console.log('Is generating:', isGenerating);
            console.log('Text content:', getCurrentTextContent() || 'NO TEXTAREA');

            // We still prevent default in case the button has any default browser actions.
            event.preventDefault();

            if (isGenerating) {
                showNotification("Generation is already in progress.", "warning");
                return;
            }

            // If the single textarea was removed from the UI, fall back to multi-text batch mode.
            if (!textArea) {
                const items = buildMultiRequestsArray();
                if (items.length === 0) {
                    showNotification("Please enter some text to generate speech.", 'error');
                    return;
                }
                // Directly submit as batch. We skip the single-run warnings and validations here.
                submitMultiTTSRequests();
                return;
            }

            const textContent = getCurrentTextContent();
            if (!textContent) {
                showNotification("Please enter some text to generate speech.", 'error');
                return;
            }
            if (currentVoiceMode === 'predefined' && (!predefinedVoiceSelect || predefinedVoiceSelect.value === 'none')) {
                showNotification("Please select a predefined voice.", 'error');
                return;
            }
            if (currentVoiceMode === 'clone' && (!cloneReferenceSelect || cloneReferenceSelect.value === 'none')) {
                showNotification("Please select a reference audio file for Voice Cloning.", 'error');
                return;
            }

            // Check for the generation quality warning.
            if (!hideGenerationWarning) {
                showGenerationWarningModal();
                return; // Stop here and let the modal handler take over.
            }

            // If the warning is hidden, proceed to the final checks.
            proceedWithSubmissionChecks();
        });
    } else {
        console.log('Generate button not found!');
    }

    // --- Clear All Handler ---
    async function clearAllData() {
        // Double-check with user before clearing
        if (!confirm("Clear all text boxes and server cache? This cannot be undone.")) {
            return;
        }

        try {
            // Clear server-side cache
            const response = await fetch(`${API_BASE_URL}/clear_cache`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                const errorResult = await response.json().catch(() => ({ detail: `HTTP error ${response.status}` }));
                throw new Error(errorResult.detail || 'Failed to clear server cache.');
            }

            // Clear client-side UI
            // Clear single textarea
            if (textArea) {
                textArea.value = '';
                if (charCount) charCount.textContent = '0';
            }

            // Clear multi-text boxes
            if (multiTextsContainer) {
                resetMultiTextBoxes();
            }

            // Reset character count
            if (charCount) charCount.textContent = '0';

            // Clear audio player if present
            if (audioPlayerContainer) {
                audioPlayerContainer.innerHTML = '';
            }

            // Save the cleared state
            await saveCurrentUiState();

            showNotification('All text boxes cleared and server cache flushed. Ready for next batch.', 'success', 5000);
        } catch (error) {
            console.error('Clear All Error:', error);
            showNotification(error.message || 'Error clearing data.', 'error');
        }
    }

    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', function (event) {
            event.preventDefault();
            clearAllData();
        });
    }

    // --- Modal Handling ---
    function showChunkWarningModal() {
        if (chunkWarningModal) {
            chunkWarningModal.style.display = 'flex';
            chunkWarningModal.classList.remove('hidden', 'opacity-0');
            chunkWarningModal.dataset.state = 'open';
        }
    }
    function hideChunkWarningModal() {
        if (chunkWarningModal) {
            chunkWarningModal.classList.add('opacity-0');
            setTimeout(() => {
                chunkWarningModal.style.display = 'none';
                chunkWarningModal.dataset.state = 'closed';
            }, 300);
        }
    }
    function showGenerationWarningModal() {
        if (generationWarningModal) {
            generationWarningModal.style.display = 'flex';
            generationWarningModal.classList.remove('hidden', 'opacity-0');
            generationWarningModal.dataset.state = 'open';
        }
    }
    function hideGenerationWarningModal() {
        if (generationWarningModal) {
            generationWarningModal.classList.add('opacity-0');
            setTimeout(() => {
                generationWarningModal.style.display = 'none';
                generationWarningModal.dataset.state = 'closed';
            }, 300);
        }
    }
    if (chunkWarningOkBtn) chunkWarningOkBtn.addEventListener('click', () => {
        if (hideChunkWarningCheckbox && hideChunkWarningCheckbox.checked) hideChunkWarning = true;
        hideChunkWarningModal(); debouncedSaveState(); submitTTSRequest();
    });
    if (chunkWarningCancelBtn) chunkWarningCancelBtn.addEventListener('click', hideChunkWarningModal);
    if (generationWarningAcknowledgeBtn) generationWarningAcknowledgeBtn.addEventListener('click', () => {
        if (hideGenerationWarningCheckbox && hideGenerationWarningCheckbox.checked) hideGenerationWarning = true;
        hideGenerationWarningModal(); debouncedSaveState(); proceedWithSubmissionChecks();
    });
    if (loadingCancelBtn) loadingCancelBtn.addEventListener('click', () => {
        if (isGenerating) { isGenerating = false; hideLoadingOverlay(); showNotification("Generation UI cancelled by user.", "info"); }
    });
    function showLoadingOverlay() {
        if (loadingOverlay && generateBtn && loadingCancelBtn) {
            loadingMessage.textContent = 'Generating audio...';
            loadingStatusText.textContent = 'Please wait. This may take some time.';
            loadingOverlay.style.display = 'flex';
            loadingOverlay.classList.remove('hidden', 'opacity-0'); loadingOverlay.dataset.state = 'open';
            generateBtn.disabled = true; loadingCancelBtn.disabled = false;
        }
    }
    function hideLoadingOverlay() {
        if (loadingOverlay && generateBtn) {
            loadingOverlay.classList.add('opacity-0');
            setTimeout(() => {
                loadingOverlay.style.display = 'none';
                loadingOverlay.dataset.state = 'closed';
            }, 300);
            generateBtn.disabled = false;
        }
    }

    // --- Configuration Management ---
    function displayServerConfiguration() {
        if (!serverConfigForm || !currentConfig || Object.keys(currentConfig).length === 0) return;
        const fieldsToDisplay = {
            "server.host": currentConfig.server?.host, "server.port": currentConfig.server?.port,
            "tts_engine.device": currentConfig.tts_engine?.device, "tts_engine.default_voice_id": currentConfig.tts_engine?.default_voice_id,
            "paths.model_cache": currentConfig.paths?.model_cache, "tts_engine.predefined_voices_path": currentConfig.tts_engine?.predefined_voices_path,
            "tts_engine.reference_audio_path": currentConfig.tts_engine?.reference_audio_path, "paths.output": currentConfig.paths?.output,
            "audio_output.format": currentConfig.audio_output?.format, "audio_output.sample_rate": currentConfig.audio_output?.sample_rate,
            "ui_state.initial_textbox_count": currentConfig.ui_state?.initial_textbox_count,
            "ui_state.chapters_per_section": currentConfig.ui_state?.chapters_per_section,
            "ui_state.multi_run_enabled": currentConfig.ui_state?.multi_run_enabled,
            "ui_state.keep_notes": currentConfig.ui_state?.keep_notes
        };
        for (const name in fieldsToDisplay) {
            const input = serverConfigForm.querySelector(`input[name="${name}"]`);
            if (input) {
                if (input.type === 'checkbox') input.checked = !!fieldsToDisplay[name];
                else input.value = fieldsToDisplay[name] !== undefined ? fieldsToDisplay[name] : '';
                if (name.includes('.host') || name.includes('.port') || name.includes('.device') || name.includes('paths.')) input.readOnly = true;
                else input.readOnly = false;
            }
        }
    }
    async function updateConfigStatus(button, statusElem, message, type = 'info', duration = 5000, enableButtonAfter = true) {
        const statusClasses = { success: 'text-green-600 dark:text-green-400', error: 'text-red-600 dark:text-red-400', warning: 'text-yellow-600 dark:text-yellow-400', info: 'text-indigo-600 dark:text-indigo-400', processing: 'text-yellow-600 dark:text-yellow-400 animate-pulse' };
        const isProcessing = message.toLowerCase().includes('saving') || message.toLowerCase().includes('restarting') || message.toLowerCase().includes('resetting');
        const messageType = isProcessing ? 'processing' : type;
        if (statusElem) {
            statusElem.textContent = message;
            statusElem.className = `text-xs ml-2 ${statusClasses[messageType] || statusClasses['info']}`;
            statusElem.classList.remove('hidden');
        }
        if (button) button.disabled = isProcessing || (type === 'error' && !enableButtonAfter) || (type === 'success' && !enableButtonAfter);
        if (duration > 0) setTimeout(() => { if (statusElem) statusElem.classList.add('hidden'); if (button && enableButtonAfter) button.disabled = false; }, duration);
        else if (button && enableButtonAfter && !isProcessing) button.disabled = false;
    }

    if (saveConfigBtn && configStatus) {
        saveConfigBtn.addEventListener('click', async () => {
            const configDataToSave = {};
            const inputs = serverConfigForm.querySelectorAll('input[name]:not([readonly]), select[name]:not([readonly])');
            inputs.forEach(input => {
                const keys = input.name.split('.'); let currentLevel = configDataToSave;
                keys.forEach((key, index) => {
                    if (index === keys.length - 1) {
                        let value = input.value;
                        if (input.type === 'number') value = parseFloat(value) || 0;
                        else if (input.type === 'checkbox') value = input.checked;
                        currentLevel[key] = value;
                    } else { currentLevel[key] = currentLevel[key] || {}; currentLevel = currentLevel[key]; }
                });
            });
            if (Object.keys(configDataToSave).length === 0) { showNotification("No editable configuration values to save.", "info"); return; }
            updateConfigStatus(saveConfigBtn, configStatus, 'Saving configuration...', 'info', 0, false);
            try {
                const response = await fetch(`${API_BASE_URL}/save_settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(configDataToSave)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Failed to save configuration');
                updateConfigStatus(saveConfigBtn, configStatus, result.message || 'Configuration saved.', 'success', 5000);
                if (result.restart_needed && restartServerBtn) restartServerBtn.classList.remove('hidden');
                await fetchInitialData();
                showNotification("Configuration saved. Some changes may require a server restart if prompted.", "success");
            } catch (error) {
                console.error('Error saving server config:', error);
                updateConfigStatus(saveConfigBtn, configStatus, `Error: ${error.message}`, 'error', 0);
            }
        });
    }

    if (saveGenDefaultsBtn && genDefaultsStatus) {
        saveGenDefaultsBtn.addEventListener('click', async () => {
            const genParams = {
                temperature: parseFloat(temperatureSlider.value), exaggeration: parseFloat(exaggerationSlider.value),
                cfg_weight: parseFloat(cfgWeightSlider.value), speed_factor: parseFloat(speedFactorSlider.value),
                seed: parseInt(seedInput.value, 10) || 0, language: languageSelect.value
            };
            updateConfigStatus(saveGenDefaultsBtn, genDefaultsStatus, 'Saving generation defaults...', 'info', 0, false);
            try {
                const response = await fetch(`${API_BASE_URL}/save_settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ generation_defaults: genParams })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Failed to save generation defaults');
                updateConfigStatus(saveGenDefaultsBtn, genDefaultsStatus, result.message || 'Generation defaults saved.', 'success', 5000);
                if (currentConfig.generation_defaults) Object.assign(currentConfig.generation_defaults, genParams);
            } catch (error) {
                console.error('Error saving generation defaults:', error);
                updateConfigStatus(saveGenDefaultsBtn, genDefaultsStatus, `Error: ${error.message}`, 'error', 0);
            }
        });
    }

    if (resetSettingsBtn) {
        resetSettingsBtn.addEventListener('click', async () => {
            if (!confirm("Are you sure you want to reset ALL settings to their initial defaults? This will affect config.yaml and UI preferences. This action cannot be undone.")) return;
            updateConfigStatus(resetSettingsBtn, configStatus, 'Resetting settings...', 'info', 0, false);
            try {
                const response = await fetch(`${API_BASE_URL}/reset_settings`, {
                    method: 'POST'
                });
                if (!response.ok) {
                    const errorResult = await response.json().catch(() => ({ detail: 'Failed to reset settings on server.' }));
                    throw new Error(errorResult.detail);
                }
                const result = await response.json();
                updateConfigStatus(resetSettingsBtn, configStatus, result.message + " Reloading page...", 'success', 0, false);
                setTimeout(() => window.location.reload(true), 2000);
            } catch (error) {
                console.error('Error resetting settings:', error);
                updateConfigStatus(resetSettingsBtn, configStatus, `Reset Error: ${error.message}`, 'error', 0);
                showNotification(`Error resetting settings: ${error.message}`, 'error');
            }
        });
    }

    if (restartServerBtn) {
        restartServerBtn.addEventListener('click', async () => {
            if (!confirm("Are you sure you want to restart the server?")) return;
            updateConfigStatus(restartServerBtn, configStatus, 'Attempting server restart...', 'processing', 0, false);
            try {
                const response = await fetch(`${API_BASE_URL}/restart_server`, {
                    method: 'POST'
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.detail || 'Server responded with error on restart command');
                showNotification("Server restart initiated. Please wait a moment for the server to come back online, then refresh the page.", "info", 10000);
            } catch (error) {
                showNotification(`Server restart command failed: ${error.message}`, "error");
                updateConfigStatus(restartServerBtn, configStatus, `Restart failed.`, 'error', 5000, true);
            }
        });
    }

    // --- File Upload & Refresh ---
    async function handleFileUpload(fileInput, endpoint, successCallback, buttonToAnimate) {
        const files = fileInput.files;
        if (!files || files.length === 0) return;
        const originalButtonHTML = buttonToAnimate ? buttonToAnimate.innerHTML : '';
        if (buttonToAnimate) {
            buttonToAnimate.innerHTML = `<svg class="animate-spin h-5 w-5 mr-1.5 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>Uploading...`;
            buttonToAnimate.disabled = true;
        }
        const uploadNotification = showNotification(`Uploading ${files.length} file(s)...`, 'info', 0);
        const formData = new FormData();
        for (const file of files) formData.append('files', file);
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (uploadNotification) uploadNotification.remove();
            if (!response.ok) throw new Error(result.message || result.detail || `Upload failed with status ${response.status}`);
            if (result.errors && result.errors.length > 0) {
                result.errors.forEach(err => showNotification(`Upload Warning: ${err.filename || 'File'} - ${err.error}`, 'warning', 10000));
            }
            const successfulUploads = result.uploaded_files || [];
            if (successfulUploads.length > 0) {
                showNotification(`Successfully uploaded: ${successfulUploads.join(', ')}`, 'success');
            } else if (!result.errors || result.errors.length === 0) {
                showNotification("Files processed. No new valid files were added or an issue occurred.", 'info');
            }
            successCallback(result);
            debouncedSaveState();
        } catch (error) {
            console.error(`Error uploading to ${endpoint}:`, error);
            if (uploadNotification) uploadNotification.remove();
            showNotification(`Upload Error: ${error.message}`, 'error');
        } finally {
            if (buttonToAnimate) {
                buttonToAnimate.disabled = false;
                buttonToAnimate.innerHTML = originalButtonHTML;
            }
            fileInput.value = '';
        }
    }

    if (cloneImportButton && cloneFileInput) {
        cloneImportButton.addEventListener('click', () => cloneFileInput.click());
        cloneFileInput.addEventListener('change', () => handleFileUpload(cloneFileInput, '/upload_reference', (result) => {
            initialReferenceFiles = result.all_reference_files || [];
            populateReferenceFiles();
            const firstUploaded = result.uploaded_files?.[0];
            if (firstUploaded && cloneReferenceSelect && Array.from(cloneReferenceSelect.options).some(opt => opt.value === firstUploaded)) {
                cloneReferenceSelect.value = firstUploaded;
            }
        }, cloneImportButton));
    }

    if (predefinedVoiceImportButton && predefinedVoiceFileInput) {
        predefinedVoiceImportButton.addEventListener('click', () => predefinedVoiceFileInput.click());
        predefinedVoiceFileInput.addEventListener('change', () => handleFileUpload(predefinedVoiceFileInput, '/upload_predefined_voice', (result) => {
            initialPredefinedVoices = result.all_predefined_voices || [];
            populatePredefinedVoices();
            const firstUploadedFilename = result.uploaded_files?.[0];
            if (firstUploadedFilename && predefinedVoiceSelect && initialPredefinedVoices.some(v => v.filename === firstUploadedFilename)) {
                predefinedVoiceSelect.value = firstUploadedFilename;
            }
        }, predefinedVoiceImportButton));
    }

    if (cloneRefreshButton && cloneReferenceSelect) {
        cloneRefreshButton.addEventListener('click', async () => {
            const originalButtonIcon = cloneRefreshButton.innerHTML;
            cloneRefreshButton.innerHTML = `<svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
            cloneRefreshButton.disabled = true;
            try {
                const response = await fetch(`${API_BASE_URL}/get_reference_files`);
                if (!response.ok) throw new Error('Failed to fetch reference files list');
                const files = await response.json();
                initialReferenceFiles = files;
                populateReferenceFiles();
                showNotification("Reference file list refreshed.", 'info', 2000);
                debouncedSaveState();
            } catch (error) {
                console.error("Error refreshing reference files:", error);
                showNotification(`Error refreshing list: ${error.message}`, 'error');
            } finally {
                cloneRefreshButton.disabled = false;
                cloneRefreshButton.innerHTML = originalButtonIcon;
            }
        });
    }

    if (predefinedVoiceRefreshButton && predefinedVoiceSelect) {
        predefinedVoiceRefreshButton.addEventListener('click', async () => {
            const originalButtonIcon = predefinedVoiceRefreshButton.innerHTML;
            predefinedVoiceRefreshButton.innerHTML = `<svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
            predefinedVoiceRefreshButton.disabled = true;
            try {
                const response = await fetch(`${API_BASE_URL}/get_predefined_voices`);
                if (!response.ok) throw new Error('Failed to fetch predefined voices list');
                const voices = await response.json();
                initialPredefinedVoices = voices;
                populatePredefinedVoices();
                showNotification("Predefined voices list refreshed.", 'info', 2000);
                debouncedSaveState();
            } catch (error) {
                console.error("Error refreshing predefined voices:", error);
                showNotification(`Error refreshing list: ${error.message}`, 'error');
            } finally {
                predefinedVoiceRefreshButton.disabled = false;
                predefinedVoiceRefreshButton.innerHTML = originalButtonIcon;
            }
        });
    }

    // Replace the existing Generate button element to remove any previously-attached
    // listeners from the original single-run flow, then attach a single handler
    // that submits the batch endpoint. This ensures the UI always uses the multi
    // processing path (server-side will handle single-item batches too).
    try {
        if (generateBtn && generateBtn.parentNode) {
            const newGenBtn = generateBtn.cloneNode(true);
            generateBtn.parentNode.replaceChild(newGenBtn, generateBtn);
            newGenBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (isGenerating) return;
                proceedWithSubmissionChecks();
            });
        }
    } catch (err) {
        console.error('Error re-binding Generate button for batch mode:', err);
    }

    // --- Whole-book import, preview, and persistent queue ---
    let pendingBookFiles = [];
    let currentBookPreview = null;
    const bookFilesInput = document.getElementById('book-files-input');
    const bookFolderInput = document.getElementById('book-folder-input');
    const bookPreviewBtn = document.getElementById('book-preview-btn');
    const bookPreviewArea = document.getElementById('book-preview');
    const bookPreviewModal = document.getElementById('book-preview-modal');
    const bookJobsArea = document.getElementById('book-jobs');
    const bookDropZone = document.getElementById('book-drop-zone');
    const bookDropStatus = document.getElementById('book-drop-status');
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const BOOK_SOURCE_EXTENSIONS = new Set(['.epub', '.txt']);

    function isBookSourceFile(file) {
        const name = String(file?.name || '');
        return BOOK_SOURCE_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase());
    }

    function setBookDropActive(active) {
        bookDropZone?.classList.toggle('book-drop-active', active);
        bookDropZone?.setAttribute('aria-dropeffect', active ? 'copy' : 'none');
    }

    function fileDropKey(file) {
        return [file.bookRelativePath || file.webkitRelativePath || file.name, file.size, file.lastModified].join('\u0000');
    }

    function rememberBookRelativePath(file, relativePath) {
        if (!file || !relativePath || file.bookRelativePath) return file;
        try { Object.defineProperty(file, 'bookRelativePath', {value: relativePath, configurable: true}); }
        catch (_) { /* FormData can still fall back to the browser filename. */ }
        return file;
    }

    function uniqueBookFiles(files) {
        const seen = new Set();
        return files.filter(file => {
            const key = fileDropKey(file);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function selectBookFiles(files) {
        const supplied = uniqueBookFiles(Array.from(files || []).filter(Boolean));
        const supported = supplied.filter(isBookSourceFile);
        const unsupported = supplied.filter(file => !isBookSourceFile(file));
        const epubFiles = supported.filter(file => file.name.toLowerCase().endsWith('.epub'));
        const invalidBookMix = epubFiles.length > 0 && supported.length !== 1;
        pendingBookFiles = invalidBookMix ? [] : supported;
        bookPreviewBtn.disabled = pendingBookFiles.length === 0;
        bookDropZone?.classList.toggle('book-drop-ready', pendingBookFiles.length > 0);
        if (bookDropStatus) {
            bookDropStatus.textContent = invalidBookMix
                ? 'Choose exactly one EPUB, or a bundle containing TXT files only.'
                : pendingBookFiles.length
                ? `${pendingBookFiles.length} supported book source file(s) selected. Ready to preview.`
                : 'No supported EPUB or TXT files selected.';
        }
        if (invalidBookMix) {
            showNotification('Choose exactly one EPUB, or a bundle containing TXT files only.', 'error', 6000);
            return;
        }
        if (pendingBookFiles.length) showNotification(`${pendingBookFiles.length} book source file(s) selected.`, 'info', 2500);
        if (unsupported.length) showNotification(`Ignored ${unsupported.length} unsupported file(s). Use EPUB or TXT files only.`, pendingBookFiles.length ? 'warning' : 'error', 6000);
        if (!supplied.length) showNotification('No usable files were dropped. Drop an EPUB, TXT file, or a folder containing TXT files.', 'error', 6000);
    }

    function isFileDrag(event) {
        const transfer = event.dataTransfer;
        if (!transfer) return false;
        return Array.from(transfer.types || []).includes('Files')
            || Array.from(transfer.items || []).some(item => item.kind === 'file');
    }

    function entryFiles(entry, parentPath = '') {
        if (!entry) return Promise.resolve([]);
        const relativePath = String(entry.fullPath || `${parentPath}/${entry.name || ''}`).replace(/^\/+/, '');
        if (entry.isFile) {
            return new Promise(resolve => entry.file(
                file => resolve([rememberBookRelativePath(file, relativePath)]),
                () => resolve([]),
            ));
        }
        if (!entry.isDirectory) return Promise.resolve([]);
        const reader = entry.createReader();
        const readAllEntries = () => new Promise(resolve => {
            const collected = [];
            const readNext = () => reader.readEntries(entries => {
                if (!entries.length) return resolve(collected);
                collected.push(...entries);
                readNext();
            }, () => resolve(collected));
            readNext();
        });
        return readAllEntries().then(entries => Promise.all(entries.map(child => entryFiles(child, relativePath))).then(groups => groups.flat()));
    }

    async function droppedBookFiles(transfer) {
        const directFiles = Array.from(transfer?.files || []);
        const itemFiles = Array.from(transfer?.items || [])
            .map(item => item.kind === 'file' ? item.getAsFile?.() : null)
            .filter(Boolean);
        const directoryEntries = Array.from(transfer?.items || [])
            .map(item => item.kind === 'file' ? item.webkitGetAsEntry?.() : null)
            .filter(entry => entry?.isDirectory);
        const directoryFiles = (await Promise.all(directoryEntries.map(entry => entryFiles(entry)))).flat();
        return uniqueBookFiles([...directFiles, ...itemFiles, ...directoryFiles]);
    }

    function calculateBookOutputGroups(numbers, size, mergeTail, available = availableBookChapterNumbers()) {
        const wanted = new Set(numbers);
        const requestedStart = parseInt(document.getElementById('book-range-start')?.value, 10);
        const requestedEnd = parseInt(document.getElementById('book-range-end')?.value, 10);
        if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedStart > requestedEnd) return [];
        const availableInRange = available.filter(number => number >= requestedStart && number <= requestedEnd);
        if (!availableInRange.length) return [];
        const availableSet = new Set(availableInRange);
        const effectiveEnd = Math.max(...availableInRange);
        const groups = [];
        for (let chapterStart = requestedStart; chapterStart <= effectiveEnd; chapterStart += size) {
            const chapterEnd = Math.min(chapterStart + size - 1, effectiveEnd);
            const chapters = availableInRange.filter(number => number >= chapterStart && number <= chapterEnd && wanted.has(number));
            const runs = [];
            chapters.forEach(number => {
                if (!runs.length || number !== runs[runs.length - 1][runs[runs.length - 1].length - 1] + 1) runs.push([number]);
                else runs[runs.length - 1].push(number);
            });
            runs.forEach((run, index) => {
                const runStart = run[0];
                const runEnd = run[run.length - 1];
                const nextStart = index + 1 < runs.length ? runs[index + 1][0] : chapterEnd + 1;
                // Assign the separator to the preceding output.  This tells
                // the listener why a later file starts after a gap, while the
                // generated filename always uses the actual spoken range.
                const relevantStart = index === 0 ? chapterStart : runEnd + 1;
                const relevantEnd = nextStart - 1;
                const missing = [];
                const omitted = [];
                for (let number = relevantStart; number <= relevantEnd; number += 1) {
                    if (!availableSet.has(number)) missing.push(number);
                    else if (!wanted.has(number)) omitted.push(number);
                }
                groups.push({chapterStart: runStart, chapterEnd: runEnd, chapters: run, missing, omitted, bucketStart: chapterStart, bucketEnd: chapterEnd});
            });
        }
        if (mergeTail && groups.length > 1) {
            const tail = groups[groups.length - 1];
            const previous = groups[groups.length - 2];
            const tailSpan = tail.bucketEnd - tail.bucketStart + 1;
            if (tailSpan < size
                && tail.chapterStart === tail.bucketStart && tail.chapterEnd === tail.bucketEnd
                && !tail.missing.length && !tail.omitted.length
                && previous.chapterEnd + 1 === tail.chapterStart
                && previous.bucketEnd + 1 === tail.bucketStart) {
                previous.chapterEnd = tail.chapterEnd;
                previous.chapters.push(...tail.chapters);
                previous.missing.push(...tail.missing);
                previous.omitted.push(...tail.omitted);
                previous.bucketEnd = tail.bucketEnd;
                groups.pop();
            }
        }
        return groups;
    }

    function updateBookGroupPreview() {
        const output = document.getElementById('book-output-groups');
        const merge = document.getElementById('book-merge-final');
        if (!output || !merge) return;
        const size = Math.max(1, parseInt(document.getElementById('book-section-size').value || 50, 10));
        const selected = Array.from(document.querySelectorAll('.book-chapter-check:checked')).map(box => Number(box.value));
        const unmerged = calculateBookOutputGroups(selected, size, false);
        const tail = unmerged[unmerged.length - 1];
        const previous = unmerged[unmerged.length - 2];
        const hasShortMergeableTail = !!tail && !!previous
            && tail.bucketEnd - tail.bucketStart + 1 < size
            && tail.chapterStart === tail.bucketStart && tail.chapterEnd === tail.bucketEnd
            && !tail.missing.length && !tail.omitted.length
            && previous.chapterEnd + 1 === tail.chapterStart
            && previous.bucketEnd + 1 === tail.bucketStart;
        merge.disabled = !hasShortMergeableTail;
        if (!hasShortMergeableTail) merge.checked = false;
        const groups = calculateBookOutputGroups(selected, size, merge.checked);
        output.innerHTML = groups.length ? `<div class="text-sm mb-1">${groups.length} output file(s) planned:</div>` + groups.map((group, index) => {
            const span = group.chapterEnd - group.chapterStart + 1;
            const isCompleteNominalBucket = group.chapterStart === group.bucketStart && group.chapterEnd === group.bucketEnd;
            const isNominalPartialTail = isCompleteNominalBucket && group.bucketEnd - group.bucketStart + 1 < size;
            const isGapSplit = !isCompleteNominalBucket;
            const details = [group.missing.length ? `missing ${group.missing.join(', ')}` : '', group.omitted.length ? `${group.omitted.length} unchecked` : ''].filter(Boolean).join('; ');
            return `<div class="text-sm py-1 ${(isNominalPartialTail || isGapSplit) ? 'text-amber-600' : ''}">Output ${index + 1}: chapters <strong>${group.chapterStart}&ndash;${group.chapterEnd}</strong> (${group.chapters.length} detected chapters)${span > size ? ' &mdash; merged final group' : isGapSplit ? ' &mdash; split around a missing or unchecked chapter' : isNominalPartialTail ? ' &mdash; partial final group' : ''}${details ? `<span class="block text-amber-600">Warning: ${details}</span>` : ''}</div>`;
        }).join('') : '<div class="text-sm text-amber-600">No chapters selected.</div>';
    }
    // Count real detected chapters, rather than a numeric chapter span, so a
    // range with gaps never silently exceeds the batch safety limit.
    const BOOK_AUTO_END_CHAPTER_LIMIT = 600;

    function availableBookChapterNumbers() {
        return [...new Set(Array.from(bookPreviewArea?.querySelectorAll('.book-chapter-check') || [], box => Number(box.value)))]
            .filter(Number.isFinite);
    }

    function autoBookRangeEnd(start, available = availableBookChapterNumbers()) {
        if (!Number.isFinite(start)) return null;
        const startIndex = available.findIndex(number => number >= start);
        return startIndex < 0 ? null : available[Math.min(available.length - 1, startIndex + BOOK_AUTO_END_CHAPTER_LIMIT - 1)];
    }

    function updateAutomaticBookRangeEnd() {
        const startInput = document.getElementById('book-range-start');
        const endInput = document.getElementById('book-range-end');
        const end = autoBookRangeEnd(parseInt(startInput?.value, 10));
        if (!endInput || end === null) return false;
        endInput.value = String(end);
        return true;
    }

    function updateBookSectionChecks() {
        bookPreviewArea?.querySelectorAll('.book-section-check').forEach(sectionBox => {
            const children = Array.from(bookPreviewArea.querySelectorAll(`.book-chapter-check[data-section="${CSS.escape(sectionBox.value)}"]`));
            sectionBox.checked = children.length > 0 && children.every(box => box.checked);
            sectionBox.indeterminate = children.some(box => box.checked) && !sectionBox.checked;
        });
    }

    document.getElementById('book-files-btn')?.addEventListener('click', () => bookFilesInput.click());
    document.getElementById('book-folder-btn')?.addEventListener('click', () => bookFolderInput.click());
    bookFilesInput?.addEventListener('change', e => selectBookFiles(e.target.files));
    bookFolderInput?.addEventListener('change', e => selectBookFiles(e.target.files));
    // File drops outside the target must still be cancelled, otherwise browsers
    // often navigate to (and replace the app with) the dropped EPUB or TXT file.
    ['dragenter', 'dragover', 'drop'].forEach(name => document.addEventListener(name, event => {
        if (isFileDrag(event)) event.preventDefault();
    }));
    bookDropZone?.addEventListener('dragenter', event => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        setBookDropActive(true);
    });
    bookDropZone?.addEventListener('dragover', event => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setBookDropActive(true);
    });
    bookDropZone?.addEventListener('dragleave', event => {
        if (!isFileDrag(event)) return;
        // Drag events fire as the pointer moves across child buttons; only clear
        // the highlight after it actually leaves the whole target.
        if (!bookDropZone.contains(event.relatedTarget)) setBookDropActive(false);
    });
    bookDropZone?.addEventListener('drop', async event => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setBookDropActive(false);
        const files = await droppedBookFiles(event.dataTransfer);
        selectBookFiles(files);
    });

    bookPreviewBtn?.addEventListener('click', async () => {
        const form = new FormData();
        pendingBookFiles.forEach(file => form.append('files', file, file.bookRelativePath || file.webkitRelativePath || file.name));
        form.append('remove_notes', document.getElementById('book-remove-notes').checked);
        form.append('chapters_per_section', document.getElementById('book-section-size').value || '50');
        bookPreviewBtn.disabled = true;
        try {
            const response = await fetch(`${API_BASE_URL}/api/book-imports/preview`, {method: 'POST', body: form});
            const result = await response.json();
            if (!response.ok) throw new Error(result.detail || 'Book import failed.');
            currentBookPreview = result;
            document.getElementById('book-title').value = result.title;
            const notices = [...(result.errors || []).map(x => `<li class="text-red-600">Error: ${escapeHtml(x)}</li>`), ...(result.warnings || []).map(x => `<li class="text-amber-600">Warning: ${escapeHtml(x)}</li>`)].join('');
            const suggestedStart = result.suggested_chapter_start;
            const suggestedEnd = result.suggested_chapter_end;
            const sections = result.sections.map(s => {
                const chapterChecks = s.chapters.map(ch => `<label class="inline-flex items-center mr-3 mb-1"><input class="book-chapter-check mr-1" data-section="${escapeHtml(s.id)}" type="checkbox" value="${ch.number}" ${ch.number >= suggestedStart && ch.number <= suggestedEnd ? 'checked' : ''}>${ch.number}</label>`).join('');
                return `<details class="border rounded p-2 mb-2"><summary><label><input class="book-section-check mr-2" type="checkbox" value="${escapeHtml(s.id)}">Chapters ${s.chapter_start}–${s.chapter_end}</label> · ${s.chapter_count} chapters · ${s.character_count.toLocaleString()} characters</summary><div class="pt-2 text-sm">${chapterChecks}</div></details>`;
            }).join('');
            const resumeText = suggestedStart > result.sections[0]?.chapter_start ? ` Suggested from previous incomplete work: chapter ${suggestedStart}.` : '';
            bookPreviewArea.innerHTML = `<div class="font-semibold">${escapeHtml(result.title)} — ${result.chapter_count} chapters</div><p class="text-sm my-2">Choose exact chapters below. Outputs are split into groups of <strong>${escapeHtml(document.getElementById('book-section-size').value || 50)}</strong>. The initial selection is capped at 600 chapters.${escapeHtml(resumeText)}</p><ul class="text-sm my-2">${notices}</ul><div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3"><label class="text-sm">Starting chapter<input id="book-range-start" type="number" class="input-base" value="${suggestedStart}"></label><label class="text-sm">Ending chapter<input id="book-range-end" type="number" class="input-base" value="${suggestedEnd}"></label><button type="button" id="book-apply-range" class="btn-secondary self-end">Select range</button><button type="button" id="book-clear-selection" class="btn-secondary self-end">Uncheck all</button></div><button type="button" id="start-book-job" class="btn-primary mb-3" ${result.errors?.length ? 'disabled' : ''}>Generate selected chapters</button><div>${sections}</div><div class="card-base p-3 mt-3"><div class="font-semibold">Planned output files</div><div id="book-output-groups" class="my-2"></div><label class="text-sm"><input id="book-merge-final" type="checkbox" class="mr-2">Merge each eligible partial final group into its preceding file</label></div>`;
            const rangeEnd = document.getElementById('book-range-end');
            const rangeControls = rangeEnd?.closest('div');
            if (rangeEnd && rangeControls) {
                rangeEnd.setAttribute('aria-describedby', 'book-auto-end-help');
                const autoEndLabel = document.createElement('label');
                autoEndLabel.className = 'text-sm self-end';
                autoEndLabel.innerHTML = '<input id="book-auto-end" type="checkbox" class="mr-2" checked>Automatically set ending chapter <span id="book-auto-end-help" class="block text-xs">Up to 600 detected chapters from the start.</span>';
                rangeControls.insertBefore(autoEndLabel, document.getElementById('book-apply-range'));
            }
            bookPreviewArea.querySelectorAll('.book-section-check').forEach(sectionBox => {
                const children = Array.from(bookPreviewArea.querySelectorAll(`.book-chapter-check[data-section="${CSS.escape(sectionBox.value)}"]`));
                sectionBox.checked = children.length > 0 && children.every(box => box.checked);
                sectionBox.indeterminate = children.some(box => box.checked) && !sectionBox.checked;
            });
            updateBookGroupPreview();
            if (bookPreviewModal?.showModal) bookPreviewModal.showModal();
        } catch (error) { showNotification(error.message, 'error', 0); }
        finally { bookPreviewBtn.disabled = false; }
    });

    bookPreviewArea?.addEventListener('click', async e => {
        if (e.target.id === 'book-apply-range') {
            const start = parseInt(document.getElementById('book-range-start').value, 10);
            const end = parseInt(document.getElementById('book-range-end').value, 10);
            const available = availableBookChapterNumbers();
            if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || !available.some(number => number >= start && number <= end)) {
                showNotification('Enter a valid starting and ending chapter within this book.', 'error');
                return;
            }
            document.querySelectorAll('.book-chapter-check').forEach(box => box.checked = Number(box.value) >= start && Number(box.value) <= end);
            document.querySelectorAll('.book-section-check').forEach(sectionBox => {
                const children = Array.from(document.querySelectorAll(`.book-chapter-check[data-section="${CSS.escape(sectionBox.value)}"]`));
                sectionBox.checked = children.length > 0 && children.every(box => box.checked);
                sectionBox.indeterminate = children.some(box => box.checked) && !sectionBox.checked;
            });
            updateBookGroupPreview();
            return;
        }
        if (e.target.id === 'book-clear-selection') {
            document.querySelectorAll('.book-chapter-check, .book-section-check').forEach(box => box.checked = false);
            updateBookGroupPreview();
            return;
        }
        if (e.target.classList.contains('book-section-check')) {
            document.querySelectorAll(`.book-chapter-check[data-section="${CSS.escape(e.target.value)}"]`).forEach(box => box.checked = e.target.checked);
            updateBookGroupPreview();
            return;
        }
        if (e.target.classList.contains('book-chapter-check')) {
            const sectionBox = document.querySelector(`.book-section-check[value="${CSS.escape(e.target.dataset.section)}"]`);
            const children = Array.from(document.querySelectorAll(`.book-chapter-check[data-section="${CSS.escape(e.target.dataset.section)}"]`));
            if (sectionBox) {
                sectionBox.checked = children.every(box => box.checked);
                sectionBox.indeterminate = children.some(box => box.checked) && !sectionBox.checked;
            }
            updateBookGroupPreview();
            return;
        }
        if (e.target.id !== 'start-book-job' || !currentBookPreview) return;
        const selected = Array.from(document.querySelectorAll('.book-section-check:checked')).map(x => x.value);
        const selectedChapters = Array.from(document.querySelectorAll('.book-chapter-check:checked')).map(x => parseInt(x.value, 10));
        if (!selectedChapters.length) { showNotification('Select at least one chapter.', 'error'); return; }
        const requestedChapterStart = parseInt(document.getElementById('book-range-start')?.value, 10);
        const requestedChapterEnd = parseInt(document.getElementById('book-range-end')?.value, 10);
        if (!Number.isFinite(requestedChapterStart) || !Number.isFinite(requestedChapterEnd) || requestedChapterStart > requestedChapterEnd || selectedChapters.some(number => number < requestedChapterStart || number > requestedChapterEnd)) {
            showNotification('Select chapters within a valid requested chapter range.', 'error');
            return;
        }
        const payload = buildRequestForSingleControls('placeholder'); delete payload.text; payload.output_format = 'mp3';
        Object.assign(payload, {import_id: currentBookPreview.id, book_title: document.getElementById('book-title').value, selected_sections: selected, selected_chapters: selectedChapters, chapters_per_section: parseInt(document.getElementById('book-section-size').value || 50, 10), merge_final_section: !!document.getElementById('book-merge-final')?.checked, requested_chapter_start: requestedChapterStart, requested_chapter_end: requestedChapterEnd});
        try {
            const response = await fetch(`${API_BASE_URL}/api/book-jobs`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
            const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Could not start job.');
            showNotification('Audiobook job started.', 'success'); refreshBookJobs();
        } catch (error) { showNotification(error.message, 'error', 0); }
    });
    bookPreviewArea?.addEventListener('input', e => {
        if (e.target.id === 'book-range-start' && document.getElementById('book-auto-end')?.checked) {
            updateAutomaticBookRangeEnd();
        }
        if (e.target.id === 'book-range-end') {
            const autoEnd = document.getElementById('book-auto-end');
            if (autoEnd) autoEnd.checked = false;
        }
    });
    bookPreviewArea?.addEventListener('change', e => {
        if (e.target.id === 'book-merge-final') updateBookGroupPreview();
        if (e.target.id === 'book-range-start' && document.getElementById('book-auto-end')?.checked) {
            updateAutomaticBookRangeEnd();
            document.getElementById('book-apply-range')?.click();
        }
        if (e.target.id === 'book-range-end') {
            const autoEnd = document.getElementById('book-auto-end');
            if (autoEnd) autoEnd.checked = false;
            document.getElementById('book-apply-range')?.click();
        }
        if (e.target.id === 'book-auto-end' && e.target.checked) updateAutomaticBookRangeEnd();
    });
    document.getElementById('book-section-size')?.addEventListener('change', updateBookGroupPreview);
    document.getElementById('book-preview-close')?.addEventListener('click', () => bookPreviewModal?.close());

    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            if (textArea) textArea.value = '';
            resetMultiTextBoxes();
        }
    });

    async function refreshBookJobs() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/book-jobs`); if (!response.ok) return;
            const jobs = await response.json();
            bookJobsArea.innerHTML = jobs.map(job => {
                const sections = job.sections.map(s => `<div class="text-sm">Ch ${s.chapter_start}–${s.chapter_end}: ${escapeHtml(s.state)} (${s.completed_chapters}/${s.chapter_count}) ${s.state === 'completed' ? `<a href="${API_BASE_URL}/outputs/${encodeURIComponent(s.output_name)}">${escapeHtml(s.output_name)}</a>` : ''} ${s.error ? `<span class="text-red-600">${escapeHtml(s.error)}</span>` : ''}</div>`).join('');
                return `<div class="card-base p-3 mt-3"><div class="font-semibold">${escapeHtml(job.book_title)} — ${escapeHtml(job.state)}</div>${sections}<div class="flex gap-2 mt-2"><button class="btn-secondary book-control" data-id="${job.id}" data-action="pause">Pause</button><button class="btn-secondary book-control" data-id="${job.id}" data-action="resume">Resume</button><button class="btn-secondary book-control" data-id="${job.id}" data-action="retry-failed">Retry failed</button><button class="btn-secondary book-control" data-id="${job.id}" data-action="cancel">Cancel</button></div></div>`;
            }).join('');
        } catch (_) { /* polling should not disrupt ordinary TTS */ }
    }
    bookJobsArea?.addEventListener('click', async e => {
        const button = e.target.closest('.book-control'); if (!button) return;
        await fetch(`${API_BASE_URL}/api/book-jobs/${button.dataset.id}/${button.dataset.action}`, {method:'POST'}); refreshBookJobs();
    });

    await fetchInitialData();
    refreshBookJobs();
    setInterval(refreshBookJobs, 5000);
});
