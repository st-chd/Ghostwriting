import { DEFAULT_PROMPT, DRAFT_PREFIX, MAIN_API_PROFILE_ID, MAX_RECENT_MESSAGES, MAX_VERSIONS, DraftSession, buildMessages, completeRequest, getActivePreset, normalizeLanguage, normalizeRecentCount, normalizeSettings } from './core.js';

const GHOSTWRITING_ICON = '<i class="fa-solid" aria-hidden="true">&#xf52d;</i>';
const UNDO_ICON = '<i class="fa-solid" aria-hidden="true">&#xf2ea;</i>';
const STOP_ICON = '<i class="fa-solid" aria-hidden="true">&#xf04d;</i>';
const PERSIST_DEBOUNCE_MS = 250;
const SWIPE_MIN_PX = 45;
const SWIPE_RATIO = 1.5;

function button(id, label, icon, nativeControl = false) {
    const node = document.createElement(nativeControl ? 'div' : 'button');
    if (nativeControl) {
        node.setAttribute('role', 'button');
        node.tabIndex = 0;
    } else node.type = 'button';
    node.id = id;
    node.className = 'ghostwriting-icon-button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = icon;
    return node;
}

export function createGhostwritingApp(host, settingsHtml, quickHtml) {
    const editor = document.querySelector('#send_textarea');
    const send = document.querySelector('#send_but');
    const settingsContainer = document.querySelector('#extensions_settings');
    const menu = document.querySelector('#extensionsMenu');
    if (!editor || !send || !settingsContainer || !menu) throw new Error('SillyTavern 입력창 또는 확장 설정 영역을 찾을 수 없습니다.');
    if (!settingsHtml || !quickHtml) throw new Error('Ghostwriting 설정 화면을 읽지 못했습니다.');
    const draftKey = DRAFT_PREFIX + host.user;
    let settings = normalizeSettings(host.loadSettings());
    let saved;
    try { saved = JSON.parse(localStorage.getItem(draftKey)); } catch { /* 손상된 저장본은 적용하지 않는다. */ }
    const session = new DraftSession(saved);
    const lifetime = new AbortController();
    const disposers = [];
    let active = true;
    let cleared = false;
    let request = null;
    let saveTimer;
    let storageWarned = false;
    let internalEdit = false;
    let unlock = () => {};
    let quickPopup = null;
    let quickView = null;
    let quickLife = null;
    let lastBusy = null;

    const template = document.createElement('template');
    template.innerHTML = settingsHtml;
    const panelView = template.content.querySelector('#ghostwriting-settings');
    if (!panelView) throw new Error('Ghostwriting 설정 화면이 올바르지 않습니다.');
    settingsContainer.append(panelView);

    const controls = document.createElement('div');
    controls.id = 'ghostwriting-controls';
    const write = button('ghostwriting-write', '작성', GHOSTWRITING_ICON, true);
    const undo = button('ghostwriting-undo', '한글 원문으로 되돌리기', UNDO_ICON, true);
    controls.append(write, undo);
    send.before(controls);

    const list = document.createElement('div');
    list.id = 'ghostwriting-versions';
    list.setAttribute('role', 'dialog');
    list.setAttribute('aria-modal', 'false');
    list.setAttribute('aria-label', '변환 결과 목록');
    list.hidden = true;
    document.body.append(list);
    write.setAttribute('aria-controls', list.id);
    write.setAttribute('aria-haspopup', 'dialog');

    const toolbar = document.createElement('div');
    toolbar.className = 'ghostwriting-result-toolbar';
    const previous = button('ghostwriting-previous', '이전 결과', '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>');
    const next = button('ghostwriting-next', '다음 결과', '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>');
    const resultTitle = document.createElement('strong');
    resultTitle.setAttribute('aria-live', 'polite');
    const empty = button('ghostwriting-empty', '비우기', '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>');
    toolbar.append(previous, resultTitle, next, empty);
    const heading = document.createElement('div');
    heading.className = 'ghostwriting-list-heading';
    const preview = document.createElement('div');
    preview.className = 'ghostwriting-version';
    preview.tabIndex = 0;
    const apply = button('ghostwriting-apply', '입력창에 적용', '입력창에 적용');
    list.append(toolbar, heading, preview, apply);
    let viewedIndex = 0;
    let swipeStart = null;

    const status = document.createElement('span');
    status.id = 'ghostwriting-status';
    status.className = 'ghostwriting-sr-only';
    status.setAttribute('role', 'status');
    controls.append(status);

    const menuEntry = document.createElement('div');
    menuEntry.id = 'ghostwriting-wand';
    menuEntry.className = 'extension_container';
    const openSettingsButton = document.createElement('button');
    openSettingsButton.type = 'button';
    openSettingsButton.className = 'list-group-item flex-container';
    openSettingsButton.innerHTML = `${GHOSTWRITING_ICON}<span>Ghostwriting 설정</span>`;
    menuEntry.append(openSettingsButton);
    menu.append(menuEntry);

    function persist() {
        clearTimeout(saveTimer);
        if (cleared) return;
        try {
            if (session.original) localStorage.setItem(draftKey, JSON.stringify(session.snapshot()));
            else localStorage.removeItem(draftKey);
        } catch {
            if (!storageWarned) host.notify('브라우저 저장 공간에 초안을 저장하지 못했습니다. 현재 창에서는 계속 사용할 수 있습니다.', 'warning');
            storageWarned = true;
        }
    }

    function saveSettings() { host.saveSettings(settings); }

    function setInput(text) {
        internalEdit = true;
        editor.value = text;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        internalEdit = false;
    }

    function closeList() {
        const returnFocus = list.contains(document.activeElement);
        list.hidden = true;
        write.setAttribute('aria-expanded', 'false');
        if (returnFocus && !controls.hidden) write.focus();
    }

    function commit(nextText) {
        setInput(nextText);
        closeList();
        render();
        persist();
        editor.focus();
    }

    function writeLabel() {
        if (request) return '작성 취소';
        if (!session.versions.length || session.isNewDraft(editor.value)) {
            return settings.outputLanguage === 'ko' ? '한국어로 작성' : '영어로 작성';
        }
        return list.hidden ? '변환 결과 목록 열기' : '재작성';
    }

    function render() {
        const busy = Boolean(request);
        controls.hidden = !settings.enabled;
        menuEntry.hidden = !settings.enabled;
        if (lastBusy !== busy) {
            write.innerHTML = busy ? STOP_ICON : GHOSTWRITING_ICON;
            lastBusy = busy;
        }
        const label = writeLabel();
        write.title = label;
        write.setAttribute('aria-label', label);
        write.classList.toggle('ghostwriting-busy', busy);
        write.setAttribute('aria-expanded', String(!list.hidden));
        undo.hidden = session.selected < 0;
        undo.setAttribute('aria-disabled', String(busy));
        const statusText = busy ? '작성 중입니다. 깃펜 자리의 버튼으로 취소할 수 있습니다.'
            : session.selected >= 0 ? `${session.versions.length}개 결과 중 ${session.selected + 1}번째 결과` : '';
        if (status.textContent !== statusText) status.textContent = statusText;
    }

    function positionList() {
        if (list.hidden) return;
        const rect = write.getBoundingClientRect();
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft || 0;
        const top = viewport?.offsetTop || 0;
        const width = viewport?.width || window.innerWidth;
        const height = viewport?.height || window.innerHeight;
        const above = Math.min(rect.top, top + height) - top - 18;
        list.style.width = `${Math.min(420, Math.max(0, width - 16))}px`;
        list.style.maxHeight = `${Math.max(0, above >= 120 ? Math.min(above, height - 16) : height - 16)}px`;
        list.style.left = `${Math.max(left + 8, Math.min(rect.right - list.offsetWidth, left + width - list.offsetWidth - 8))}px`;
        list.style.top = `${Math.max(top + 8, Math.min(rect.top - list.offsetHeight - 10, top + height - list.offsetHeight - 8))}px`;
    }

    function renderResult() {
        resultTitle.textContent = `재작성 · ${viewedIndex + 1}`;
        preview.textContent = session.versions[viewedIndex];
        preview.scrollTop = 0;
        previous.disabled = next.disabled = session.versions.length < 2;
        const nextIndex = session.nextVersionIndex() + 1;
        heading.textContent = session.versions.length === MAX_VERSIONS
            ? `깃펜을 다시 누르면 재작성 · ${nextIndex}을 덮어씁니다. (최대 ${MAX_VERSIONS}개)`
            : `깃펜을 다시 누르면 재작성 · ${nextIndex}을 만듭니다. (최대 ${MAX_VERSIONS}개)`;
        apply.textContent = viewedIndex === session.selected ? '입력창에 적용됨 · 닫기' : '입력창에 적용';
        positionList();
    }

    function browseResult(direction) {
        viewedIndex = (viewedIndex + direction + session.versions.length) % session.versions.length;
        renderResult();
    }

    function showList() {
        viewedIndex = session.selected >= 0 ? session.selected : Math.max(0, session.latestIndex);
        list.hidden = false;
        renderResult();
        render();
    }

    function lock() {
        const readOnly = editor.readOnly;
        const ariaDisabled = send.getAttribute('aria-disabled');
        editor.readOnly = true;
        send.setAttribute('aria-disabled', 'true');
        send.classList.add('ghostwriting-send-locked');
        unlock = () => {
            editor.readOnly = readOnly;
            if (ariaDisabled === null) send.removeAttribute('aria-disabled');
            else send.setAttribute('aria-disabled', ariaDisabled);
            send.classList.remove('ghostwriting-send-locked');
            unlock = () => {};
        };
    }

    async function generate() {
        if (!settings.enabled) return;
        if (host.isGenerating()) return host.notify('채팅 응답이 끝난 뒤 작성해 주세요.', 'warning');
        if (!editor.value.trim()) return host.notify('한글 원문을 입력해 주세요.', 'info');
        if (settings.profileId !== MAIN_API_PROFILE_ID && !host.profiles().some(p => p.id === settings.profileId)) {
            host.notify('확장 설정 → Ghostwriting에서 변환용 연결 프로필을 선택해 주세요.', 'warning');
            return;
        }
        let data;
        try { data = host.getContextData(settings.recentCount); } catch (error) { host.notify(error.message, 'warning'); return; }
        const inputBefore = editor.value;
        let messages;
        try {
            const prepared = new DraftSession(session.snapshot());
            const draft = prepared.prepare(inputBefore);
            messages = buildMessages({ settings, ...data, ...draft });
        } catch (error) {
            host.notify(error.message, 'warning');
            return;
        }
        const deferDraftReset = session.isNewDraft(inputBefore) && Boolean(session.original);
        if (!deferDraftReset) session.prepare(inputBefore);
        const profile = settings.profileId;
        const outputLanguage = settings.outputLanguage;
        const controller = new AbortController();
        request = controller;
        persist();
        closeList();
        lock();
        render();
        try {
            const result = await completeRequest(() => host.request(profile, messages, controller.signal), controller.signal);
            if (!active || request !== controller) return;
            if (editor.value !== inputBefore) {
                session.edit(editor.value);
                host.notify('작성 중 입력창이 바뀌어 결과를 적용하지 않았습니다.', 'warning');
                return;
            }
            if (deferDraftReset) session.prepare(inputBefore);
            setInput(session.accept(result, outputLanguage));
            persist();
        } catch (error) {
            if (active && !controller.signal.aborted) {
                host.notify(`작성하지 못했습니다. 입력문은 그대로 유지됩니다. ${error.cause?.message || error.message || '연결 상태를 확인해 주세요.'}`, 'error');
            }
        } finally {
            if (request === controller) {
                request = null;
                unlock();
                if (active) { render(); persist(); }
            }
        }
    }

    async function onWrite(event) {
        if (request) { request.abort(); return; }
        if (session.original && editor.value !== session.input) session.start(editor.value);
        else session.edit(editor.value);
        if (session.versions.length && !session.isNewDraft(editor.value) && list.hidden) {
            showList();
            if (event?.detail === 0) preview.focus({ preventScroll: true });
            persist();
            return;
        }
        await generate();
    }

    function restore() {
        if (!session.original) return;
        if (!editor.value || editor.value === session.input) setInput(session.input);
        else session.start(editor.value);
        render();
    }

    function clearDraft() {
        request?.abort();
        session.clear();
        closeList();
        persist();
        render();
    }

    function listen(target, event, handler, capture = false) {
        target.addEventListener(event, handler, { signal: lifetime.signal, capture });
    }

    listen(write, 'click', onWrite);
    for (const control of [write, undo]) listen(control, 'keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (!event.repeat) control.click();
        }
    });
    listen(undo, 'click', () => {
        if (request) return;
        session.edit(editor.value);
        commit(session.select(-1));
    });
    listen(editor, 'input', event => {
        if (internalEdit || editor.value === session.input) return;
        // 다른 확장이 작성 도중 입력을 바꾸면 해당 요청을 중단하고 새 입력을 보존한다.
        if (request) request.abort();
        if (!editor.value.trim()) { clearDraft(); return; }
        if (!event.isTrusted && session.original) session.start(editor.value);
        else session.edit(editor.value);
        closeList();
        render();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
    });
    listen(editor, 'beforeinput', event => {
        if (internalEdit || request || !editor.value.length) return;
        if (event.inputType?.startsWith('insert') && editor.selectionStart === 0 && editor.selectionEnd === editor.value.length) {
            clearDraft();
        }
    });
    listen(previous, 'click', () => browseResult(-1));
    listen(next, 'click', () => browseResult(1));
    listen(apply, 'click', () => {
        if (request) return;
        session.edit(editor.value);
        commit(session.select(viewedIndex));
    });
    listen(empty, 'click', () => {
        if (request) return;
        const original = session.original;
        clearDraft();
        setInput(original);
        editor.focus();
    });
    listen(preview, 'pointerdown', event => {
        if (event.isPrimary && event.button === 0) {
            swipeStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
            if (event.isTrusted && event.pointerType === 'touch') preview.setPointerCapture(event.pointerId);
        }
    });
    listen(preview, 'pointerup', event => {
        if (!swipeStart || swipeStart.id !== event.pointerId) return;
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * SWIPE_RATIO) browseResult(dx < 0 ? 1 : -1);
    });
    listen(preview, 'pointercancel', () => { swipeStart = null; });
    listen(document, 'pointerdown', event => {
        if (!list.hidden && !list.contains(event.target) && !controls.contains(event.target)) { closeList(); render(); }
    });
    listen(list, 'keydown', event => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Home' || event.key === 'End') {
                viewedIndex = event.key === 'Home' ? 0 : session.versions.length - 1;
                renderResult();
            } else browseResult(event.key === 'ArrowRight' ? 1 : -1);
        } else if (event.key === 'Enter' && event.target === preview) {
            event.preventDefault();
            apply.click();
        }
    });
    listen(document, 'keydown', event => {
        const inGhostwriting = event.target === editor || event.target === send || controls.contains(event.target) || list.contains(event.target);
        if (event.key === 'Escape' && inGhostwriting) {
            if (request) { request.abort(); event.preventDefault(); event.stopImmediatePropagation(); }
            else if (!list.hidden) { event.preventDefault(); event.stopPropagation(); closeList(); render(); write.focus(); }
        }
        if (request && event.key === 'Enter' && (event.target === editor || event.target === send)) {
            event.preventDefault(); event.stopImmediatePropagation();
        }
    }, true);
    listen(document, 'click', event => {
        if (request && event.target.closest('#send_but')) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    listen(document, 'submit', event => {
        if (request && event.target.closest('#send_form')) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    listen(window, 'resize', positionList);
    if (window.visualViewport) {
        listen(window.visualViewport, 'resize', positionList);
        listen(window.visualViewport, 'scroll', positionList);
    }
    listen(window, 'pagehide', persist);
    listen(window, 'storage', event => {
        if (event.key === draftKey && event.newValue === null) {
            request?.abort(); session.clear(); closeList(); render();
        }
    });
    listen(openSettingsButton, 'click', openQuickSettings);
    disposers.push(host.on('MESSAGE_SENT', messageId => {
        const sentText = host.sentMessageText(messageId);
        if (!editor.value.trim() || (typeof sentText === 'string' && sentText.trim() === session.input.trim())) clearDraft();
    }));
    for (const event of ['CHAT_CHANGED', 'PERSONA_CHANGED']) disposers.push(host.on(event, () => {
        if (request) {
            request.abort();
            host.notify('채팅 또는 페르소나가 바뀌어 작성을 취소했습니다. 입력문을 유지합니다.');
        }
        closeList(); render(); updatePersona();
    }));
    disposers.push(host.on('GENERATION_STARTED', (type, _params, dryRun) => {
        if (request && type !== 'quiet' && !dryRun) {
            request.abort();
            host.notify('채팅 응답 생성이 시작되어 Ghostwriting 작성을 취소했습니다. 입력문을 유지합니다.');
        }
    }));
    disposers.push(host.on('PERSONA_DELETED', value => {
        delete settings.personaInstructions[value.avatarId];
        saveSettings();
    }));
    for (const event of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        disposers.push(host.on(event, () => updateProfiles()));
    }

    function updateProfiles() {
        const select = panelView.querySelector('#ghostwriting-profile');
        if (!select) return;
        select.replaceChildren(new Option('연결 프로필을 선택하세요', ''), new Option('메인 API 사용', MAIN_API_PROFILE_ID));
        const profiles = host.profiles();
        profiles.forEach(profile => select.add(new Option(profile.name, profile.id)));
        if (settings.profileId && settings.profileId !== MAIN_API_PROFILE_ID && !profiles.some(p => p.id === settings.profileId)) select.add(new Option('사용할 수 없는 프로필 — 다시 선택하세요', settings.profileId));
        select.value = settings.profileId;
    }

    function updatePersona() {
        if (!quickView) return;
        const persona = host.getPersona();
        quickView.querySelector('#ghostwriting-persona-name').textContent = persona.name || '현재 페르소나';
        const field = quickView.querySelector('#ghostwriting-extra');
        field.dataset.persona = persona.id;
        field.value = settings.personaInstructions[persona.id] || '';
    }

    function updatePresets() {
        const select = panelView.querySelector('#ghostwriting-preset');
        select.replaceChildren(...settings.presets.map(p => new Option(p.name, p.id)));
        select.value = settings.activePreset;
        panelView.querySelector('#ghostwriting-prompt').value = getActivePreset(settings)?.prompt || DEFAULT_PROMPT;
        panelView.querySelector('[data-action="delete"]').disabled = settings.activePreset === 'default';
    }

    function initializeSettings() {
        const view = panelView;
        updateProfiles(); updatePresets();
        view.querySelector('#ghostwriting-enabled').checked = settings.enabled;
        view.querySelector('#ghostwriting-output-language').value = settings.outputLanguage;
        view.addEventListener('input', event => {
            const field = event.target;
            if (field.id === 'ghostwriting-prompt') getActivePreset(settings).prompt = field.value;
            saveSettings();
        }, { signal: lifetime.signal });
        view.addEventListener('change', event => {
            const field = event.target;
            if (field.id === 'ghostwriting-enabled') {
                settings.enabled = field.checked;
                if (!settings.enabled) request?.abort();
                render();
            }
            if (field.id === 'ghostwriting-profile') settings.profileId = field.value;
            if (field.id === 'ghostwriting-output-language') { settings.outputLanguage = normalizeLanguage(field.value); render(); }
            if (field.id === 'ghostwriting-preset') { settings.activePreset = field.value; updatePresets(); }
            saveSettings();
        }, { signal: lifetime.signal });
        view.addEventListener('click', async event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action) return;
            const preset = getActivePreset(settings);
            if (action === 'copy' || action === 'rename') {
                const name = (await host.askName(action === 'copy' ? `${preset.name} 복사본` : preset.name))?.trim();
                if (!active || !name) return;
                if (settings.presets.some(p => p.name === name && (action === 'copy' || p.id !== preset.id))) {
                    host.notify('같은 이름의 프리셋이 있습니다.', 'warning');
                    return;
                }
                if (action === 'copy') {
                    const id = globalThis.crypto?.randomUUID?.() || `preset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const copy = { id, name, prompt: preset.prompt };
                    settings.presets.push(copy); settings.activePreset = copy.id;
                } else preset.name = name;
            }
            if (action === 'delete' && preset.id !== 'default') {
                if (!await host.confirm('선택한 프롬프트 프리셋을 삭제할까요?') || !active) return;
                settings.presets = settings.presets.filter(p => p.id !== preset.id);
                settings.activePreset = 'default';
            }
            if (action === 'reset') {
                if (!await host.confirm('현재 프리셋의 문안을 처음 제공한 프롬프트로 복원할까요?') || !active) return;
                preset.prompt = DEFAULT_PROMPT;
            }
            saveSettings(); updatePresets();
        }, { signal: lifetime.signal });
    }

    async function openQuickSettings() {
        if (quickPopup || !settings.enabled) return;
        const template = document.createElement('template');
        template.innerHTML = quickHtml;
        const view = template.content.querySelector('.ghostwriting-quick-settings');
        if (!view) return host.notify('Ghostwriting 설정을 열지 못했습니다.', 'error');
        quickView = view;
        quickLife = new AbortController();
        view.querySelector('#ghostwriting-mode').value = settings.mode;
        view.querySelector('#ghostwriting-length').value = settings.length;
        view.querySelector('#ghostwriting-count').value = settings.recentCount;
        view.querySelector('#ghostwriting-count').max = MAX_RECENT_MESSAGES;
        updatePersona();
        view.addEventListener('input', event => {
            const field = event.target;
            if (field.id === 'ghostwriting-extra') {
                if (field.value) settings.personaInstructions[field.dataset.persona] = field.value;
                else delete settings.personaInstructions[field.dataset.persona];
            }
            if (field.id === 'ghostwriting-count' && field.validity.valid && field.value !== '') settings.recentCount = Number(field.value);
            saveSettings();
        }, { signal: quickLife.signal });
        view.addEventListener('change', event => {
            const field = event.target;
            if (field.id === 'ghostwriting-mode') settings.mode = field.value;
            if (field.id === 'ghostwriting-length') settings.length = field.value;
            if (field.id === 'ghostwriting-count') {
                settings.recentCount = field.value === '' ? settings.recentCount : normalizeRecentCount(field.value);
                field.value = settings.recentCount;
            }
            saveSettings();
        }, { signal: quickLife.signal });
        try {
            quickPopup = host.showPanel(view);
            await quickPopup.done;
        }
        finally {
            quickLife.abort();
            quickLife = null;
            quickPopup = null;
            quickView = null;
        }
    }

    function dispose() {
        if (!active) return;
        persist();
        active = false;
        request?.abort();
        request = null;
        unlock();
        lifetime.abort();
        quickLife?.abort();
        clearTimeout(saveTimer);
        disposers.forEach(off => off());
        void quickPopup?.close();
        controls.remove(); list.remove(); panelView.remove(); menuEntry.remove();
    }

    try {
        initializeSettings();
        restore();
        render();
    } catch (error) {
        dispose();
        throw error;
    }
    return {
        clearData() {
            cleared = true;
            session.clear();
            localStorage.removeItem(draftKey);
            host.removeSettings();
        },
        dispose,
    };
}
