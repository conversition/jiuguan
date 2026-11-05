/** @author Codex @date 2026-10-26 @version 1.0
 * A known-task read inspector, not a session task inventory or an execution control.
 */
import React, { useEffect, useState } from 'react';
import {
    createAgentLoopTaskReader,
    type AgentLoopTaskReader,
    type TaskStatusSnapshot,
} from './agentLoopTaskStatusClient.ts';
import { readTaskOutcome, type TaskOutcomeView } from './agentLoopTaskOutcomeClient.ts';

const STATE_LABELS: Record<string, string> = {
    CREATED: '已创建', RUNNING: '运行中', WAITING_INPUT: '等待输入', WAITING_APPROVAL: '等待审批',
    WAITING_EVENT: '等待事件', PAUSED: '已暂停', VERIFYING: '验证中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消',
};
const WAIT_CONDITIONS = {
    input: '等待匹配的用户输入和来源验证', approval: '等待匹配的审批结果和来源验证',
    event: '等待匹配的事件和来源验证', child: '等待子任务结果及合并验证', verification: '等待验证结果',
} as const;
const BLOCKER_LABELS = { 'child-failed': '子任务失败', 'child-cancelled': '子任务已取消',
    'child-artifact-conflict': '子任务产物存在冲突', other: '其他阻断（具体原因未公开）' } as const;

export interface AgentLoopTaskInspectorProps {
    readonly registerReader: (reader: AgentLoopTaskReader, canPoll: () => boolean) => () => void;
    readonly onReconnect: () => void;
}

export function AgentLoopTaskInspector(props: AgentLoopTaskInspectorProps) {
    const [input, setInput] = useState('');
    const [taskId, setTaskId] = useState('');
    const [inputError, setInputError] = useState('');
    const [snapshot, setSnapshot] = useState<TaskStatusSnapshot | null>(null);
    const [outcome, setOutcome] = useState<TaskOutcomeView | null>(null);
    const [outcomeError, setOutcomeError] = useState(false);
    const readerRef = React.useRef<AgentLoopTaskReader | null>(null);

    useEffect(() => {
        if (!taskId) return;
        let blocked = false;
        const reader = createAgentLoopTaskReader(taskId, (next) => {
            blocked = next.status === 'forbidden';
            setSnapshot(next);
        });
        readerRef.current = reader;
        const unregister = props.registerReader(reader, () => !blocked);
        void reader.refresh().catch(() => {
            /* The reader has already cleared stale data. */
        });
        return () => {
            unregister();
            reader.stop();
            if (readerRef.current === reader) readerRef.current = null;
        };
    }, [taskId, props.registerReader]);

    const currentRevision = snapshot?.status === 'current' && !snapshot.task?.fenced
        ? snapshot.task?.taskRevision : undefined;
    useEffect(() => {
        setOutcome(null); setOutcomeError(false);
        if (!taskId || currentRevision === undefined) return;
        const controller = new AbortController();
        let current = true;
        void readTaskOutcome(taskId, currentRevision, controller.signal).then(value => {
            if (current) setOutcome(value);
        }).catch(() => { if (current) setOutcomeError(true); });
        return () => { current = false; controller.abort(); };
    }, [taskId, currentRevision]);

    const query = (event: React.FormEvent) => {
        event.preventDefault();
        const next = input.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,239}$/u.test(next)) {
            setInputError('请输入有效任务 ID（最多 240 字符）');
            return;
        }
        setInputError('');
        props.onReconnect();
        if (next === taskId) {
            void readerRef.current?.refresh().catch(() => {
                /* State is reported by the reader. */
            });
        } else {
            // Revoke the old selection synchronously, before React's passive cleanup.
            readerRef.current?.stop();
            readerRef.current = null;
            setSnapshot(null);
            setTaskId(next);
        }
    };

    const task = snapshot?.status === 'current' ? snapshot.task : null;
    return (
        <details className="agent-status__task-inspector" data-testid="agent-loop-task-inspector">
            <summary>AgentLoop 任务 · 按 ID 只读查看</summary>
            <p className="agent-status__privacy">仅查看已知任务，不代表当前会话的任务总览，也不会启动或重试任务。</p>
            <form onSubmit={query}>
                <label>
                    任务 ID
                    <input
                        value={input}
                        maxLength={240}
                        onChange={(event) => setInput(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="AgentLoop 任务 ID"
                    />
                </label>
                <button type="submit">读取 / 刷新</button>
            </form>
            <div aria-live="polite">
                {inputError && <p className="agent-status__error">{inputError}</p>}
                {!snapshot && taskId && <p>正在读取任务…</p>}
                {snapshot?.status === 'loading' && <p>正在重读权威状态…</p>}
                {snapshot?.status === 'not-found' && <p>任务不存在或已移除。</p>}
                {snapshot?.status === 'forbidden' && <p>当前没有任务读取权限，旧状态已清除。</p>}
                {snapshot?.status === 'unavailable' && <p>状态暂不可用，旧状态已清除；可刷新重试。</p>}
                {task && (
                    <dl>
                        <dt>任务</dt>
                        <dd>{task.taskId}</dd>
                        <dt>版本</dt>
                        <dd>{task.taskRevision}</dd>
                        <dt>状态</dt>
                        <dd>{task.fenced ? '已围栏（不可执行）' : `${STATE_LABELS[task.state]}（${task.state}）`}</dd>
                        <dt>阶段</dt>
                        <dd>{task.phase}</dd>
                        <dt>围栏</dt>
                        <dd>{task.fenced ? '是' : '否'}</dd>
                        {!task.fenced && <>
                            <dt>等待与解除条件</dt>
                            <dd>{task.explanation.waitKind ? WAIT_CONDITIONS[task.explanation.waitKind]
                                : task.state === 'PAUSED' ? '等待显式恢复及来源验证'
                                : task.state === 'VERIFYING' ? '等待验证完成' : '当前投影未记录等待条件'}</dd>
                            {task.explanation.deadlineAt && <><dt>等待期限</dt><dd>{task.explanation.deadlineAt}</dd></>}
                            <dt>未解除阻断</dt><dd>{task.explanation.openBlockers} 项</dd>
                            {task.explanation.blockerReasons.length > 0 && <><dt>阻断原因</dt>
                                <dd>{task.explanation.blockerReasons.map(reason => BLOCKER_LABELS[reason]).join('；')}</dd></>}
                            <dt>阻断、产物与完成记录的证据引用</dt><dd>{task.explanation.evidenceCount} 项（数量不代表验证通过）</dd>
                            <dt>任务状态证据</dt><dd>{outcome ? `${({ completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '未知' } as const)[outcome.execution.state]} · ${outcome.execution.evidenceCount} 项引用（不代表模型调用）` : outcomeError ? '不可用或版本已变化，请刷新' : '读取中…'}</dd>
                            {outcome && <><dt>验证与业务提交</dt><dd>{outcome.verification.state === 'validated' ? '验证通过' : '验证未知'} ·
                                {({ committed: '已提交', 'rolled-back': '已回滚', unknown: '提交未知' } as const)[outcome.commit.state]}</dd></>}
                            <dt>当前回合触发情况</dt><dd>此任务视图无法关联到当前回合，请查看发布面板中的每轮准入决策。</dd>
                        </>}
                    </dl>
                )}
            </div>
        </details>
    );
}
