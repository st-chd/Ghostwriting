import { extractMessageFromData, isGenerating } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { user_avatar } from '../../../personas.js';
import { getCurrentUserHandle } from '../../../user.js';
import { getPresetManager } from '../../../preset-manager.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SETTINGS_KEY, DRAFT_PREFIX, MAIN_API_PROFILE_ID, describeError, normalizeRecentCount, resolveTokenLimit } from './core.js';
import { createGhostwritingApp } from './app.js';

let app;
let readyListener;
let loading = false;
let activation = 0;
const fallbackNotified = new Set();
const extensionPath = (() => {
    const path = new URL('.', import.meta.url).pathname;
    const marker = '/scripts/extensions/';
    const index = path.lastIndexOf(marker);
    return index >= 0 ? decodeURIComponent(path.slice(index + marker.length).replace(/\/$/, '')) : 'third-party/Ghostwriting';
})();

function warnIfPossiblyTruncated(text, source, finish) {
    if (finish) return;
    if (typeof text !== 'string' || !text.trim()) return;
    const last = text.trim().at(-1);
    if (!/[.!?…。！？'"”’*_\])}]/u.test(last)) {
        globalThis.toastr?.warning(
            `${source} 응답이 문장 중간에서 끝났을 수 있습니다. 결과를 확인하고 필요하면 응답 길이를 늘려 다시 작성해 주세요.`,
            'Ghostwriting',
            { escapeHtml: true },
        );
    }
}

function extractCompletedMessage(raw, api, source) {
    const finish = raw?.choices?.[0]?.finish_reason ?? raw?.stop_reason ?? raw?.candidates?.[0]?.finishReason;
    if (raw?.error) {
        const detail = describeError(raw.error);
        throw new Error(`모델 서버가 오류를 반환했습니다${detail ? `: ${detail}` : ''}. 입력문을 유지합니다.`);
    }
    if (['length', 'max_tokens', 'MAX_TOKENS', 'content_filter', 'SAFETY'].includes(finish)) {
        throw new Error(`응답이 완성되기 전에 종료되었습니다. ${source}의 응답 길이 설정을 확인해 주세요. 입력문을 유지합니다.`);
    }
    const text = extractMessageFromData(raw, api);
    warnIfPossiblyTruncated(text, source, finish);
    return text;
}

function contextData(recentCount) {
    const context = getContext();
    if (context.groupId) throw new Error('Ghostwriting은 1:1 채팅에서 사용할 수 있습니다.');
    const card = context.characters[context.characterId];
    if (!card) throw new Error('먼저 대화할 캐릭터를 선택해 주세요.');
    const resolveMacros = value => context.substituteParams(String(value || ''), {
        name1Override: context.name1,
        name2Override: context.name2,
        replaceCharacterCard: false,
    });
    const chat = [];
    const count = normalizeRecentCount(recentCount);
    for (let index = context.chat.length - 1; index >= 0 && chat.length < count; index--) {
        const message = context.chat[index];
        if (!message?.is_system && typeof message?.mes === 'string' && message.mes.trim()) chat.push(message);
    }
    chat.reverse();
    return {
        persona: {
            id: user_avatar || '__default__',
            name: context.name1,
            description: resolveMacros(context.powerUserSettings.persona_description),
        },
        character: {
            name: context.name2,
            description: resolveMacros(card.description ?? card.data?.description),
            personality: resolveMacros(card.personality ?? card.data?.personality),
            scenario: resolveMacros(context.chatMetadata.scenario || card.scenario || card.data?.scenario),
            example_dialogue: resolveMacros(context.chatMetadata.mes_example || card.mes_example || card.data?.mes_example),
        },
        // 저장된 대화를 다시 매크로 평가하면 상태 변경 매크로가 재실행될 수 있다.
        chat,
    };
}

function makeHost() {
    const context = getContext();
    return {
        user: getCurrentUserHandle(),
        loadSettings: () => context.extensionSettings[SETTINGS_KEY],
        saveSettings: settings => {
            context.extensionSettings[SETTINGS_KEY] = settings;
            context.saveSettingsDebounced();
        },
        removeSettings: () => {
            delete context.extensionSettings[SETTINGS_KEY];
            context.saveSettingsDebounced();
        },
        getPersona: () => ({ id: user_avatar || '__default__', name: getContext().name1 }),
        sentMessageText: messageId => getContext().chat[messageId]?.mes,
        getContextData: contextData,
        isGenerating,
        on: (name, callback) => {
            const type = context.eventTypes[name];
            if (!type) { console.warn(`Ghostwriting: 지원되지 않는 SillyTavern 이벤트: ${name}`); return () => {}; }
            context.eventSource.on(type, callback);
            return () => context.eventSource.removeListener(type, callback);
        },
        profiles: () => {
            if (context.extensionSettings.disabledExtensions?.includes('connection-manager')) return [];
            return (context.extensionSettings.connectionManager?.profiles || []).filter(profile => {
                try { ConnectionManagerRequestService.validateProfile(profile); return true; } catch { return false; }
            }).map(({ id, name }) => ({ id, name }));
        },
        request: async (profileId, messages, signal) => {
            if (profileId === MAIN_API_PROFILE_ID) {
                signal.throwIfAborted();
                const api = getContext().mainApi;
                const { requestMainApi } = await import('./main-api.js');
                signal.throwIfAborted();
                const raw = await requestMainApi(api, messages, signal);
                signal.throwIfAborted();
                return extractCompletedMessage(raw, api, '메인 API');
            }
            const profile = ConnectionManagerRequestService.getProfile(profileId);
            const api = ConnectionManagerRequestService.validateProfile(profile).selected;
            const preset = profile.preset ? getPresetManager(api)?.getCompletionPresetByName(profile.preset) : null;
            if (profile.preset && !preset) throw new Error('연결 프로필의 생성 설정 프리셋을 찾을 수 없습니다. 프로필을 확인해 주세요.');
            const { maxTokens, usedFallback } = resolveTokenLimit(api, preset);
            if (usedFallback && !fallbackNotified.has(profileId)) {
                fallbackNotified.add(profileId);
                globalThis.toastr?.info('연결 프로필에 유효한 응답 길이가 없어 기본값 4,096토큰을 사용합니다.', 'Ghostwriting', { escapeHtml: true });
            }
            const raw = await ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {
                signal, stream: false, extractData: false, includePreset: true, includeInstruct: true,
            }, { n: 1 });
            // 잘린 결과를 정상 버전으로 보관하면 원문 손실처럼 보이므로 완료 상태도 확인한다.
            signal.throwIfAborted();
            return extractCompletedMessage(raw, api, '연결 프로필');
        },
        notify: (message, kind = 'info') => globalThis.toastr?.[kind]?.(message, 'Ghostwriting', { escapeHtml: true }),
        showPanel: element => {
            const popup = new context.Popup(element, context.POPUP_TYPE.TEXT, '', { okButton: '닫기', allowVerticalScrolling: true });
            return { done: popup.show(), close: () => popup.completeCancelled() };
        },
        confirm: async text => Boolean(await context.Popup.show.confirm('Ghostwriting', text)),
        askName: async initial => context.Popup.show.input('프롬프트 프리셋 이름', '', initial),
    };
}

export function init() {
    if (readyListener) return;
    readyListener = async () => {
        if (app || loading) return;
        loading = true;
        const currentActivation = activation;
        try {
            const [html, quickHtml] = await Promise.all([
                renderExtensionTemplateAsync(extensionPath, 'settings'),
                renderExtensionTemplateAsync(extensionPath, 'quick-settings'),
            ]);
            if (currentActivation !== activation) return;
            app = createGhostwritingApp(makeHost(), html, quickHtml);
        } catch (error) { globalThis.toastr?.error(error.message, 'Ghostwriting', { escapeHtml: true }); }
        finally { loading = false; }
    };
    const context = getContext();
    context.eventSource.on(context.eventTypes.APP_READY, readyListener);
    if (['#send_textarea', '#send_but', '#extensions_settings', '#extensionsMenu'].every(selector => document.querySelector(selector))) {
        void readyListener();
    }
}

export function dispose() {
    activation++;
    const context = getContext();
    if (readyListener) context.eventSource.removeListener(context.eventTypes.APP_READY, readyListener);
    readyListener = null;
    app?.dispose();
    app = null;
}

export function onClean() {
    const host = makeHost();
    if (app) app.clearData();
    else {
        host.removeSettings();
    }
    try {
        for (const key of Object.keys(localStorage)) if (key.startsWith(DRAFT_PREFIX)) localStorage.removeItem(key);
    } catch (error) { console.warn('Ghostwriting: 초안 저장소 정리 실패', error); }
    dispose();
}

export function onDelete() {
    onClean();
}
