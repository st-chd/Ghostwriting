import { amount_gen, max_context, createRawPrompt, getGenerateUrl, getRequestHeaders } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { sendOpenAIRequest } from '../../../openai.js';
import { getTextGenGenerationData } from '../../../textgen-settings.js';
import { kai_settings, koboldai_settings, koboldai_setting_names, getKoboldGenerationData } from '../../../kai-settings.js';
import { nai_settings, novelai_settings, novelai_setting_names, getNovelGenerationData } from '../../../nai-settings.js';
import { generateHorde } from '../../../horde.js';
import { describeError } from './core.js';

async function responseErrorDetail(response) {
    let body;
    try { body = await response.clone().json(); }
    catch {
        try { body = await response.text(); } catch { body = ''; }
    }
    return describeError(body);
}

export async function requestMainApi(api, messages, signal) {
    signal.throwIfAborted();
    const context = getContext();
    let prompt = createRawPrompt(structuredClone(messages), api, false, false, '', '');
    if (Array.isArray(prompt)) {
        const eventData = { chat: prompt, dryRun: false };
        await context.eventSource.emit(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, eventData);
        prompt = eventData.chat;
    } else {
        const eventData = { prompt, dryRun: false };
        await context.eventSource.emit(context.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, eventData);
        prompt = eventData.prompt;
    }
    signal.throwIfAborted();

    // generateRawData는 외부 취소 신호를 받지 않으므로 동일한 생성 경로에 요청별 신호를 직접 전달한다.
    if (api === 'openai') return sendOpenAIRequest('quiet', prompt, signal);

    let payload;
    switch (api) {
        case 'textgenerationwebui':
            payload = await getTextGenGenerationData(prompt, amount_gen, false, false, null, 'quiet');
            break;
        case 'kobold':
        case 'koboldhorde':
            payload = kai_settings.preset_settings === 'gui'
                ? { prompt, gui_settings: true, max_length: amount_gen, max_context_length: max_context, api_server: kai_settings.api_server }
                : getKoboldGenerationData(prompt, koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]], amount_gen, max_context, api === 'koboldhorde', 'quiet');
            break;
        case 'novel':
            payload = getNovelGenerationData(prompt, novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]], amount_gen, false, false, null, 'quiet');
            break;
        default:
            throw new Error('지원하는 메인 API를 선택해 주세요.');
    }
    signal.throwIfAborted();
    if (api === 'koboldhorde') return generateHorde(prompt, payload, signal, false);
    const response = await fetch(getGenerateUrl(api), {
        method: 'POST', headers: getRequestHeaders(), cache: 'no-cache', body: JSON.stringify(payload), signal,
    });
    if (!response.ok) {
        const detail = await responseErrorDetail(response);
        throw new Error(`메인 API 요청에 실패했습니다 (${response.status})${detail ? `: ${detail}` : ''}.`);
    }
    return response.json();
}
