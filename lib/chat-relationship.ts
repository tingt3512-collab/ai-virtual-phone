import { buildChatPromptMessages, sendLLMRequest } from "./chat-engine";
import {
    loadChatMessages, loadChatSessions, updateChatRelationship,
    pushChatMessage, clearFollowUpSchedule, type ChatSession, type ChatMessage,
} from "./chat-storage";
import { cancelBackgroundGeneration, cancelFollowUp } from "./follow-up-service";

const requests = new Map<string, AbortController>();

function getHistoryKey(history: ChatMessage[]): string {
    const text = JSON.stringify(history.slice(-40).map(item => [item.id, item.role, item.content, item.isRetracted]));
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${history.length}:${text.length}:${hash >>> 0}`;
}

export function getRelationshipSession(sessionId: string): ChatSession {
    const session = loadChatSessions().find(item => item.id === sessionId);
    if (!session || session.isGroup) throw new Error("该功能仅支持单人聊天");
    return session;
}

export function setChatBlocked(sessionId: string, blocked: boolean, reason = "", shareReason = false): void {
    const session = getRelationshipSession(sessionId);
    if (!!session.isBlacklisted === blocked) return;
    requests.get(sessionId)?.abort();
    cancelFollowUp(sessionId);
    cancelBackgroundGeneration(sessionId);
    clearFollowUpSchedule(sessionId);
    updateChatRelationship(sessionId, {
        isBlacklisted: blocked,
        ...(blocked ? {
            blockedAt: new Date().toISOString(), blockReason: reason.trim().slice(0, 500),
            shareBlockReason: shareReason, blockReactionKey: undefined,
        } : {}),
    });
    // 私密原因不写入聊天历史，以免随上下文泄漏给模型。
    pushChatMessage({ sessionId, role: "system", content: blocked ? "你已将对方拉黑" : "你已解除拉黑" });
}

/** 同一会话同一时间只允许一个关系请求，状态改变时丢弃过期结果。 */
export async function generateRelationshipUpdate(sessionId: string, kind: "reaction" | "remark"): Promise<boolean> {
    if (requests.has(sessionId)) throw new Error("请等待当前请求完成");
    const session = getRelationshipSession(sessionId);
    const snapshot = { ...session };
    if (kind === "reaction" && !snapshot.isBlacklisted) throw new Error("该联系人尚未被拉黑");
    const history = loadChatMessages(sessionId);
    const historyKey = getHistoryKey(history);
    const reactionKey = JSON.stringify([snapshot.blockedAt, historyKey, snapshot.characterRemark]);
    if (kind === "reaction" && snapshot.blockReactionKey === reactionKey) return false;

    const controller = new AbortController();
    requests.set(sessionId, controller);
    try {
        const { llmMessages, config, preset, character, userIdentity } = await buildChatPromptMessages(snapshot, history, { toolsAllowed: false });
        controller.signal.throwIfAborted();
        llmMessages.push({ role: "system", content: kind === "reaction" ? [
            "本次任务：模拟你尝试发消息后发现被用户拉黑的反应。根据角色性格、最近聊天和关系自然决定，可生气、解释、克制或不再联系，禁止强制挽留。",
            "下面的拦截消息用户仅在界面查看，剧情中你仍认为发送失败，用户没有回复；不要虚构用户的新言行。避免重复已有内容。",
            `此前的拦截消息：${JSON.stringify((snapshot.blockedInbox || []).slice(-12))}`,
            '只输出严格 JSON：{"messages":["一条消息","另一条消息"]}。0到4条，每条不超过500字；没有新动静时 messages 为 []。不要富媒体指令、工具、状态栏或其他文字。',
        ].join("\n") : [
            "本次任务：决定你现在在自己通讯录中给用户的备注。根据角色性格、最近聊天、当前情绪与双方关系判断；生气时允许负面备注，但不要无依据地突然改名。刷新不要求改名，合适就保持原备注。",
            `现有备注：${snapshot.characterRemark || "尚未设置"}`,
            `用户的备注风格要求：${snapshot.characterRemarkRules || "简短自然，符合角色性格"}`,
            '只输出严格 JSON：{"remark":"备注"}。备注为1到24个字。不要解释、工具、状态栏或其他文字。用户查看备注不会被你感知。',
        ].join("\n") });
        const raw = await sendLLMRequest(config, preset, llmMessages, [], {
            characterName: character.name, userName: userIdentity?.name,
        }, { skipOutputRegex: true, signal: controller.signal, debugSessionId: sessionId, appId: "chat" });
        controller.signal.throwIfAborted();
        const current = getRelationshipSession(sessionId);
        if (current.blockedAt !== snapshot.blockedAt || !!current.isBlacklisted !== !!snapshot.isBlacklisted ||
            current.characterRemarkRules !== snapshot.characterRemarkRules ||
            getHistoryKey(loadChatMessages(sessionId)) !== historyKey) {
            throw new Error("聊天或关系状态已变化，请重新刷新");
        }
        let value: { messages?: unknown; remark?: unknown };
        try {
            value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        } catch { throw new Error("角色返回的格式不正确，请重试"); }
        const now = new Date().toISOString();
        if (kind === "reaction") {
            if (!Array.isArray(value.messages) || value.messages.length > 4 ||
                value.messages.some(item => typeof item !== "string" || !item.trim() || item.length > 500)) {
                throw new Error("角色反应格式不正确，请重试");
            }
            const existing = new Set((current.blockedInbox || []).map(item => item.content));
            const contents = [...new Set(value.messages as string[])].filter(item => !existing.has(item));
            updateChatRelationship(sessionId, {
                blockReactionKey: reactionKey,
                blockedInbox: [...(current.blockedInbox || []), ...contents.map(content => ({
                    id: crypto.randomUUID(), content, createdAt: now,
                }))],
            });
            return contents.length > 0;
        }
        if (typeof value.remark !== "string" || !value.remark.trim() || [...value.remark.trim()].length > 24) {
            throw new Error("角色备注格式不正确，请重试");
        }
        const remark = value.remark.trim();
        const changed = remark !== current.characterRemark;
        updateChatRelationship(sessionId, {
            characterRemark: remark, characterRemarkUpdatedAt: now,
            characterRemarkHistory: remark === current.characterRemark ? current.characterRemarkHistory :
                [...(current.characterRemarkHistory || []), { remark, createdAt: now }].slice(-50),
        });
        return changed;
    } finally {
        if (requests.get(sessionId) === controller) requests.delete(sessionId);
    }
}
