const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadTs(file, dependencies = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', outputText)(name => {
        if (name in dependencies) return dependencies[name];
        throw new Error(`Unexpected dependency: ${name}`);
    }, module, module.exports);
    return module.exports;
}

function harness() {
    const persisted = [];
    const noop = () => {};
    const db = new Proxy({}, { get: (_, name) => name === 'dbPutSessions' || name === 'dbReplaceSessions'
        ? sessions => persisted.push(structuredClone(sessions)) : noop });
    const storage = loadTs('lib/chat-storage.ts', {
        './chat-db': db,
        './settings-storage': { resolveUserIdentity: () => ({ name: '用户' }) },
        './character-storage': { loadCharacters: () => [] },
        './kv-db': { kvGet: () => null, kvSet: noop, registerKvMigration: noop },
        './chat-plugin-hooks': { emitChatPluginEvent: noop, runChatPluginTransformSync: (_, payload) => payload },
        './rich-message-parser': { parseAIResponse: () => ({ parts: [] }) },
        './text-tool-protocol': { extractTextToolDirectiveText: () => '' },
    });
    const context = loadTs('lib/chat-relationship-context.ts');
    const state = { calls: [], response: '{"remark":"小麻烦"}', resolve: null, pending: false, cancelled: 0 };
    const relationship = loadTs('lib/chat-relationship.ts', {
        './chat-storage': storage,
        './follow-up-service': { cancelBackgroundGeneration: () => state.cancelled++, cancelFollowUp: noop },
        './chat-engine': {
            buildChatPromptMessages: async session => ({
                llmMessages: [{ role: 'system', content: context.buildChatRelationshipContext(session) }],
                config: {}, preset: null, character: { name: '角色' }, userIdentity: { name: '用户' },
            }),
            sendLLMRequest: async (...args) => {
                state.calls.push(args);
                if (state.pending) return new Promise(resolve => { state.resolve = resolve; });
                return state.response;
            },
        },
    });
    const session = storage.createOrGetSession('character-1');
    return { storage, relationship, context, state, session, persisted };
}

async function untilRequested(state) {
    for (let i = 0; i < 10 && !state.resolve; i++) await Promise.resolve();
    assert.ok(state.resolve, 'request must have reached API');
}

test('private reasons stay out of chat and model context; sharing is explicit', () => {
    const { storage, relationship, context, session } = harness();
    relationship.setChatBlocked(session.id, true, '私密原因：不想说', false);
    const current = relationship.getRelationshipSession(session.id);
    assert.doesNotMatch(context.buildChatRelationshipContext(current), /私密原因/);
    assert.ok(storage.loadChatMessages(session.id).every(item => !item.content.includes('私密原因')));
    assert.match(context.buildChatRelationshipContext({ ...current, shareBlockReason: true }), /私密原因/);
    assert.equal(context.buildChatRelationshipContext({ ...current, isGroup: true }), '');
});

test('in-flight replies are persisted only in blocked inbox, with normal history and preview retained', () => {
    const { storage, relationship, session, persisted } = harness();
    const original = storage.pushChatMessage({ sessionId: session.id, role: 'user', content: '你好' });
    relationship.setChatBlocked(session.id, true);
    const preview = relationship.getRelationshipSession(session.id).lastMessagePreview;
    const reply = storage.pushChatMessage({ sessionId: session.id, role: 'assistant', content: '还在吗？' });
    assert.equal(reply.isBlockedReaction, true);
    assert.ok(storage.loadChatMessages(session.id).some(item => item.id === original.id));
    assert.ok(!storage.loadChatMessages(session.id).some(item => item.id === reply.id));
    assert.equal(relationship.getRelationshipSession(session.id).lastMessagePreview, preview);
    assert.equal(persisted.at(-1)[0].blockedInbox[0].content, '还在吗？');
    relationship.setChatBlocked(session.id, false);
    storage.pushChatMessage({ sessionId: session.id, role: 'assistant', content: '现在可以发了' });
    assert.equal(storage.loadChatMessages(session.id).at(-1).content, '现在可以发了');
    assert.equal(relationship.getRelationshipSession(session.id).blockedInbox.length, 1);
});

test('receiving reactions preserves block and avoids duplicate requests without new context', async () => {
    const { relationship, state, session, storage } = harness();
    relationship.setChatBlocked(session.id, true);
    state.response = '{"messages":["为什么发不出去了？","为什么发不出去了？"]}';
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'reaction'), true);
    assert.equal(relationship.getRelationshipSession(session.id).isBlacklisted, true);
    assert.equal(relationship.getRelationshipSession(session.id).blockedInbox.length, 1);
    assert.ok(!storage.loadChatMessages(session.id).some(item => item.role === 'assistant'));
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'reaction'), false);
    assert.equal(state.calls.length, 1);
});

test('a character can remain silent and silence is remembered', async () => {
    const { relationship, state, session } = harness();
    relationship.setChatBlocked(session.id, true);
    state.response = '{"messages":[]}';
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'reaction'), false);
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'reaction'), false);
    assert.equal(state.calls.length, 1);
});

test('remark refresh uses custom rules and saves only actual changes in history', async () => {
    const { storage, relationship, state, session } = harness();
    storage.updateChatRelationship(session.id, { characterRemarkRules: '生气时可用负面备注' });
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'remark'), true);
    assert.match(state.calls[0][2].at(-1).content, /生气时可用负面备注/);
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'remark'), false);
    assert.equal(relationship.getRelationshipSession(session.id).characterRemarkHistory.length, 1);
    state.response = '{"remark":"名字全称"}';
    assert.equal(await relationship.generateRelationshipUpdate(session.id, 'remark'), true);
    assert.equal(relationship.getRelationshipSession(session.id).characterRemarkHistory.length, 2);
    assert.ok(relationship.getRelationshipSession(session.id).characterRemarkUpdatedAt);
});

test('malformed results leave prior data unchanged and can be retried', async () => {
    const { relationship, state, session } = harness();
    await relationship.generateRelationshipUpdate(session.id, 'remark');
    state.response = '{"remark":""}';
    await assert.rejects(relationship.generateRelationshipUpdate(session.id, 'remark'), /格式/);
    assert.equal(relationship.getRelationshipSession(session.id).characterRemark, '小麻烦');
    state.response = '{"remark":"和好了"}';
    await relationship.generateRelationshipUpdate(session.id, 'remark');
    assert.equal(relationship.getRelationshipSession(session.id).characterRemark, '和好了');
    relationship.setChatBlocked(session.id, true);
    state.response = '{"messages":[42]}';
    await assert.rejects(relationship.generateRelationshipUpdate(session.id, 'reaction'), /格式/);
    assert.equal(relationship.getRelationshipSession(session.id).blockReactionKey, undefined);
});

test('unblocking aborts an in-flight reaction and stale results cannot restore block or inbox', async () => {
    const { relationship, state, session } = harness();
    relationship.setChatBlocked(session.id, true);
    state.pending = true;
    const request = relationship.generateRelationshipUpdate(session.id, 'reaction');
    await untilRequested(state);
    relationship.setChatBlocked(session.id, false);
    state.resolve('{"messages":["过时的回复"]}');
    await assert.rejects(request, error => error.name === 'AbortError');
    assert.equal(relationship.getRelationshipSession(session.id).isBlacklisted, false);
    assert.equal(relationship.getRelationshipSession(session.id).blockedInbox, undefined);
});

test('concurrent clicks are rejected and new chat context invalidates pending remarks', async () => {
    const { storage, relationship, state, session } = harness();
    state.pending = true;
    const request = relationship.generateRelationshipUpdate(session.id, 'remark');
    await untilRequested(state);
    await assert.rejects(relationship.generateRelationshipUpdate(session.id, 'remark'), /等待/);
    storage.pushChatMessage({ sessionId: session.id, role: 'user', content: '新的聊天' });
    state.resolve('{"remark":"旧备注"}');
    await assert.rejects(request, /状态已变化/);
    assert.equal(relationship.getRelationshipSession(session.id).characterRemark, undefined);
});

test('deleting a session during generation cannot recreate it', async () => {
    const { storage, relationship, state, session } = harness();
    state.pending = true;
    const request = relationship.generateRelationshipUpdate(session.id, 'remark');
    await untilRequested(state);
    storage.deleteChatSession(session.id);
    state.resolve('{"remark":"旧备注"}');
    await assert.rejects(request, /仅支持单人聊天/);
    assert.equal(storage.loadChatSessions().length, 0);
});

test('cloud-imported blocked replies stay archived even if replayed after unblocking', () => {
    const { storage, relationship, session } = harness();
    relationship.setChatBlocked(session.id, true);
    const message = { id: 'cloud-reply', sessionId: session.id, role: 'assistant', content: '云端在途回复', status: 'sent', createdAt: new Date().toISOString() };
    assert.equal(storage.upsertImportedChatMessage(message).inserted, false);
    assert.equal(storage.upsertImportedChatMessage(message).inserted, false);
    assert.equal(relationship.getRelationshipSession(session.id).blockedInbox.length, 1);
    relationship.setChatBlocked(session.id, false);
    assert.equal(storage.upsertImportedChatMessage(message).inserted, false);
    assert.ok(!storage.loadChatMessages(session.id).some(item => item.id === message.id));
});

test('group conversations cannot be blacklisted through relationship controls', () => {
    const { storage, relationship } = harness();
    const group = storage.createGroupSession('群聊', ['character-1']);
    assert.throws(() => relationship.setChatBlocked(group.id, true), /仅支持单人聊天/);
    storage.pushChatMessage({ sessionId: group.id, role: 'assistant', content: '群聊正常回复' });
    assert.equal(storage.loadChatMessages(group.id).at(-1).content, '群聊正常回复');
});

test('editing existing chat text invalidates a pending remark even if the message ID is unchanged', async () => {
    const { storage, relationship, state, session } = harness();
    const message = storage.pushChatMessage({ sessionId: session.id, role: 'user', content: '我生气了' });
    state.pending = true;
    const request = relationship.generateRelationshipUpdate(session.id, 'remark');
    await untilRequested(state);
    storage.editChatMessage(message.id, '已经和好了');
    state.resolve('{"remark":"旧备注"}');
    await assert.rejects(request, /状态已变化/);
    assert.equal(relationship.getRelationshipSession(session.id).characterRemark, undefined);
});


test('reopening details renders the latest saved remark and rules even with an older session prop', async () => {
    const { storage, relationship, session } = harness();
    const staleSession = { ...session };
    storage.updateChatRelationship(session.id, { characterRemarkRules: '生气时用名字全称' });
    await relationship.generateRelationshipUpdate(session.id, 'remark');
    const { ChatRelationshipPanel } = loadTs('components/chat/chat-relationship-panel.tsx', {
        'react': require('react'),
        'react/jsx-runtime': require('react/jsx-runtime'),
        '@/lib/chat-storage': storage,
        '@/lib/chat-relationship': relationship,
    });
    const html = require('react-dom/server').renderToStaticMarkup(require('react').createElement(ChatRelationshipPanel, { session: staleSession }));
    assert.match(html, /小麻烦/);
    assert.match(html, /生气时用名字全称/);
    assert.match(html, /拉黑此联系人/);
});
