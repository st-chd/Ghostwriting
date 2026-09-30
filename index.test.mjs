import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('export function', 'function')
    .replace('import.meta.url', JSON.stringify('http://localhost/scripts/extensions/third-party/Ghostwriting/index.js'));

function createRuntime() {
    const listeners = new Set();
    const pending = [];
    const apps = [];
    const errors = [];
    const context = {
        eventTypes: { APP_READY: 'ready' },
        eventSource: {
            on: (_type, callback) => listeners.add(callback),
            removeListener: (_type, callback) => listeners.delete(callback),
        },
        extensionSettings: {},
    };
    const runtime = vm.createContext({
        URL,
        console,
        document: { querySelector: () => ({}) },
        getContext: () => context,
        getCurrentUserHandle: () => 'test-user',
        isGenerating: () => false,
        toastr: { error: text => errors.push(text) },
        renderExtensionTemplateAsync: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        createGhostwritingApp: () => {
            const app = { disposed: false, dispose() { this.disposed = true; } };
            apps.push(app);
            return app;
        },
    });
    vm.runInContext(source, runtime);
    return {
        run: code => vm.runInContext(code, runtime),
        ready: () => Promise.all([...listeners].map(callback => callback())),
        pending, apps, errors, listeners,
    };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

for (const newerFirst of [false, true]) {
    test(`로딩 중 껐다 켜도 현재 활성화만 생성한다 (${newerFirst ? '새 로딩' : '이전 로딩'} 먼저 완료)`, async () => {
        const runtime = createRuntime();
        runtime.run('init(); dispose(); init(); init();');
        assert.equal(runtime.pending.length, 4);
        assert.equal(runtime.listeners.size, 1);
        const ready = runtime.ready();
        assert.equal(runtime.pending.length, 4);
        const first = newerFirst ? 2 : 0;
        runtime.pending[first].resolve('settings');
        runtime.pending[first + 1].resolve('quick-settings');
        await flush();
        assert.equal(runtime.apps.length, newerFirst ? 1 : 0);
        const second = newerFirst ? 0 : 2;
        runtime.pending[second].resolve('settings');
        runtime.pending[second + 1].resolve('quick-settings');
        await ready;
        await flush();
        assert.equal(runtime.apps.length, 1);
        assert.deepEqual(runtime.errors, []);
        await runtime.ready();
        assert.equal(runtime.pending.length, 4);
        runtime.run('dispose();');
        assert.equal(runtime.apps[0].disposed, true);
        assert.equal(runtime.listeners.size, 0);
    });
}

test('비활성화한 로딩은 앱이나 오류 알림을 남기지 않는다', async () => {
    const runtime = createRuntime();
    runtime.run('init(); dispose();');
    runtime.pending[0].reject(new Error('cancelled activation'));
    runtime.pending[1].resolve('quick-settings');
    await flush();
    assert.equal(runtime.apps.length, 0);
    assert.deepEqual(runtime.errors, []);
    assert.equal(runtime.listeners.size, 0);
});
