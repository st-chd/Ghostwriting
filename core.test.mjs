import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    DEFAULT_PROMPT, PAST_DEFAULT_PROMPTS, DraftSession, buildMessages, completeRequest,
    normalizeRecentCount, normalizeSettings,
} from './core.js';

test('배포된 기본 프롬프트만 최신 문안으로 이관한다', () => {
    const hashes = [...PAST_DEFAULT_PROMPTS].map(prompt => createHash('sha256').update(prompt).digest('hex'));
    assert.deepEqual(hashes, [
        'ee7c61d96cfebc6daa76110431e1d4ef2c1ad36159f582a325d7589ca81915fb',
        '694ada99b13e1687782823e1558f7009cb22f57692520865396471947a84bc00',
    ]);
    for (const prompt of PAST_DEFAULT_PROMPTS) {
        const settings = normalizeSettings({ presets: [{ id: 'default', name: '기본', prompt }] });
        assert.equal(settings.presets[0].prompt, DEFAULT_PROMPT);
    }
    const customized = normalizeSettings({ presets: [{ id: 'default', name: '기본', prompt: '내 프롬프트' }] });
    assert.equal(customized.presets[0].prompt, '내 프롬프트');
});

test('최근 대화 수의 비어 있는 저장값은 기본값을 사용한다', () => {
    assert.equal(normalizeRecentCount(null), 10);
    assert.equal(normalizeRecentCount(''), 10);
    assert.equal(normalizeRecentCount(undefined), 10);
    assert.equal(normalizeRecentCount(0), 0);
});

test('선택한 결과는 순환 버퍼가 덮어쓰지 않는다', () => {
    const session = new DraftSession();
    session.prepare('한글 원문');
    session.accept('one');
    session.accept('two');
    session.accept('three');
    session.select(0);
    session.edit('hand edited one');
    assert.equal(session.nextVersionIndex(), 1);
    session.accept('four');
    assert.deepEqual(session.versions, ['hand edited one', 'four', 'three']);
    assert.equal(session.selected, 1);
    assert.equal(session.latestIndex, 1);
});

test('오래된 초안의 선택 인덱스와 최신 인덱스를 함께 이관한다', () => {
    const session = new DraftSession({
        schema: 1, original: '원문', versions: ['a', 'b', 'c', 'd', 'e'],
        selected: 4, latestIndex: 4, input: 'e',
    });
    assert.deepEqual(session.versions, ['a', 'b', 'e']);
    assert.equal(session.selected, 2);
    assert.equal(session.latestIndex, 2);
});

test('새 입력은 이전 초안의 버전을 수정하지 않는다', () => {
    const session = new DraftSession();
    session.prepare('첫 원문');
    session.accept('first version');
    session.start('새 원문');
    assert.deepEqual(session.prepare('새 원문'), { original: '새 원문', previous: '' });
    assert.deepEqual(session.versions, []);
});

test('메시지 구성은 원문과 최근 대화만 포함한다', () => {
    const settings = normalizeSettings({ recentCount: 1 });
    const messages = buildMessages({
        settings, original: '초안', persona: { id: 'p', name: 'P', description: '' },
        character: { name: 'C' },
        chat: [{ is_user: true, mes: 'older' }, { is_user: false, mes: 'newer' }],
    });
    const source = JSON.parse(messages[1].content);
    assert.equal(source.korean_draft, '초안');
    assert.deepEqual(source.recent_conversation.map(message => message.text), ['newer']);
});

test('완료 요청은 빈 결과와 취소를 구분한다', async () => {
    await assert.rejects(completeRequest(() => ' ', new AbortController().signal), /비어 있는 응답/);
    const controller = new AbortController();
    const result = completeRequest(() => new Promise(() => {}), controller.signal);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
});
