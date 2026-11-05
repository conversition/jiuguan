import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchNsfwSceneSafety,
  NsfwSceneSafetyError,
  updateNsfwSceneSafety,
  type NsfwSceneSafetyReadModel,
} from './nsfwSceneSafetyClient.ts';

const INACTIVE_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'not-configured': '尚未为当前会话授权。',
  revoked: '授权已撤销。',
  'source-revision-mismatch': '世界书内容已变化，旧授权已自动失效；请检查后重新授权。',
  'worldbook-binding-mismatch': '授权的世界书已不在当前会话中，旧授权已自动失效。',
  'session-binding-mismatch': '授权不属于当前会话，已拒绝使用。',
});

export function NsfwSceneSafetyControl(props: {
  readonly sessionId: string;
  readonly contentMode: 'nsfw' | 'nsf';
}) {
  const [model, setModel] = useState<NsfwSceneSafetyReadModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [participantsConfirmed, setParticipantsConfirmed] = useState(false);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [selectedBooks, setSelectedBooks] = useState<readonly string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetchNsfwSceneSafety(props.sessionId, { signal: controller.signal })
      .then((next) => {
        setModel(next);
        // A disabled or revoked snapshot must never pre-check a new grant form — unless the
        // server supplied the device-level attestation pre-fill for a brand-new session. That
        // pre-fill carries the three statements only; worldbooks are intersected with what the
        // current session actually loaded, and enabling still requires the explicit POST.
        const active = next.safety.enabled;
        const inherited = next.inheritedAttestation;
        const inheritedBooks = inherited
          ? next.manifest.books.filter((book) => inherited.books.includes(book))
          : [];
        setAdultConfirmed(inherited ? true : active && next.safety.adultAttestation === 'verified');
        setParticipantsConfirmed(inherited ? true : active && next.safety.participantsAdult);
        setConsentConfirmed(inherited ? true : active && next.safety.consent === 'confirmed');
        setSelectedBooks(active ? next.safety.allowedWorldbooks : inheritedBooks);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string }).name !== 'AbortError') {
          setModel(null);
          setError(reason instanceof Error ? reason.message : '场景策展状态读取失败');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.sessionId, reloadKey]);

  // A grant can be revoked from another paired device/tab. Refresh when this
  // page becomes active again, while deduplicating focus + visibility events so
  // the admin rate group is not hit twice for one foreground transition.
  useEffect(() => {
    let lastRefreshAt = Date.now();
    const refresh = () => {
      const now = Date.now();
      if (now - lastRefreshAt < 1_000) return;
      lastRefreshAt = now;
      setReloadKey((value) => value + 1);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [props.sessionId]);

  const availableBooks = model?.manifest.books ?? [];
  const readyToEnable = props.contentMode === 'nsfw'
    && adultConfirmed && participantsConfirmed && consentConfirmed
    && selectedBooks.length > 0;
  const selection = useMemo(() => new Set(selectedBooks), [selectedBooks]);
  const hasStoredGrant = Boolean(model && model.safety.revision > 0
    && model.safety.adultAttestation === 'verified'
    && model.safety.participantsAdult
    && model.safety.consent === 'confirmed'
    && model.safety.allowedWorldbooks.length > 0);

  const applyServerModel = (next: NsfwSceneSafetyReadModel) => {
    setModel(next);
    const active = next.safety.enabled;
    setAdultConfirmed(active && next.safety.adultAttestation === 'verified');
    setParticipantsConfirmed(active && next.safety.participantsAdult);
    setConsentConfirmed(active && next.safety.consent === 'confirmed');
    setSelectedBooks(active ? next.safety.allowedWorldbooks : []);
  };

  const toggleBook = (book: string) => {
    setSelectedBooks((current) => current.includes(book)
      ? current.filter((item) => item !== book)
      : [...current, book]);
  };

  const enable = async () => {
    if (!model || !readyToEnable) return;
    if (typeof window !== 'undefined' && !window.confirm(
      `确认仅为当前会话启用成年场景策展？\n\n允许检索 ${selectedBooks.length} 本世界书。系统只选择标签和摘要，正文仍由主对话模型生成；你可以随时撤销。`,
    )) return;
    setPending(true);
    setError('');
    try {
      const next = await updateNsfwSceneSafety(props.sessionId, {
        adultAttestation: 'verified',
        participantsAdult: true,
        consent: 'confirmed',
        allowedWorldbooks: selectedBooks,
        expectedRevision: model.safety.revision,
      });
      applyServerModel(next);
    } catch (reason) {
      if (reason instanceof NsfwSceneSafetyError && reason.status === 409) {
        setReloadKey((value) => value + 1);
      }
      setError(reason instanceof Error ? reason.message : '场景策展启用失败');
    } finally {
      setPending(false);
    }
  };

  const revoke = async () => {
    if (!model || (!model.safety.enabled && !hasStoredGrant)) return;
    if (typeof window !== 'undefined' && !window.confirm(
      '确认撤销当前会话的成年场景策展授权？若当前正在生成，将同时停止该回合；之后不再检索或组合相关候选。',
    )) return;
    setPending(true);
    setError('');
    try {
      const next = await updateNsfwSceneSafety(props.sessionId, {
        adultAttestation: 'revoked',
        participantsAdult: false,
        consent: 'revoked',
        allowedWorldbooks: [],
        expectedRevision: model.safety.revision,
      });
      applyServerModel(next);
    } catch (reason) {
      if (reason instanceof NsfwSceneSafetyError && reason.status === 409) {
        setReloadKey((value) => value + 1);
      }
      setError(reason instanceof Error ? reason.message : '场景策展撤销失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="agent-status__controls nsfw-safety" data-testid="nsfw-scene-safety">
      <div className="nsfw-safety__heading">
        <h3>成年场景策展（当前会话）</h3>
        <strong data-enabled={model?.safety.enabled ? '1' : '0'}>
          {loading ? '读取中…' : model?.safety.enabled ? '已启用' : '未启用'}
        </strong>
      </div>
      <p className="agent-status__privacy">
        从你明确允许的本地世界书检索候选，受控组合少量标签后交给主模型；不会把世界书正文随机拼接，也不会联网抓取内容。
      </p>
      {props.contentMode === 'nsf' && (
        <p className="nsfw-safety__notice">当前是 NSF 纯净模式：策展器不会运行，也不能在此模式下新启用。</p>
      )}
      {!loading && model && !model.safety.enabled && !hasStoredGrant && (
        <p className="nsfw-safety__reason">
          {INACTIVE_REASON_LABELS[model.safety.reasonCode] ?? '当前授权不可用。'}
        </p>
      )}
      {error && <p className="agent-status__error">{error}</p>}
      {!loading && model && !model.safety.enabled && (
        <>
          {model.inheritedAttestation && (
            <small className="nsfw-safety__inherited">
              已按本机最近一次授权（{new Date(model.inheritedAttestation.confirmedAt).toLocaleString('zh-CN')}）预填三项声明；
              {model.inheritedAttestation.books.length > 0 ? '同名世界书已预选。' : ''}
              仍需你确认后点击启用，撤销会同步清除本机记忆。
            </small>
          )}
          <label className="nsfw-safety__attestation">
            <input type="checkbox" checked={adultConfirmed}
              onChange={(event) => setAdultConfirmed(event.target.checked)} />
            我确认自己已成年，并为当前会话启用成年内容策展
          </label>
          <label className="nsfw-safety__attestation">
            <input type="checkbox" checked={participantsConfirmed}
              onChange={(event) => setParticipantsConfirmed(event.target.checked)} />
            我确认当前场景中的所有参与人物均明确为成年人
          </label>
          <label className="nsfw-safety__attestation">
            <input type="checkbox" checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)} />
            我确认当前场景为自愿内容；撤销后必须立即停止策展
          </label>
          <fieldset className="nsfw-safety__books">
            <legend>允许检索的世界书（至少选择一本）</legend>
            <div className="nsfw-safety__book-actions">
              <button type="button" disabled={availableBooks.length === 0}
                onClick={() => setSelectedBooks([...availableBooks])}>全选可用世界书</button>
              <button type="button" disabled={selectedBooks.length === 0}
                onClick={() => setSelectedBooks([])}>清空</button>
            </div>
            {availableBooks.length === 0 ? (
              <small>当前会话没有可授权的世界书。</small>
            ) : availableBooks.map((book) => (
              <label key={book}>
                <input type="checkbox" checked={selection.has(book)} onChange={() => toggleBook(book)} />
                <span>{book}</span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="nsfw-safety__primary"
            disabled={pending || !readyToEnable} onClick={() => void enable()}>
            {pending ? '正在启用…' : '启用当前会话策展'}
          </button>
        </>
      )}
      {!loading && model && (model.safety.enabled || hasStoredGrant) && (
        <div className="nsfw-safety__active">
          <p>{model.safety.enabled
            ? `已授权 ${model.safety.allowedWorldbooks.length} 本世界书；授权只作用于本会话。`
            : `旧授权当前已失效（${INACTIVE_REASON_LABELS[model.safety.reasonCode] ?? '来源不再匹配'}），可在此彻底撤销。`}</p>
          <small>{model.safety.updatedAt ? `最近更新：${new Date(model.safety.updatedAt).toLocaleString('zh-CN')}` : ''}</small>
          <button type="button" className="danger" disabled={pending} onClick={() => void revoke()}>
            {pending ? '正在撤销…' : '撤销并立即停用'}
          </button>
        </div>
      )}
    </div>
  );
}
