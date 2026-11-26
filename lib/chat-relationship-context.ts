import type { ChatSession } from "./chat-storage";

/** 仅显式告知角色的原因可进入模型上下文。 */
export function buildChatRelationshipContext(session: ChatSession): string {
    if (session.isGroup || (!session.isBlacklisted && !session.blockedAt && !session.characterRemark)) return "";
    return [
        "【聊天关系状态】",
        session.isBlacklisted
            ? "用户已将你拉黑。你尝试发送消息时会发现发送失败；不要假装消息已送达。"
            : session.blockedAt ? "用户曾将你拉黑，目前已解除。按现有关系自然延续，不强制和好。" : "",
        session.isBlacklisted && session.shareBlockReason && session.blockReason
            ? `用户告知你的拉黑原因：${session.blockReason}` : "",
        session.characterRemark ? `你在通讯录中给用户的当前备注：${session.characterRemark}。这是你的私人备注，用户查看该功能不会让剧情中的你自动知晓。` : "",
    ].filter(Boolean).join("\n");
}
