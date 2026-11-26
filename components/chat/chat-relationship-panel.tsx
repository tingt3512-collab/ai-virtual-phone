"use client";

import { useEffect, useState } from "react";
import { CHAT_RELATIONSHIP_UPDATED_EVENT, loadChatSessions, updateChatRelationship, type ChatSession } from "@/lib/chat-storage";
import { generateRelationshipUpdate, setChatBlocked } from "@/lib/chat-relationship";

export function useChatRelationship(session: ChatSession): ChatSession {
    const [current, setCurrent] = useState(() => loadChatSessions().find(item => item.id === session.id) ?? session);
    useEffect(() => {
        const sync = (event?: Event) => {
            const detail = (event as CustomEvent<{ sessionId?: string }> | undefined)?.detail;
            if (detail?.sessionId && detail.sessionId !== session.id) return;
            setCurrent({ ...(loadChatSessions().find(item => item.id === session.id) ?? session) });
        };
        sync();
        window.addEventListener(CHAT_RELATIONSHIP_UPDATED_EVENT, sync);
        return () => window.removeEventListener(CHAT_RELATIONSHIP_UPDATED_EVENT, sync);
    }, [session]);
    return current;
}

export function ChatRelationshipPanel({ session }: { session: ChatSession }) {
    const current = useChatRelationship(session);
    const [reason, setReason] = useState(current.blockReason || "");
    const [shareReason, setShareReason] = useState(current.shareBlockReason || false);
    const [rules, setRules] = useState(current.characterRemarkRules || "");
    const [busy, setBusy] = useState<"reaction" | "remark" | null>(null);
    const [notice, setNotice] = useState("");
    const [confirmBlock, setConfirmBlock] = useState(false);
    const [showInbox, setShowInbox] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    if (session.isGroup) return null;

    const generate = async (kind: "reaction" | "remark") => {
        if (busy) return;
        setBusy(kind);
        setNotice("");
        try {
            if (kind === "remark") updateChatRelationship(session.id, { characterRemarkRules: rules.trim() });
            if (kind === "reaction") setShowInbox(true);
            const changed = await generateRelationshipUpdate(session.id, kind);
            setNotice(kind === "reaction" ? (changed ? "已接收新的反应，拉黑状态保持不变" : "暂时没有新的动静") : "备注已刷新，角色也可以保持原备注");
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "请求失败，请重试");
        } finally { setBusy(null); }
    };
    const toggleBlock = () => {
        try {
            setChatBlocked(session.id, !current.isBlacklisted, reason, shareReason);
            setConfirmBlock(false);
            setNotice(current.isBlacklisted ? "已解除拉黑" : "已拉黑，可点击接收查看他的反应");
        } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); }
    };
    const buttonClass = "rounded-xl border border-[var(--c-border)] px-3 py-2 text-sm disabled:opacity-50";
    const fieldClass = "w-full rounded-xl border border-[var(--c-border)] bg-transparent p-3 text-sm";
    return (
        <section className="menu-group p-4 space-y-4 text-[var(--c-text)]" aria-label="聊天关系">
            <div className="space-y-2">
                <h3 className="font-semibold">拉黑与拦截消息</h3>
                <p className="text-sm text-[var(--c-text-sub)]">{current.isBlacklisted ? "已拉黑。接收反应只供你查看，不会解除拉黑。" : "拉黑后暂停线上发言和普通回复，原有聊天记录保留。"}</p>
                {!current.isBlacklisted && <>
                    <textarea aria-label="拉黑原因" className={fieldClass} rows={2} maxLength={500} placeholder="拉黑原因（选填，默认仅自己记录）" value={reason} onChange={e => setReason(e.target.value)} />
                    <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={shareReason} onChange={e => setShareReason(e.target.checked)} />将原因告知角色</label>
                </>}
                <div className="flex flex-wrap gap-2">
                    <button type="button" className={buttonClass} onClick={() => current.isBlacklisted ? toggleBlock() : setConfirmBlock(true)}>{current.isBlacklisted ? "解除拉黑" : "拉黑此联系人"}</button>
                    {current.isBlacklisted && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void generate("reaction")}>{busy === "reaction" ? "正在接收…" : "接收他的反应"}</button>}
                    {!!current.blockedInbox?.length && <button type="button" className={buttonClass} onClick={() => setShowInbox(!showInbox)}>{showInbox ? "收起" : "查看"}拦截消息（{current.blockedInbox.length}）</button>}
                </div>
                {confirmBlock && <div role="alert" className="rounded-xl border border-[var(--c-border)] p-3 space-y-2">
                    <p className="text-sm">确定拉黑此联系人？之后可随时解除拉黑。</p>
                    <div className="flex gap-2"><button type="button" className={buttonClass} onClick={toggleBlock}>确定拉黑</button><button type="button" className={buttonClass} onClick={() => setConfirmBlock(false)}>取消</button></div>
                </div>}
                {showInbox && <div className="max-h-72 overflow-y-auto space-y-3 rounded-xl border border-[var(--c-border)] p-3" aria-label="拦截消息">
                    {!current.blockedInbox?.length && <p className="text-sm">暂时没有拦截消息</p>}
                    {current.blockedInbox?.map(item => <div key={item.id}><time className="text-xs text-[var(--c-text-sub)]">{new Date(item.createdAt).toLocaleString()}</time><p className="text-sm whitespace-pre-wrap break-words">{item.content}</p></div>)}
                </div>}
            </div>
            <div className="space-y-2 border-t border-[var(--c-border)] pt-4">
                <h3 className="font-semibold">他给我的备注</h3>
                <p className="text-lg break-words">{current.characterRemark || "尚未查看"}</p>
                {current.characterRemarkUpdatedAt && <p className="text-xs text-[var(--c-text-sub)]">最近刷新：{new Date(current.characterRemarkUpdatedAt).toLocaleString()}</p>}
                <textarea aria-label="备注自定义规则" className={fieldClass} rows={2} maxLength={1000} placeholder="自定义规则，例如：生气时可以改成不好的备注，不用表情，最多八个字" value={rules} onChange={e => setRules(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                    <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void generate("remark")}>{busy === "remark" ? "正在刷新…" : "刷新备注"}</button>
                    <button type="button" className={buttonClass} disabled={!!busy} onClick={() => { updateChatRelationship(session.id, { characterRemarkRules: rules.trim() }); setNotice("备注规则已保存"); }}>保存规则</button>
                    {!!current.characterRemarkHistory?.length && <button type="button" className={buttonClass} onClick={() => setShowHistory(!showHistory)}>{showHistory ? "收起" : "查看"}备注历史</button>}
                </div>
                <p className="text-xs text-[var(--c-text-sub)]">刷新会参考角色设定和聊天，可保持原备注。查看行为不会被角色感知。</p>
                {showHistory && <ul className="max-h-48 overflow-y-auto text-sm space-y-2">{[...(current.characterRemarkHistory || [])].reverse().map((item, index) => <li key={`${item.createdAt}-${index}`} className="break-words">{item.remark}<span className="ml-2 text-xs text-[var(--c-text-sub)]">{new Date(item.createdAt).toLocaleString()}</span></li>)}</ul>}
            </div>
            {notice && <p role="status" className="text-sm whitespace-pre-wrap break-words">{notice}</p>}
        </section>
    );
}
